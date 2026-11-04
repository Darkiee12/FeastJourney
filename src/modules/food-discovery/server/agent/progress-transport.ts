import { clearInterval, setInterval } from "node:timers";

import { Data, Effect, Exit, Fiber, Option } from "effect";
import type * as PersistenceRateLimiter from "effect/persistence/RateLimiter";

import { recommendationQuerySchema } from "@/modules/food-discovery/food.schema";
import type { ResolvedAgentBounds } from "@/modules/food-discovery/server/agent/bounds";
import {
  AgentRunOutcome,
  runAgentLoop,
  toDegradedCause,
} from "@/modules/food-discovery/server/agent/orchestrator";
import {
  resolveAgentBounds,
  type ProgressStage,
} from "@/modules/food-discovery/server/agent/protocol";
import {
  ProgressEmitter,
  streamResponseHeaders,
  encodeErrorEvent,
  encodeResultEvent,
  HEARTBEAT_COMMENT,
  type StreamErrorCode,
} from "@/modules/food-discovery/server/agent/stream-codec";
import {
  type RecommendDishesInput,
  RecommendationOutcome,
  type RecommendationError,
  RecommendationMisconfigured,
  RecommendationService,
  RankingProvenance,
  hydrateAgentFallback,
  hydrateAgentSelected,
  resolveAgentPool,
  toWireOutcome,
} from "@/modules/food-discovery/server/operations/recommendation-service";
import type { DishRelationsRepository } from "@/modules/food-discovery/server/repository/dish-relations-repository";
import type { IngredientRepository } from "@/modules/food-discovery/server/repository/ingredient-repository";
import { Actor } from "@/server/auth/actor";
import { CurrentActor, withActor } from "@/server/auth/current-actor";
import { resolveSession } from "@/server/auth/session";
import { appConfig } from "@/server/config";
import type { Database } from "@/server/database/client";
import { describeCause } from "@/server/database/errors";
import { RankingConfig, resolveRankingConfig, serverEnv } from "@/server/env";
import { RateLimitPolicy } from "@/server/http/rate-limit";
import { resolveIdentityFromHeaders, requestIdFromHeaders } from "@/server/http/request";
import { agentConfigFromMuse, makeAgentModelClientLive } from "@/server/integrations/meta-agent";
import type { MetaClient } from "@/server/integrations/meta-client";
import { withRequestTimeout } from "@/server/runtime";

/**
 * Streaming progress transport for agentic recommendations (workstream D).
 *
 * Decision (SSE over POST + fetch/ReadableStream; see
 * docs/architecture/recommendations-agent-transport.md): EventSource cannot
 * POST bodies, so the client streams with `fetch` and parses SSE frames
 * incrementally. POST keeps the rich location/exclusion payload out of URLs
 * and logs. The existing `recommendDishesFn` JSON contract is untouched —
 * this is an additive endpoint gated by RECOMMEND_AGENT_ENABLED.
 *
 * Guard order (all BEFORE expensive work and before the first stream byte):
 * agent flag → JSON body validation → rate-limit budget → session identity.
 * Pre-stream failures return plain JSON (400/404/429/403/503) with the same
 * semantics as the non-streaming path. Post-stream failures emit one
 * terminal `failed` progress event plus an `error` event, then close.
 *
 * Lane B plugs the real tool-using agent here via `StreamPipeline`: a
 * function receiving the validated input and a stage reporter. `agentPipeline`
 * runs the bounded orchestrator loop (`runAgentLoop`) with a per-request
 * AgentModelClient; `deterministicPipeline` runs the existing
 * RecommendationService so the transport stays verifiable with the flag off.
 */

export type PipelineDeps =
  | Database
  | IngredientRepository
  | RecommendationService
  | MetaClient
  | DishRelationsRepository;

export type RecommendationStreamDeps =
  | PipelineDeps
  | RateLimitPolicy
  | PersistenceRateLimiter.RateLimiter;

/** Stage reporter handed to the pipeline. Detail is human-safe only. */
export type StageReporter = (
  stage: Exclude<ProgressStage, "completed" | "degraded" | "failed">,
  detail: string | null,
) => void;

