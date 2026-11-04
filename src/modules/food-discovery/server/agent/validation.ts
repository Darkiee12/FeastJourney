import { Effect } from "effect";
import { z } from "zod";

import { AgentInvalidSelection } from "@/modules/food-discovery/server/agent/errors";
import {
  validateRankedResult,
  type RecommendationCandidateRow,
} from "@/modules/food-discovery/server/operations/recommendation-service";
import { MAX_REASON_LENGTH } from "@/server/integrations/meta-client";

/**
 * Backend workstream A — final-selection validation.
 *
 * The model proposes an ID-keyed selection (one `{dishId, reason}` object
 * per dish, per the protocol's internal-preference note); this module
 * converts it to parallel arrays and delegates every semantic check to the
 * existing `validateRankedResult`: subset of the served candidate rows, no
 * duplicates, at most the output limit, non-empty reasons within the length
 * ceiling, and the safety/health/popularity/hours/price claim denylist.
 * No validation logic is duplicated here — only the ID-keyed envelope and
 * the error translation into `AgentInvalidSelection` (deterministic
 * fallback by the orchestrator).
 */

/** One model-proposed pick: the id it claims plus the reason for that id. */
export interface AgentSelection {
  readonly dishId: string;
  readonly reason: string;
}

const HAS_NEWLINE = /[\r\n\u2028\u2029]/;

export const agentSelectionsSchema = z
  .array(
    z.object({
      dishId: z.string().regex(/^[0-9]+$/, "dishId must be a decimal id string"),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(MAX_REASON_LENGTH)
        .refine((reason) => !HAS_NEWLINE.test(reason), "reason must be single-line"),
    }),
  )
  .min(1)
  .max(10);

export interface ValidatedAgentSelection {
  readonly ids: ReadonlyArray<string>;
  readonly reasons: ReadonlyArray<string>;
}

/**
 * Validate a raw model final answer against exactly the rows the backend
 * served. `servedRows` must be the pool filtered to served ids — membership
 * is then enforced as "subset of served" with zero extra logic. Any
 * violation (including an empty selection) becomes `AgentInvalidSelection`;
 * the orchestrator falls back deterministically and never shows partial
 * model output.
 */
export const validateAgentFinalSelection = (
  selections: ReadonlyArray<AgentSelection>,
  servedRows: ReadonlyArray<RecommendationCandidateRow>,
  outputLimit: number,
): Effect.Effect<ValidatedAgentSelection, AgentInvalidSelection> =>
  Effect.gen(function* () {
    if (selections.length === 0) {
      return yield* new AgentInvalidSelection({ reason: "Agent final selection was empty" });
    }

    if (selections.length > outputLimit) {
      return yield* new AgentInvalidSelection({
        reason: `Agent final selection returned ${selections.length.toString()} dishes (limit ${outputLimit.toString()})`,
      });
    }

    const ids = selections.map((selection) => selection.dishId);
    const reasons = selections.map((selection) => selection.reason);

    const validated = yield* validateRankedResult({ ids, reasons }, servedRows, outputLimit).pipe(
      Effect.mapError((invalid) => new AgentInvalidSelection({ reason: invalid.reason })),
    );

    return { ids: [...validated.ids], reasons: [...validated.reasons] };
  });
