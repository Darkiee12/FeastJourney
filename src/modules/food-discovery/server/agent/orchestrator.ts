import { Data, Duration, Effect } from "effect";

import type { ResolvedAgentBounds } from "@/modules/food-discovery/server/agent/bounds";
import { resolveAgentBounds } from "@/modules/food-discovery/server/agent/bounds";
import {
  DetailsToolOutcome,
  fetchDishDetails,
  searchEligiblePool,
  summarizeCandidate,
} from "@/modules/food-discovery/server/agent/catalog-tools";
import type { AgentEligibility } from "@/modules/food-discovery/server/agent/eligibility";
import { AgentTimeout } from "@/modules/food-discovery/server/agent/errors";
import {
  AGENT_TOOL_DEFINITIONS,
  AgentModelClient,
  AgentTranscriptEntry,
  AgentTurnOutput,
  buildAgentSystemPrompt,
  buildAgentUserBlock,
  parseFinalSelection,
  type AgentToolCall,
  type AgentTranscriptEntry as TranscriptEntry,
  type AgentTranscriptToolResult,
} from "@/modules/food-discovery/server/agent/model-client";
import type { ProgressEvent, ProgressStage } from "@/modules/food-discovery/server/agent/protocol";
import { validateAgentFinalSelection } from "@/modules/food-discovery/server/agent/validation";
import type { RecommendationCandidateRow } from "@/modules/food-discovery/server/operations/recommendation-service";
import { type DishRelationsRepository } from "@/modules/food-discovery/server/repository/dish-relations-repository";
import { type IngredientRepository } from "@/modules/food-discovery/server/repository/ingredient-repository";
import { type PlaceRepository } from "@/modules/food-discovery/server/repository/place-repository";
import type { MetaAuthError, MetaPermanentError } from "@/server/integrations/meta-client";

/**
 * Backend workstream A — the bounded agent orchestration loop.
 *
 * Mechanical bounds enforced here (never by prompt goodwill):
 * - maxRounds model turns, maxToolCalls total, maxToolCallsPerRound slice.
 * - Per-turn provider timeout and a total orchestration deadline.
 * - detailsPerCall / toolPageLimit / candidatePoolCap / finalLimit.
 *
 * Deliberate finalization policy: any loop failure (timeout, budget
 * exhaustion, malformed turn/call, invalid final) ends in a deterministic
 * fallback over the pool head (pool order is the deterministic SQL order).
 * The loop never reprompts a malformed model response and never emits a
 * partial selection. Auth/config failures stay loud typed errors.
 *
 * Trace correlation: the caller passes the real request UUID (created at
 * the transport edge); every log line in this loop carries it. The legacy
 * `"server-fn"` literal must not reach here (see report: coordinator fix).
 */

export type AgentFallbackCause =
  | "rate-limited"
  | "transient"
  | "invalid-output"
  | "budget-exhausted"
  | "timeout";

export type AgentRunOutcome = Data.TaggedEnum<{
  Selected: {
    readonly ids: ReadonlyArray<string>;
    readonly reasons: ReadonlyArray<string>;
  };
  DeterministicFallback: {
    readonly ids: ReadonlyArray<string>;
    readonly cause: AgentFallbackCause;
    readonly warning: string;
  };
}>;

export const AgentRunOutcome = Data.taggedEnum<AgentRunOutcome>();

const RATE_LIMITED_WARNING = "AI curation was rate-limited; used deterministic order instead.";

const TRANSIENT_WARNING = "AI curation was unavailable; used deterministic order instead.";

const INVALID_OUTPUT_WARNING =
  "AI curation produced an unusable selection; used deterministic order instead.";

const BUDGET_WARNING =
  "AI curation ran out of exploration budget; used deterministic order instead.";

const TIMEOUT_WARNING = "AI curation timed out; used deterministic order instead.";

export interface AgentProgressSink {
  (event: ProgressEvent): Effect.Effect<void>;
}

export interface AgentRunInput {
  /** Already-eligible pool in deterministic SQL order (scope/exclusions applied). */
  readonly pool: ReadonlyArray<RecommendationCandidateRow>;
  readonly eligibility: AgentEligibility;
  readonly mood: string;
  readonly occasion: string;
  /** Real request UUID from the transport edge — never "server-fn". */
  readonly requestId: string;
  readonly outputLimit?: number | undefined;
  readonly bounds?: ResolvedAgentBounds | undefined;
  /** Progress transport (workstream C). Never fails: sinks handle errors internally. */
  readonly emitProgress?: AgentProgressSink | undefined;
}