export type StreamPipeline = (
  input: RecommendDishesInput,
  report: StageReporter,
  requestId?: string,
) => Effect.Effect<RecommendationOutcome, RecommendationError, PipelineDeps>;

class InvalidJsonBody extends Data.TaggedError("InvalidJsonBody") {}

interface PreStreamRejection {
  readonly status: number;
  readonly body: {
    readonly error: string;
    readonly message?: string;
    readonly retryAfterSeconds?: number;
  };
  readonly retryAfterSeconds?: number | undefined;
}

/**
 * Keep the disabled-path guard independent of protocol.ts value imports:
 * that module currently resolves all agent bounds eagerly at import time.
 * The guard must be able to reject disabled requests without requiring
 * configuration for a feature that will not run.
 */
const RECOMMEND_AGENT_FLAG = "RECOMMEND_AGENT_ENABLED";

/** Pure flag parse so tests never touch process.env through the handler. */
export const isAgentStreamEnabled = (env: Record<string, string | undefined>): boolean => {
  const raw = env[RECOMMEND_AGENT_FLAG]?.trim().toLowerCase();

  return raw === "1" || raw === "true" || raw === "yes";
};

/**
 * Canonical-first exclusion merge (legacy avoid/allergies appended,
 * exact-dedupe preserving first occurrence). Mirrors recommendDishesFn so
 * both transports resolve identical filter sets for identical payloads.
 */
export const mergeExcludedIngredients = (data: {
  readonly excludedIngredients: ReadonlyArray<string>;
  readonly avoid: ReadonlyArray<string>;
  readonly allergies: ReadonlyArray<string>;
}): Array<string> => {
  const seen = new Set<string>();
  const merged: Array<string> = [];

  for (const term of [...data.excludedIngredients, ...data.avoid, ...data.allergies]) {
    if (!seen.has(term)) {
      seen.add(term);
      merged.push(term);
    }
  }

  return merged;
};

/**
 * Default pipeline: the existing bounded RecommendationService with stage
 * reports around its real phases. Emits `searching-catalog` before SQL +
 * ranking and `finalizing` around hydration, so progress is honest about
 * what actually ran. It is also the fallback every agent precondition
 * delegates to (flag off, guest, surprise slice, deterministic provider
 * config, empty pool), so the flag-off path stays byte-identical.
 */
export const deterministicPipeline: StreamPipeline = (input, report) =>
  Effect.gen(function* () {
    report("searching-catalog", "Scanning eligible dishes");
    const service = yield* RecommendationService;
    const outcome = yield* service.recommend(input);
    report("finalizing", null);

    return outcome;
  });

/**
 * Production agent pipeline: the tool-using loop behind the stream transport.
 *
 * Resolution order inside one Effect, so every synchronous throw maps to
 * loud RecommendationMisconfigured instead of escaping as a defect: agent
 * flag (off delegates to deterministicPipeline), protocol bounds from
 * process.env, ranking config (must be the Muse variant — Deterministic
 * delegates to deterministicPipeline, Misconfigured fails closed), then
 * MetaAgentConfig via agentConfigFromMuse. Guests and surprise slices also
 * delegate to deterministicPipeline: guests never spend model budget and
 * surprise stays a deterministic pool slice by contract. An empty or
 * malformed pool delegates too (honest Empty, no model spend).
 *
 * The AgentModelClient layer is built per request from the resolved Muse
 * config and provided locally to runAgentLoop; ambient repositories come
 * from the surrounding runtime, and per-request identity still travels via
 * CurrentActor. The StageReporter forwards non-terminal orchestrator stages
 * to the transport emitter; terminal events stay owned by the transport so
 * the exactly-one-terminal invariant holds.
 */
