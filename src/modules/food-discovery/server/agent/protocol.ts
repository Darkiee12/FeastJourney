/**
 * Agentic recommendation protocol (coordinator-owned contract).
 *
 * Read-only contract for the four parallel workstreams behind the agentic
 * Muse recommendation feature. Implementations MUST conform to these
 * shapes; any change requires coordinator approval BEFORE editing.
 *
 * Invariants (non-negotiable, from the trust model):
 * - Eligibility (scope, cuisine hard filter, exclusions, publication state)
 *   is enforced server-side in SQL. Tool arguments NEVER carry scope,
 *   exclusions, publication state, or coordinates.
 * - Coordinates never leave the backend: not in tool args, tool results,
 *   progress events, logs, or model prompts.
 * - Raw diner exclusion terms never reach the model; only canonical
 *   registry names resolved server-side.
 * - Final output is validated as a subset of IDs the backend actually
 *   served to the model. No invented dishes, no duplicates.
 * - Every bound below is enforced mechanically, not by prompt goodwill.
 * - Failure anywhere degrades to the existing deterministic order.
 *   Auth/config failures stay loud operational errors.
 */

export type AgentToolName = "searchDishes" | "getDishDetails";

export interface SearchDishesInput {
  readonly cuisine?: string | undefined;
  readonly category?: string | undefined;
  readonly query?: string | undefined;
  readonly cursor?: string | undefined;
  /** Server-clamped to AGENT_TOOL_PAGE_LIMIT. */
  readonly limit?: number | undefined;
}

export interface AgentDishSummary {
  readonly id: string;
  readonly name: string;
  readonly cuisines: ReadonlyArray<string>;
  readonly categories: ReadonlyArray<string>;
  readonly description: string | null;
}

export interface SearchDishesResult {
  readonly dishes: ReadonlyArray<AgentDishSummary>;
  /** Opaque cursor for the next page, or null when exhausted. */
  readonly nextCursor: string | null;
}

export interface GetDishDetailsInput {
  /** 1..AGENT_DETAILS_PER_CALL dish IDs previously returned by searchDishes. */
  readonly ids: ReadonlyArray<string>;
}

export interface AgentDishDetail extends AgentDishSummary {
  readonly ingredients: ReadonlyArray<string>;
  /** Coarse region label only (country/cuisine scope); never coordinates. */
  readonly regionLabel: string | null;
}

export type ProgressStage =
  | "preparing"
  | "searching-catalog"
  | "muse-curating"
  | "inspecting-dishes"
  | "finalizing"
  | "completed"
  | "degraded"
  | "failed";

export interface ProgressEvent {
  readonly requestId: string;
  /** Monotonic sequence number; consumers drop out-of-order duplicates. */
  readonly seq: number;
  readonly stage: ProgressStage;
  /** Human-safe detail only: counts and labels, never coords/exclusions/reasoning. */
  readonly detail: string | null;
  readonly terminal: boolean;
}

/** Agentic run bounds. Every value is operator-owned env config.
 * Unset uses the documented fallback at the server-only use site;
 * an explicitly set invalid value fails loudly naming field + reason;
 * an explicitly set valid value flows through exactly as configured.
 * There are intentionally no upper bounds and no silent clamps. */
export interface AgentBounds {
  readonly maxRounds: number;
  readonly maxToolCalls: number;
  readonly detailsPerCall: number;
  readonly candidatePoolCap: number;
  readonly finalLimit: number;
  readonly providerTimeoutMs: number;
  readonly orchestrationDeadlineMs: number;
}

import { z } from "zod";

type EnvBag = {
  readonly [key: string]: string | undefined;
};

const PositiveIntFromEnv = (varName: string) =>
  z
    .string()
    .regex(/^[1-9]\d*$/, `${varName} must be a positive integer.`)
    .transform((raw) => Number(raw))
    .refine((n) => Number.isSafeInteger(n), {
      message: `${varName} must be a positive integer.`,
    });

const parsePositiveInt = (varName: string, env: EnvBag): number => {
  const result = PositiveIntFromEnv(varName).safeParse(env[varName]);

  if (!result.success) {
    throw new Error(
      `${varName} must be set to a positive integer in the environment. Received: ${JSON.stringify(env[varName] ?? null)}.`,
    );
  }

  return result.data;
};

/**
 * Pure server-only resolver: takes an explicit env bag (callers pass
 * `process.env`), never reads ambient state itself, never runs at import
 * time. Browser code must only ever use `import type` from this module.
 */
export const resolveAgentBounds = (env: EnvBag): AgentBounds => ({
  maxRounds: parsePositiveInt("RECOMMEND_AGENT_MAX_ROUNDS", env),
  maxToolCalls: parsePositiveInt("RECOMMEND_AGENT_MAX_TOOL_CALLS", env),
  detailsPerCall: parsePositiveInt("RECOMMEND_AGENT_DETAILS_PER_CALL", env),
  candidatePoolCap: parsePositiveInt("RECOMMEND_AGENT_CANDIDATE_POOL_CAP", env),
  finalLimit: parsePositiveInt("RECOMMEND_AGENT_FINAL_LIMIT", env),
  providerTimeoutMs: parsePositiveInt("MODEL_AGENT_TIMEOUT_MS", env),
  orchestrationDeadlineMs: parsePositiveInt("RECOMMEND_AGENT_DEADLINE_MS", env),
});

/**
 * Lazily-resolved contract values for in-flight server-only consumers.
 * Property getters defer parsing to first access (server-only use sites),
 * so importing this module — including browser `import type` usage —
 * never parses and never throws. Each access re-reads `process.env`,
 * preserving the operator-owns-config principle with no cached snapshot.
 *
 * New server-only code should prefer `resolveAgentBounds(process.env)`;
 * this object stays so existing contract shapes keep compiling.
 */
export const AGENT_BOUNDS: AgentBounds = {
  get maxRounds(): number {
    return parsePositiveInt("RECOMMEND_AGENT_MAX_ROUNDS", process.env);
  },
  get maxToolCalls(): number {
    return parsePositiveInt("RECOMMEND_AGENT_MAX_TOOL_CALLS", process.env);
  },
  get detailsPerCall(): number {
    return parsePositiveInt("RECOMMEND_AGENT_DETAILS_PER_CALL", process.env);
  },
  get candidatePoolCap(): number {
    return parsePositiveInt("RECOMMEND_AGENT_CANDIDATE_POOL_CAP", process.env);
  },
  get finalLimit(): number {
    return parsePositiveInt("RECOMMEND_AGENT_FINAL_LIMIT", process.env);
  },
  get providerTimeoutMs(): number {
    return parsePositiveInt("MODEL_AGENT_TIMEOUT_MS", process.env);
  },
  get orchestrationDeadlineMs(): number {
    return parsePositiveInt("RECOMMEND_AGENT_DEADLINE_MS", process.env);
  },
};

/** Env flag gating agentic mode. Off (or unset) keeps the existing single-shot path byte-identical. */
export const RECOMMEND_AGENT_FLAG = "RECOMMEND_AGENT_ENABLED";
