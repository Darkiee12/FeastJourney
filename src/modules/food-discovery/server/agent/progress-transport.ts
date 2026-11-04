import { Data, Effect, Fiber } from "effect";
import type * as PersistenceRateLimiter from "effect/persistence/RateLimiter";

import { recommendationQuerySchema } from "@/modules/food-discovery/food.schema";
import type { ProgressStage } from "@/modules/food-discovery/server/agent/protocol";
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
  RecommendationService,
  toWireOutcome,
} from "@/modules/food-discovery/server/operations/recommendation-service";
import type { IngredientRepository } from "@/modules/food-discovery/server/repository/ingredient-repository";
import { Actor } from "@/server/auth/actor";
import { withActor } from "@/server/auth/current-actor";
import { resolveSession } from "@/server/auth/session";
import { appConfig } from "@/server/config";
import type { Database } from "@/server/database/client";
import { RateLimitPolicy } from "@/server/http/rate-limit";
import { resolveIdentityFromHeaders, requestIdFromHeaders } from "@/server/http/request";
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
 * function receiving the validated input and a stage reporter. Until then
 * `deterministicPipeline` runs the existing RecommendationService so the
 * transport is end-to-end verifiable today.
 */

export type PipelineDeps = Database | IngredientRepository | RecommendationService | MetaClient;

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
) => Effect.Effect<RecommendationOutcome, RecommendationError, PipelineDeps>;

class InvalidJsonBody extends Data.TaggedError("InvalidJsonBody") {}

interface PreStreamRejection {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly retryAfterSeconds?: number | undefined;
}

/**
 * Agentic-mode flag name. Mirrors `RECOMMEND_AGENT_FLAG` from the
 * coordinator-owned `protocol.ts` WITHOUT importing its value: that module
 * currently uses `readonly` modifiers inside its `AGENT_BOUNDS` object
 * literal, which Bun's runtime transpiler rejects at load time (tsc accepts
 * it). The value import is restored once the coordinator fixes the contract
 * file; until then this literal keeps the transport testable. Do NOT change
 * this string without coordinator approval.
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
 * what actually ran. Lane B replaces this with the tool-using agent without
 * touching the guard/stream machinery.
 */
export const deterministicPipeline: StreamPipeline = (input, report) =>
  Effect.gen(function* () {
    report("searching-catalog", "Scanning eligible dishes");
    const service = yield* RecommendationService;
    const outcome = yield* service.recommend(input);
    report("finalizing", null);
    return outcome;
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
    if (!isAgentStreamEnabled(process.env as Record<string, string | undefined>)) {
      return yield* Effect.fail<PreStreamRejection>({
        status: 404,
        body: { error: "agent_disabled" },
      });
    }

    const raw = yield* Effect.tryPromise({
      try: () => request.json() as Promise<unknown>,
      catch: () => new InvalidJsonBody(),
    }).pipe(
      Effect.mapError(
        (): PreStreamRejection => ({ status: 400, body: { error: "invalid_input" } }),
      ),
    );

    const parsed = recommendationQuerySchema.safeParse(raw);
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
      Effect.mapError(
        (): PreStreamRejection => ({ status: 500, body: { error: "temporarily_unavailable" } }),
      ),
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
      Effect.catchTag(
        "UserSuspended",
        (): Effect.Effect<Actor, PreStreamRejection> =>
          Effect.fail<PreStreamRejection>({ status: 403, body: { error: "forbidden" } }),
      ),
      Effect.catchTag(
        "DatabaseUnavailable",
        (): Effect.Effect<Actor, PreStreamRejection> =>
          Effect.fail<PreStreamRejection>({ status: 503, body: { error: "temporarily_unavailable" } }),
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
        const maybeUnref = timer as unknown as { unref?: () => void };
        // Heartbeats must never hold the process open (tests, idle workers).
        if (typeof maybeUnref.unref === "function") {
          maybeUnref.unref();
        }
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
        return yield* pipeline(input, (stage, detail) => {
          enqueue(emitter.stage(stage, detail));
        });
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
            if (exit._tag === "Success") {
              const outcome = exit.value;
              const terminal = RecommendationOutcome.$match(outcome, {
                ReadyMuse: () => emitter.terminal("completed", "Recommendations ready"),
                ReadyDeterministic: ({ ranking }) =>
                  emitter.terminal(
                    ranking._tag === "DegradedMuse" ? "degraded" : "completed",
                    ranking._tag === "DegradedMuse"
                      ? "AI ranking degraded; showing catalog order"
                      : "Recommendations ready",
                  ),
                Uncertain: () => emitter.terminal("completed", "Recommendations ready"),
                Empty: () => emitter.terminal("completed", "Recommendations ready"),
              });
              enqueue(terminal);
              if (terminal !== null) {
                enqueue(encodeResultEvent(requestId, toWireOutcome(outcome)));
              }
            } else {
              // Timeout, interruption, or typed pipeline failure: one failed
              // terminal plus an error event, never a silent hang.
              failTerminal("unavailable", "Recommendation stream failed");
            }
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