export const agentPipeline: StreamPipeline = (input, report, requestId) =>
  Effect.gen(function* () {
    if (!isAgentStreamEnabled(process.env)) {
      return yield* deterministicPipeline(input, report);
    }

    const current = yield* Effect.serviceOption(CurrentActor);

    const isGuest =
      Option.isNone(current) ||
      Actor.$match(current.value, {
        Guest: () => true,
        Member: () => false,
      });

    if (isGuest || input.surpriseSeed > 0) {
      return yield* deterministicPipeline(input, report);
    }

    const bounds = yield* Effect.try({
      try: () => resolveAgentBounds(process.env),
      catch: (cause) => new RecommendationMisconfigured({ reason: describeCause(cause) }),
    });

    // Mechanics derived exactly as resolveAgentBounds in bounds.ts; the
    // single validated env parse above stays the only config source.
    const resolvedBounds: ResolvedAgentBounds = {
      ...bounds,
      maxToolCallsPerRound: Math.ceil(bounds.maxToolCalls / bounds.maxRounds),
      toolPageLimit: bounds.finalLimit,
      initialOverviewLimit: bounds.finalLimit,
    };

    const ranking = yield* Effect.try({
      try: () => resolveRankingConfig(serverEnv()),
      catch: (cause) => new RecommendationMisconfigured({ reason: describeCause(cause) }),
    });

    return yield* RankingConfig.$match(ranking, {
      Deterministic: () => deterministicPipeline(input, report),
      Misconfigured: ({ reason }) =>
        Effect.logError("Recommendation ranking misconfigured").pipe(
          Effect.annotateLogs({ backend: "muse", reason }),
          Effect.andThen(Effect.fail(new RecommendationMisconfigured({ reason }))),
        ),
      Muse: (muse) =>
        Effect.gen(function* () {
          const agentConfig = yield* Effect.try({
            try: () => agentConfigFromMuse(muse, serverEnv()),
            catch: (cause) => new RecommendationMisconfigured({ reason: describeCause(cause) }),
          });

          const snapshot = yield* resolveAgentPool(input, resolvedBounds.candidatePoolCap);

          if (snapshot === null) {
            return yield* deterministicPipeline(input, report);
          }

          const outcome = yield* runAgentLoop({
            pool: snapshot.pool,
            eligibility: snapshot.eligibility,
            mood: input.mood,
            occasion: input.meal,
            requestId: requestId ?? crypto.randomUUID(),
            outputLimit: muse.outputLimit,
            bounds: resolvedBounds,
            emitProgress: (event) => {
              if (
                event.stage === "completed" ||
                event.stage === "degraded" ||
                event.stage === "failed"
              ) {
                return Effect.void;
              }

              // Narrowed copies: the guard above removes terminal stages, but
              // narrowing does not cross the Effect.sync closure boundary.
              const stage = event.stage;
              const detail = event.detail;

              return Effect.sync(() => {
                report(stage, detail);
              });
            },
          }).pipe(Effect.provide(makeAgentModelClientLive(agentConfig)));

          return yield* AgentRunOutcome.$match(outcome, {
            Selected: ({ ids, reasons }) => hydrateAgentSelected(snapshot, ids, reasons),
            DeterministicFallback: ({ ids, cause, warning }) =>
              hydrateAgentFallback(snapshot, ids, toDegradedCause(cause), warning),
          });
        }),
    });
  });

const jsonError = (requestId: string, rejection: PreStreamRejection): Response => {
  const response = Response.json(rejection.body, {
    status: rejection.status,
    headers: { "content-type": "application/json; charset=utf-8", "X-Request-Id": requestId },
  });

  if (rejection.retryAfterSeconds !== undefined) {
    response.headers.set("Retry-After", String(rejection.retryAfterSeconds));
  }

  return response;
};

type RateVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "limited"; readonly retryAfterSeconds: number }
  | { readonly kind: "unavailable" };

/**
 * Guard chain: flag → body validation → rate limit → session. Resolves the
 * validated input plus actor, or fails with a JSON rejection that must be
 * sent instead of opening the stream. No database or model work happens
 * before these pass (rate-limit identity derivation is header/config-only;
 * the session lookup is the only I/O and it gates member-vs-guest ranking).
 */
const guardRequest = (
  request: Request,
): Effect.Effect<
  { readonly actor: Actor; readonly input: RecommendDishesInput; readonly timeoutMs: number },
  PreStreamRejection,
  RateLimitPolicy | PersistenceRateLimiter.RateLimiter
