/**
 * Backend workstream A — public server-only API of the agent subpackage.
 *
 * Intended importers: the recommend-flow wiring (coordinator-owned shared
 * files) and the sibling workstreams (provider transport B implements
 * `AgentModelClient`; progress transport C consumes `ProgressEvent` events
 * via the `AgentProgressSink`). Browser components must never import this.
 */

export type { AgentLoopError } from "@/modules/food-discovery/server/agent/errors";

export {
  AgentAborted,
  AgentBudgetExhausted,
  AgentDeadlineExceeded,
  AgentInvalidSelection,
  AgentMalformedToolCall,
  AgentMalformedTurn,
  AgentTimeout,
} from "@/modules/food-discovery/server/agent/errors";

export {
  isAgentEnabled,
  resolveAgentBounds,
  type ResolvedAgentBounds,
} from "@/modules/food-discovery/server/agent/bounds";

export {
  buildAgentEligibility,
  type AgentEligibility,
  type AgentEligibilityInput,
  type AgentScope,
} from "@/modules/food-discovery/server/agent/eligibility";

export {
  DetailsToolOutcome,
  GET_DISH_DETAILS_JSON_SCHEMA,
  SEARCH_DISHES_JSON_SCHEMA,
  SearchToolOutcome,
  encodeAgentCursor,
  fetchDishDetails,
  getDishDetailsArgsSchema,
  searchDishesArgsSchema,
  searchEligiblePool,
  summarizeCandidate,
  type DetailsBatchInput,
} from "@/modules/food-discovery/server/agent/catalog-tools";

export {
  AgentModelClient,
  AGENT_TOOL_DEFINITIONS,
  AgentTranscriptEntry,
  AgentTurnOutput,
  buildAgentSystemPrompt,
  buildAgentUserBlock,
  parseFinalSelection,
  type AgentToolCall,
  type AgentToolDefinition,
  type AgentTranscriptToolResult,
  type AgentTurnInput,
  type AgentUserBlockInput,
  type DetailsToolArgs,
  type ParsedFinalSelection,
  type SearchToolArgs,
} from "@/modules/food-discovery/server/agent/model-client";

export {
  agentSelectionsSchema,
  validateAgentFinalSelection,
  type AgentSelection,
  type ValidatedAgentSelection,
} from "@/modules/food-discovery/server/agent/validation";

export {
  AgentRunOutcome,
  runAgentLoop,
  toDegradedCause,
  warningForCause,
  type AgentFallbackCause,
  type AgentProgressSink,
  type AgentRunEnv,
  type AgentRunError,
  type AgentRunInput,
} from "@/modules/food-discovery/server/agent/orchestrator";
