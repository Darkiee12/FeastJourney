import {
  AGENT_BOUNDS,
  RECOMMEND_AGENT_FLAG,
  type AgentBounds as ProtocolAgentBounds,
} from "@/modules/food-discovery/server/agent/protocol";

/**
 * Backend workstream A — bound resolution for the agent loop.
 *
 * Single source of truth is the coordinator-owned `AGENT_BOUNDS`: every
 * value is env-required with no hardcoded default (importing the protocol
 * throws naming the missing variable). This module adds no fallback, no
 * clamp, and no literal of its own — it only derives the three
 * workstream-A-local mechanics from the contract values:
 * - `toolPageLimit`: one page carries at most a final selection's worth of
 *   summaries; details stay on demand.
 * - `initialOverviewLimit`: the opening overview covers the same window.
 * - `maxToolCallsPerRound`: the total budget spread evenly across rounds
 *   (rounds are positive by contract, so no division by zero).
 * Changing these derivations (not the contract values) needs no coordinator
 * approval; changing the 7 contract values is operator-owned env config.
 *
 * `resolveAgentBounds` takes no env argument on purpose: re-reading
 * `process.env` here would bypass the protocol's load-time validation.
 * Callers that need different bounds (tests) spread the resolved object
 * and override fields explicitly.
 */

export interface ResolvedAgentBounds extends ProtocolAgentBounds {
  readonly maxToolCallsPerRound: number;
  readonly toolPageLimit: number;
  readonly initialOverviewLimit: number;
}

export const resolveAgentBounds = (): ResolvedAgentBounds => ({
  ...AGENT_BOUNDS,
  maxToolCallsPerRound: Math.ceil(AGENT_BOUNDS.maxToolCalls / AGENT_BOUNDS.maxRounds),
  toolPageLimit: AGENT_BOUNDS.finalLimit,
  initialOverviewLimit: AGENT_BOUNDS.finalLimit,
});

/**
 * Feature flag for agentic recommendations. Off (or unset, or any value
 * other than "1"/"true") keeps the existing single-shot path byte-identical.
 * Evaluated per request at the transport edge so rollout needs no restart.
 */
export const isAgentEnabled = (env?: Readonly<Record<string, string | undefined>>): boolean => {
  const raw = env?.[RECOMMEND_AGENT_FLAG] ?? process.env[RECOMMEND_AGENT_FLAG];

  if (raw === undefined) {
    return false;
  }

  const normalized = raw.trim().toLowerCase();

  return normalized === "1" || normalized === "true";
};
