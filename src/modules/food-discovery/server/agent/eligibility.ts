import { isDbIdString, isLanguageTag } from "@/modules/food-discovery/server/domain/ids";
import type { RecommendationServedScope } from "@/modules/food-discovery/server/operations/recommendation-service";

/**
 * Backend workstream A — the eligibility snapshot every agent tool executes
 * against. Built ONCE per request by the recommend-flow wiring (coordinator)
 * from the same resolved values `RecommendationService` uses, then frozen:
 * no tool argument can change it.
 *
 * Non-negotiable (mirrors the protocol invariants):
 * - Scope (country/city/nearby/worldwide), the cuisine hard filter, and the
 *   resolved exclusion id set enter through this snapshot. Tool arguments
 *   NEVER carry scope, exclusions, publication state, or coordinates.
 * - `excludedIds` are canonical registry ids (decimal strings), never raw
 *   diner terms. `canonicalExclusions` are registry display names for
 *   model-prompt data only — never raw terms, never safety claims.
 * - Coordinates never appear here: precise-scope searches resolve to dish
 *   ids server-side before the agent runs; the snapshot carries only the
 *   coarse `regionLabel` the model may see.
 *
 * The snapshot does NOT re-run SQL filtering logic: the caller supplies the
 * already-eligible pool (produced by the existing lane logic — country,
 * city→country fallback, nearby, worldwide — with SQL exclusions applied).
 * Tool executors only narrow that pool in memory.
 */

export type AgentScope = RecommendationServedScope;

export interface AgentEligibility {
  /** Which pool lane served this run (honest scope label for logs/prompts). */
  readonly scope: AgentScope;
  /** Hard cuisine filter from the request, or null when unfiltered. */
  readonly cuisine: string | null;
  /** Resolved canonical exclusion ids (decimal strings, deduped). */
  readonly excludedIds: ReadonlyArray<string>;
  /** Registry display names for prompt data only (counts logged, never terms). */
  readonly canonicalExclusions: ReadonlyArray<string>;
  /** Request locale for localized names/descriptions. */
  readonly locale: string;
  /** Request meal occasion slug (soft ranking signal). */
  readonly meal: string;
  /**
   * Coarse model-safe region label: explicit cuisine, then the country
   * scope (or a city request's country hint), else null. Never coordinates,
   * never a city street-level claim.
   */
  readonly regionLabel: string | null;
}

export interface AgentEligibilityInput {
  readonly scope: AgentScope;
  readonly cuisine?: string | undefined;
  readonly excludedIds: ReadonlyArray<string>;
  readonly canonicalExclusions: ReadonlyArray<string>;
  readonly locale: string;
  readonly meal: string;
  readonly regionLabel?: string | null | undefined;
}

const VALID_SCOPES: ReadonlySet<AgentScope> = new Set(["city", "country", "nearby", "worldwide"]);

/**
 * Fail-closed constructor from service-resolved values. Returns null when
 * any piece is malformed (unknown scope, non-tag locale, non-decimal
 * exclusion id) so the caller takes the deterministic path instead of
 * running an agent on untrusted eligibility. Deduplicates exclusion ids,
 * preserving first-occurrence order.
 */
export const buildAgentEligibility = (input: AgentEligibilityInput): AgentEligibility | null => {
  if (!VALID_SCOPES.has(input.scope)) {
    return null;
  }

  if (!isLanguageTag(input.locale)) {
    return null;
  }

  const cuisine = input.cuisine?.trim() ?? "";

  if (input.cuisine !== undefined && cuisine.length === 0) {
    return null;
  }

  if (input.meal.trim().length === 0) {
    return null;
  }

  const seen = new Set<string>();
  const excludedIds: Array<string> = [];

  for (const id of input.excludedIds) {
    if (!isDbIdString(id)) {
      return null;
    }

    if (!seen.has(id)) {
      seen.add(id);
      excludedIds.push(id);
    }
  }

  const regionLabel = input.regionLabel?.trim() ?? "";

  return {
    scope: input.scope,
    cuisine: cuisine.length > 0 ? cuisine : null,
    excludedIds,
    canonicalExclusions: [...input.canonicalExclusions],
    locale: input.locale,
    meal: input.meal,
    regionLabel: regionLabel.length > 0 ? regionLabel : null,
  };
};
