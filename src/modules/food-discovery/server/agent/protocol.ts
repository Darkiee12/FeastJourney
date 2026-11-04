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

/** Agentic run bounds. Every value is required from the environment (no defaults). */
import { z } from "zod";

type EnvBag = {
  readonly [key: string]: string | undefined;
};

const PositiveIntFromEnv = (varName: string) =>
  z
    .string()
    .min(1, `${varName} must not be empty.`)
    .transform((raw) => Number(raw))
    .pipe(z.number())
    .refine((n) => Number.isSafeInteger(n) && n > 0, {
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

export const resolveAgentBounds = (env: EnvBag = process.env) =>
  ({
    maxRounds: parsePositiveInt("RECOMMEND_AGENT_MAX_ROUNDS", env),
    maxToolCalls: parsePositiveInt("RECOMMEND_AGENT_MAX_TOOL_CALLS", env),
    detailsPerCall: parsePositiveInt("RECOMMEND_AGENT_DETAILS_PER_CALL", env),
    candidatePoolCap: parsePositiveInt("RECOMMEND_AGENT_CANDIDATE_POOL_CAP", env),
    finalLimit: parsePositiveInt("RECOMMEND_AGENT_FINAL_LIMIT", env),
    providerTimeoutMs: parsePositiveInt("MODEL_AGENT_TIMEOUT_MS", env),
    orchestrationDeadlineMs: parsePositiveInt("RECOMMEND_AGENT_DEADLINE_MS", env),
  }) as const;

export const AGENT_BOUNDS = resolveAgentBounds();

export type AgentBounds = typeof AGENT_BOUNDS;

/** Env flag gating agentic mode. Off (or unset) keeps the existing single-shot path byte-identical. */
export const RECOMMEND_AGENT_FLAG = "RECOMMEND_AGENT_ENABLED";