export type AgentRunEnv =
  | AgentModelClient
  | DishRelationsRepository
  | IngredientRepository
  | PlaceRepository;

export type AgentRunError = MetaAuthError | MetaPermanentError;

const headIds = (
  pool: ReadonlyArray<RecommendationCandidateRow>,
  outputLimit: number,
): Array<string> => pool.slice(0, outputLimit).map((row) => row.id);

export const runAgentLoop = (
  input: AgentRunInput,
): Effect.Effect<AgentRunOutcome, AgentRunError, AgentRunEnv> => {
  const bounds = input.bounds ?? resolveAgentBounds();
  const outputLimit = Math.min(input.outputLimit ?? bounds.finalLimit, bounds.finalLimit);
  const pool = input.pool.slice(0, bounds.candidatePoolCap);

  return Effect.gen(function* () {
    let seq = 0;

    const emit = (stage: ProgressStage, detail: string | null, terminal: boolean) => {
      const sink = input.emitProgress;

      if (sink === undefined) {
        return Effect.void;
      }

      seq += 1;

      return sink({ detail, requestId: input.requestId, seq, stage, terminal });
    };

    const fallback = (
      cause: AgentFallbackCause,
      warning: string,
    ): Effect.Effect<AgentRunOutcome, never> =>
      emit("degraded", warning, true).pipe(
        Effect.andThen(
          Effect.succeed(
            AgentRunOutcome.DeterministicFallback({
              cause,
              ids: headIds(pool, outputLimit),
              warning,
            }),
          ),
        ),
      );

    yield* emit("preparing", "Finding dishes that match your picks.", false);

    if (pool.length === 0) {
      return yield* fallback("transient", TRANSIENT_WARNING);
    }

    yield* Effect.logInfo("Agent recommendation started").pipe(
      Effect.annotateLogs({
        operation: "agent/recommend",
        requestId: input.requestId,
        scope: input.eligibility.scope,
        poolSize: pool.length,
        exclusionCount: input.eligibility.excludedIds.length,
      }),
    );

    const overview = pool.slice(0, bounds.initialOverviewLimit).map(summarizeCandidate);
    const servedIds = new Set<string>(overview.map((dish) => dish.id));

    const servedRows = (): Array<RecommendationCandidateRow> =>
      pool.filter((row) => servedIds.has(row.id));

    const transcript: Array<TranscriptEntry> = [
      AgentTranscriptEntry.User({
        text: buildAgentUserBlock({
          eligibility: input.eligibility,
          mood: input.mood,
          occasion: input.occasion,
          overview,
        }),
      }),
    ];

    const systemPrompt = buildAgentSystemPrompt();
    let toolCallsUsed = 0;

    const runOneTurn = () =>
      Effect.flatMap(AgentModelClient, (client) =>
        client.runTurn({
          systemPrompt,
          tools: [...AGENT_TOOL_DEFINITIONS],
          transcript: [...transcript],
        }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(bounds.providerTimeoutMs),
          orElse: () =>
            Effect.fail(
              new AgentTimeout({ operation: "agent/runTurn", timeoutMs: bounds.providerTimeoutMs }),
            ),
        }),
      );

    const executeCalls = (
      calls: ReadonlyArray<AgentToolCall>,
    ): Effect.Effect<Array<AgentTranscriptToolResult>, never, AgentRunEnv> =>
      Effect.gen(function* () {
        const results: Array<AgentTranscriptToolResult> = [];
        let inspecting = false;
        let searching = false;

        for (const call of calls) {
          const toolName: string = call.name;

          if (toolName === "searchDishes") {
            searching = true;

            const outcome = searchEligiblePool(
              pool,
              input.eligibility,
              call.args,
              bounds.toolPageLimit,
            );

            if (outcome._tag === "Rejected") {
              results.push({
                name: "searchDishes",
                ok: false,
                payload: outcome.message,
                toolCallId: call.id,
              });
            } else {
              for (const id of outcome.servedIds) {
                servedIds.add(id);
              }

              results.push({
                name: "searchDishes",
                ok: true,
                payload: outcome.result,
                toolCallId: call.id,
              });
            }
          } else if (toolName === "getDishDetails") {
            inspecting = true;

            const outcome = yield* fetchDishDetails({
              detailsPerCall: bounds.detailsPerCall,
              eligibility: input.eligibility,
              pool,
              rawArgs: call.args,
            }).pipe(
              Effect.catchTag("DatabaseUnavailable", (error) =>
                Effect.succeed(
                  DetailsToolOutcome.Rejected({
                    message: `Catalog details unavailable (${error._tag}).`,
                  }),
                ),
              ),
              Effect.catchTag("PersistenceError", () =>
                Effect.succeed(
                  DetailsToolOutcome.Rejected({ message: "Catalog details unavailable." }),
                ),
              ),
              Effect.catchTag("PersistenceConflict", () =>
                Effect.succeed(
                  DetailsToolOutcome.Rejected({ message: "Catalog details unavailable." }),
                ),
              ),
              Effect.catchTag("TransactionConflict", () =>
                Effect.succeed(
                  DetailsToolOutcome.Rejected({ message: "Catalog details unavailable." }),
                ),
              ),
            );

            if (outcome._tag === "Rejected") {
              results.push({
                name: "getDishDetails",
                ok: false,
                payload: outcome.message,
                toolCallId: call.id,
              });
            } else {
              for (const id of outcome.servedIds) {
                servedIds.add(id);
              }

              if (outcome.omittedIds.length > 0) {
                yield* Effect.logWarning("Agent details omitted unknown ids").pipe(
                  Effect.annotateLogs({
                    operation: "agent/getDishDetails",
                    requestId: input.requestId,
                    omittedCount: outcome.omittedIds.length,
                  }),
                );
              }

              results.push({
                name: "getDishDetails",
                ok: true,
                payload: { details: outcome.details, omittedIds: outcome.omittedIds },
                toolCallId: call.id,
              });
            }
          } else {
            yield* Effect.logWarning("Agent issued unknown tool call").pipe(
              Effect.annotateLogs({
                operation: "agent/tool",
                requestId: input.requestId,
                tool: toolName,
              }),
            );

            results.push({
              name: "searchDishes",
              ok: false,
              payload: `Unknown tool "${toolName}". Available: searchDishes, getDishDetails.`,
              toolCallId: call.id,
            });
          }
        }

        if (searching) {
          yield* emit(
            "searching-catalog",
            `Exploring ${servedIds.size.toString()} matching dishes.`,
            false,
          );
        }

        if (inspecting) {
          yield* emit("inspecting-dishes", "Taking a closer look at a few dishes.", false);
        }

        return results;
      });

    const loop = Effect.gen(function* (): Effect.Effect<
      AgentRunOutcome,
      AgentRunError,
      AgentRunEnv
    > {
      for (let round = 1; round <= bounds.maxRounds; round += 1) {
        yield* emit(
          "muse-curating",
          round === 1 ? "Muse is exploring the catalog." : "Refining the shortlist.",
          false,
        );

        const turn = yield* runOneTurn().pipe(
          Effect.catchTag("AgentTimeout", () => fallback("timeout", TIMEOUT_WARNING)),
          Effect.catchTags({
            MetaAuthError: (error) => Effect.fail(error),
            MetaPermanentError: (error) => Effect.fail(error),
            MetaRateLimited: () => fallback("rate-limited", RATE_LIMITED_WARNING),
            MetaRequestError: () => fallback("transient", TRANSIENT_WARNING),
            MetaInvalidOutput: () => fallback("invalid-output", INVALID_OUTPUT_WARNING),
          }),
        );

        if (turn._tag === "DeterministicFallback" || turn._tag === "Selected") {
          // Fallback short-circuits the loop (only the Degraded variant is
          // produced here; Selected is unreachable but narrowed for safety).
          return turn;
        }

        const step = AgentTurnOutput.$match(turn, {
          ToolCalls: ({ calls }) => ({ calls, kind: "calls" }) as const,
          Final: ({ rawJson }) => ({ kind: "final", rawJson }) as const,
        });

        if (step.kind === "final") {
          yield* emit("finalizing", "Getting your recommendations ready.", false);

          const parsed = parseFinalSelection(step.rawJson);

          if (parsed === null) {
            yield* Effect.logWarning("Agent final answer was not valid JSON").pipe(
              Effect.annotateLogs({ operation: "agent/finalize", requestId: input.requestId }),
            );

            return yield* fallback("invalid-output", INVALID_OUTPUT_WARNING);
          }

          const validated = yield* validateAgentFinalSelection(
            [...parsed.selections],
            servedRows(),
            outputLimit,
          ).pipe(
            Effect.catchTag("AgentInvalidSelection", (error) =>
              Effect.succeed({ invalid: error.reason }),
            ),
          );

          if ("invalid" in validated) {
            yield* Effect.logWarning("Agent final selection failed validation").pipe(
              Effect.annotateLogs({
                operation: "agent/finalize",
                requestId: input.requestId,
                reason: validated.invalid,
                servedCount: servedRows().length,
              }),
            );

            return yield* fallback("invalid-output", INVALID_OUTPUT_WARNING);
          }

          yield* Effect.logInfo("Agent recommendation selected").pipe(
            Effect.annotateLogs({
              operation: "agent/recommend",
              requestId: input.requestId,
              roundsUsed: round,
              selectedCount: validated.ids.length,
              servedCount: servedRows().length,
              toolCallsUsed,
            }),
          );

          yield* emit("completed", null, true);

          return AgentRunOutcome.Selected({
            ids: [...validated.ids],
            reasons: [...validated.reasons],
          });
        }

        if (step.calls.length === 0) {
          yield* Effect.logWarning("Agent turn returned no tool calls and no final answer").pipe(
            Effect.annotateLogs({
              operation: "agent/turn",
              requestId: input.requestId,
              round,
            }),
          );

          return yield* fallback("invalid-output", INVALID_OUTPUT_WARNING);
        }

        const perRoundRemaining = bounds.maxToolCallsPerRound;
        const totalRemaining = bounds.maxToolCalls - toolCallsUsed;
        const allowed = Math.min(step.calls.length, perRoundRemaining, totalRemaining);

        if (allowed <= 0) {
          yield* Effect.logWarning("Agent tool budget exhausted").pipe(
            Effect.annotateLogs({
              operation: "agent/budget",
              requestId: input.requestId,
              round,
              toolCallsUsed,
            }),
          );

          return yield* fallback("budget-exhausted", BUDGET_WARNING);
        }

        if (allowed < step.calls.length) {
          yield* Effect.logWarning("Agent tool calls truncated to budget").pipe(
            Effect.annotateLogs({
              operation: "agent/budget",
              requestId: input.requestId,
              dropped: step.calls.length - allowed,
              round,
            }),
          );
        }

        const accepted = step.calls.slice(0, allowed);
        toolCallsUsed += accepted.length;

        const results = yield* executeCalls(accepted);

        transcript.push(AgentTranscriptEntry.AssistantTools({ calls: [...accepted] }));
        transcript.push(AgentTranscriptEntry.ToolResults({ results }));
      }

      yield* Effect.logWarning("Agent rounds exhausted without a final selection").pipe(
        Effect.annotateLogs({
          operation: "agent/budget",
          requestId: input.requestId,
          roundsUsed: bounds.maxRounds,
          toolCallsUsed,
        }),
      );

      return yield* fallback("budget-exhausted", BUDGET_WARNING);
    });

    const outcome = yield* loop.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(bounds.orchestrationDeadlineMs),
        orElse: () =>
          Effect.succeed(
            AgentRunOutcome.DeterministicFallback({
              cause: "timeout",
              ids: headIds(pool, outputLimit),
              warning: TIMEOUT_WARNING,
            }),
          ),
      }),
    );

    if (outcome._tag === "DeterministicFallback") {
      yield* Effect.logWarning("Agent recommendation degraded").pipe(
        Effect.annotateLogs({
          backend: "muse-agent",
          cause: outcome.cause,
          operation: "agent/recommend",
          requestId: input.requestId,
          servedCount: servedIds.size,
          toolCallsUsed,
        }),
      );
    }

    return outcome;
  }).pipe(
    Effect.annotateLogs({ operation: "agent/recommend", requestId: input.requestId }),
    Effect.catchTags({
      MetaAuthError: (error) => Effect.fail(error),
      MetaPermanentError: (error) => Effect.fail(error),
    }),
  );
};

/** Map an agent fallback cause onto the existing degraded-cause vocabulary. */
export const toDegradedCause = (
  cause: AgentFallbackCause,
): "rate-limited" | "transient" | "invalid-output" => {
  if (cause === "rate-limited") {
    return "rate-limited";
  }

  if (cause === "invalid-output") {
    return "invalid-output";
  }

  return "transient";
};

export const warningForCause = (cause: AgentFallbackCause): string => {
  if (cause === "rate-limited") {
    return RATE_LIMITED_WARNING;
  }

  if (cause === "invalid-output") {
    return INVALID_OUTPUT_WARNING;
  }

  if (cause === "budget-exhausted") {
    return BUDGET_WARNING;
  }

  if (cause === "timeout") {
    return TIMEOUT_WARNING;
  }

  return TRANSIENT_WARNING;
};
