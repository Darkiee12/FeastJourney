import { Data } from "effect";

/**
 * Backend workstream A — typed agent failures for §5 of the plan.
 *
 * Provider-side failures reuse the existing `MetaError` taxonomy from
 * `@/server/integrations/meta-client` (auth/rate-limit/transient/invalid)
 * so there is exactly one failure table; the orchestrator maps them through
 * the existing `dispositionForMetaError`. Database failures reuse
 * `DatabaseError`. The errors below cover only agent-loop failures that
 * neither taxonomy expresses.
 *
 * Recovery policy (deliberate finalization, never silent success):
 * - AgentTimeout / AgentDeadlineExceeded / AgentBudgetExhausted /
 *   AgentInvalidSelection / AgentMalformedTurn → deterministic fallback
 *   (honest degraded provenance decided by the caller), never a partial
 *   model selection.
 * - AgentAborted is observational only: Effect interruption already unwinds
 *   the loop on client disconnect; this error exists so an explicit abort
 *   signal (e.g. a closed stream sink) can join the same typed channel.
 * - Auth/config failures are NOT mapped here: they stay loud operational
 *   errors via the existing `MetaAuthError` / `MetaPermanentError` /
 *   `RecommendationMisconfigured` path and must never degrade silently.
 */

/** One provider round trip exceeded its per-call budget. */
export class AgentTimeout extends Data.TaggedError("AgentTimeout")<{
  readonly operation: string;
  readonly timeoutMs: number;
}> {}

/** The whole orchestration exceeded its deadline. */
export class AgentDeadlineExceeded extends Data.TaggedError("AgentDeadlineExceeded")<{
  readonly deadlineMs: number;
  readonly roundsUsed: number;
  readonly toolCallsUsed: number;
}> {}

/** Explicit abort observed (closed sink, cancelled request). */
export class AgentAborted extends Data.TaggedError("AgentAborted")<{
  readonly reason: string;
}> {}

/**
 * A model tool call was unusable: unknown tool name, arguments that fail
 * schema validation, or arguments that would widen eligibility (a cuisine
 * conflicting with the request's hard filter, an id outside the eligible
 * pool). The call is answered with a bounded tool-error result and the
 * loop continues; repeated malformed calls exhaust the tool budget and
 * fall back deterministically instead of retrying forever.
 */
export class AgentMalformedToolCall extends Data.TaggedError("AgentMalformedToolCall")<{
  readonly tool: string;
  readonly reason: string;
}> {}

/**
 * A model turn returned neither tool calls nor a parseable final answer.
 * Bounded recovery: one deterministic fallback, no reprompt loop.
 */
export class AgentMalformedTurn extends Data.TaggedError("AgentMalformedTurn")<{
  readonly reason: string;
}> {}

/** The final selection failed validation (unknown/dupe/over-limit ids). */
export class AgentInvalidSelection extends Data.TaggedError("AgentInvalidSelection")<{
  readonly reason: string;
}> {}

/** Rounds or tool calls exhausted without a valid final selection. */
export class AgentBudgetExhausted extends Data.TaggedError("AgentBudgetExhausted")<{
  readonly roundsUsed: number;
  readonly toolCallsUsed: number;
}> {}

export type AgentLoopError =
  | AgentTimeout
  | AgentDeadlineExceeded
  | AgentAborted
  | AgentMalformedToolCall
  | AgentMalformedTurn
  | AgentInvalidSelection
  | AgentBudgetExhausted;