> =>
  Effect.gen(function* () {
    if (!isAgentStreamEnabled(process.env)) {
      return yield* Effect.fail<PreStreamRejection>({
        status: 404,
        body: { error: "agent_disabled" },
      });
    }

    const parsed = yield* Effect.tryPromise({
      try: async () => recommendationQuerySchema.safeParse(await request.json()),
      catch: () => new InvalidJsonBody(),
    }).pipe(
      Effect.mapError((): PreStreamRejection => ({
        status: 400,
        body: { error: "invalid_input" },
      })),
    );

    if (!parsed.success) {
      return yield* Effect.fail<PreStreamRejection>({
        status: 400,
        body: {
          error: "invalid_input",
          message: parsed.error.issues[0]?.message ?? "Invalid recommendation request.",
        },
      });
    }

    const config = yield* appConfig.pipe(
      Effect.mapError((): PreStreamRejection => ({
        status: 500,
        body: { error: "temporarily_unavailable" },
      })),
    );

    const policy = yield* RateLimitPolicy;

    const verdict: RateVerdict = yield* policy
      .check("search", resolveIdentityFromHeaders(request.headers, config))
      .pipe(
        Effect.as<RateVerdict>({ kind: "ok" }),
        Effect.catchTag("RateLimitExceeded", (failure) =>
          Effect.succeed<RateVerdict>({
            kind: "limited",
            retryAfterSeconds: failure.retryAfterSeconds,
          }),
        ),
        Effect.catchTag("StoreUnavailable", () =>
          Effect.succeed<RateVerdict>({ kind: "unavailable" }),
        ),
      );

    if (verdict.kind === "limited") {
      return yield* Effect.fail<PreStreamRejection>({
        status: 429,
        body: { error: "rate_limited", retryAfterSeconds: verdict.retryAfterSeconds },
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
    }

    if (verdict.kind === "unavailable") {
      return yield* Effect.fail<PreStreamRejection>({
        status: 503,
        body: { error: "temporarily_unavailable" },
      });
    }

    const actor: Actor = yield* resolveSession(request.headers).pipe(
      Effect.map((trusted): Actor => Actor.Member({ userId: trusted.userId })),
      Effect.catchTag("SignInRequired", () => Effect.succeed<Actor>(Actor.Guest())),
      Effect.catchTag("UserSuspended", (): Effect.Effect<Actor, PreStreamRejection> =>
        Effect.fail<PreStreamRejection>({ status: 403, body: { error: "forbidden" } }),
      ),
      Effect.catchTag("DatabaseUnavailable", (): Effect.Effect<Actor, PreStreamRejection> =>
        Effect.fail<PreStreamRejection>({
          status: 503,
          body: { error: "temporarily_unavailable" },
        }),
      ),
    );

    const data = parsed.data;

    return {
      actor,
      input: {
        meal: data.meal,
        excludedIngredients: mergeExcludedIngredients(data),
        cuisine: data.cuisine,
        country: data.country,
        location: data.location,
        mood: data.mood,
        locale: data.locale,
        surpriseSeed: data.surpriseSeed,
      },
      // Operation budget: SQL + ranking. Mirrors recommendDishesFn
      // (RECOMMEND_TIMEOUT_MS, default 120s); must stay above
      // MODEL_TIMEOUT_MS or the provider call can never complete.
      timeoutMs: config.recommendTimeoutMs ?? 120000,
    };
  });

/**
 * Build the SSE response and fork the pipeline as daemon fibers. The handler
 * returns the Response immediately; a worker fiber runs the pipeline while
 * a supervisor fiber settles the stream (terminal progress event, then
 * result-or-error event, then close) so consumers can never hang waiting
 * for a terminal frame. Client disconnect (`request.signal`) interrupts the
 * worker: no orphaned provider calls, no writes to a dead stream.
 */
const streamOutcome = (
  request: Request,
  requestId: string,
  actor: Actor,
  input: RecommendDishesInput,
  pipeline: StreamPipeline,
  timeoutMs: number,
): Effect.Effect<Response, never, PipelineDeps> =>
  Effect.gen(function* () {
    const emitter = new ProgressEmitter(requestId);

    let timer: ReturnType<typeof setInterval> | undefined;
    let live: ReadableStreamDefaultController<string> | null = null;

    const enqueue = (chunk: string | null): void => {
      if (chunk === null || live === null) {
        return;
      }

      try {
        live.enqueue(chunk);
      } catch {
        // Client went away mid-write: the abort listener interrupts the
        // worker; a throw here would only mask the real failure.
      }
    };

    const failTerminal = (code: StreamErrorCode, detail: string): void => {
      enqueue(emitter.terminal("failed", detail));
      enqueue(encodeErrorEvent(requestId, code));
    };

    const closeStream = (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }

      if (live !== null) {
        try {
          live.close();
        } catch {
          // Already closed by disconnect; nothing left to do.
        }

        live = null;
      }
    };

    const stream = new ReadableStream<string>({
      start(controller) {
        live = controller;
        timer = setInterval(() => {
          enqueue(HEARTBEAT_COMMENT);
        }, 15000);
        // Heartbeats must never hold the process open (tests, idle workers).
        timer.unref();
      },
      cancel() {
        if (timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }

        live = null;
      },
    });

    const run = withActor(
      actor,
      Effect.gen(function* () {
        enqueue(emitter.stage("preparing", null));

        return yield* pipeline(
          input,
          (stage, detail) => {
            enqueue(emitter.stage(stage, detail));
          },
          requestId,
        );
      }).pipe((effect) => withRequestTimeout(effect, "recommend/stream", timeoutMs)),
    );

    // Worker + supervisor are detached fibers: they outlive the request-scoped
    // handler Effect (which returns the Response below) and are reaped by
    // runtime disposal. Fiber.interrupt needs no environment, so the plain
    // abort listener can drive cancellation via top-level runFork.
    const worker = yield* Effect.forkDetach(run);
    yield* Effect.sync(() => {
      request.signal.addEventListener(
        "abort",
        () => {
          Effect.runFork(Fiber.interrupt(worker));
        },
        { once: true },
      );

      if (request.signal.aborted) {
        Effect.runFork(Fiber.interrupt(worker));
      }
    });
    yield* Effect.forkDetach(
      Fiber.await(worker).pipe(
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            Exit.match(exit, {
              onSuccess: (outcome) => {
                const terminal = RecommendationOutcome.$match(outcome, {
                  ReadyMuse: () => emitter.terminal("completed", "Recommendations ready"),
                  ReadyDeterministic: ({ ranking }) =>
                    RankingProvenance.$match(ranking, {
                      LiveMuse: () => emitter.terminal("completed", "Recommendations ready"),
                      DeterministicCatalog: () =>
                        emitter.terminal("completed", "Recommendations ready"),
                      DegradedMuse: () =>
                        emitter.terminal("degraded", "AI ranking degraded; showing catalog order"),
                    }),
                  Uncertain: () => emitter.terminal("completed", "Recommendations ready"),
                  Empty: () => emitter.terminal("completed", "Recommendations ready"),
                });

                enqueue(terminal);

                if (terminal !== null) {
                  enqueue(encodeResultEvent(requestId, toWireOutcome(outcome)));
                }
              },
              // Timeout, interruption, or typed pipeline failure: one failed
              // terminal plus an error event, never a silent hang.
              onFailure: () => failTerminal("unavailable", "Recommendation stream failed"),
            });

            closeStream();
          }),
        ),
      ),
    );

    return new Response(stream, { status: 200, headers: streamResponseHeaders(requestId) });
  });

/**
 * POST /api/v1/recommendations/stream handler. Guards run first and every
 * rejection returns JSON before the first stream byte; only then is the SSE
 * response built and the pipeline forked.
 */
export const handleRecommendStream = (
  request: Request,
  pipeline: StreamPipeline = deterministicPipeline,
): Effect.Effect<Response, never, RecommendationStreamDeps> =>
  Effect.gen(function* () {
    const requestId = requestIdFromHeaders(request.headers);

    const guarded = yield* guardRequest(request).pipe(
      Effect.mapError((rejection) => jsonError(requestId, rejection)),
    );

    return yield* streamOutcome(
      request,
      requestId,
      guarded.actor,
      guarded.input,
      pipeline,
      guarded.timeoutMs,
    );
  }).pipe(
    // The only failure channel here is the mapped JSON Response above;
    // settle it so the handler itself never fails (v4 has no catchAll).
    Effect.matchEffect({
      onFailure: (response: Response) => Effect.succeed(response),
      onSuccess: (response: Response) => Effect.succeed(response),
    }),
  );
