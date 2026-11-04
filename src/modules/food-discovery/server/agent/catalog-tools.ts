import { Data, Effect } from "effect";
import { z } from "zod";

import type { AgentEligibility } from "@/modules/food-discovery/server/agent/eligibility";
import type {
  AgentDishDetail,
  AgentDishSummary,
  GetDishDetailsInput,
  SearchDishesInput,
  SearchDishesResult,
} from "@/modules/food-discovery/server/agent/protocol";
import { isDbIdString } from "@/modules/food-discovery/server/domain/ids";
import { asLocalizedName, pickDisplayName } from "@/modules/food-discovery/server/domain/search";
import type { RecommendationCandidateRow } from "@/modules/food-discovery/server/operations/recommendation-service";
import { DishRelationsRepository } from "@/modules/food-discovery/server/repository/dish-relations-repository";
import { IngredientRepository } from "@/modules/food-discovery/server/repository/ingredient-repository";
import { PlaceRepository } from "@/modules/food-discovery/server/repository/place-repository";
import type { DatabaseError } from "@/server/database/query";

/**
 * Backend workstream A — read-only catalog tool executors.
 *
 * Both tools execute against a frozen eligible pool plus relation reads;
 * they NEVER accept scope, exclusions, publication state, or coordinates
 * from tool arguments. Every narrowing below can only shrink the eligible
 * set: a conflicting model-supplied filter is rejected as a tool error,
 * never applied as a widening.
 *
 * No new SQL: search pages the caller-supplied pool snapshot (already
 * eligibility-filtered by the existing lane queries, in deterministic SQL
 * order), and details compose the existing by-ids relation queries.
 */

/** Zod 4.6 validation at the model-output trust boundary. */
export const searchDishesArgsSchema = z.object({
  cuisine: z.string().trim().min(1).max(80).optional(),
  category: z.string().trim().min(1).max(80).optional(),
  query: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(30).optional(),
});

export const getDishDetailsArgsSchema = z.object({
  ids: z.array(z.string().min(1).max(24)).min(1).max(20),
});

const agentCursorSchema = z.object({
  v: z.literal(1),
  off: z.number().int().min(0),
});

/** Opaque stable-pagination cursor over the frozen pool (offset-based). */
export const encodeAgentCursor = (offset: number): string =>
  Buffer.from(JSON.stringify({ off: offset, v: 1 }), "utf8").toString("base64url");

const decodeAgentCursor = (cursor: string | undefined): number | null => {
  if (cursor === undefined) {
    return 0;
  }

  if (cursor.length === 0 || cursor.length > 500) {
    return null;
  }

  let text: string;

  try {
    text = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }

  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }

  const parsed = agentCursorSchema.safeParse(raw);

  return parsed.success ? parsed.data.off : null;
};

const nonNullStrings = (values: ReadonlyArray<string | null>): Array<string> =>
  values.filter((value): value is string => value !== null);

export const summarizeCandidate = (row: RecommendationCandidateRow): AgentDishSummary => ({
  categories: nonNullStrings(row.categories),
  cuisines: nonNullStrings(row.cuisines),
  description: row.description,
  id: row.id,
  name: row.name,
});

export type SearchToolOutcome = Data.TaggedEnum<{
  Matched: {
    readonly result: SearchDishesResult;
    /** Pool ids newly exposed to the model by this page. */
    readonly servedIds: ReadonlyArray<string>;
  };
  Rejected: { readonly message: string };
}>;

export const SearchToolOutcome = Data.taggedEnum<SearchToolOutcome>();

/**
 * Page over the frozen eligible pool with narrowing-only filters.
 * Pure (no I/O): the pool snapshot is fetched once per run by the
 * orchestrator, so repeated tool calls never re-query and never duplicate
 * retrieval. Rejections are recoverable tool-error strings, never throws.
 */
export const searchEligiblePool = (
  pool: ReadonlyArray<RecommendationCandidateRow>,
  eligibility: AgentEligibility,
  rawArgs: unknown,
  pageLimit: number,
): SearchToolOutcome => {
  const parsed = searchDishesArgsSchema.safeParse(rawArgs);

  if (!parsed.success) {
    return SearchToolOutcome.Rejected({ message: "Invalid searchDishes arguments." });
  }

  const args: SearchDishesInput = parsed.data;
  const offset = decodeAgentCursor(args.cursor);

  if (offset === null) {
    return SearchToolOutcome.Rejected({ message: "Invalid searchDishes cursor." });
  }

  const requestedCuisine = args.cuisine?.trim() ?? "";

  if (eligibility.cuisine !== null) {
    if (requestedCuisine.length > 0 && requestedCuisine !== eligibility.cuisine) {
      return SearchToolOutcome.Rejected({
        message: `Cuisine is fixed to "${eligibility.cuisine}" for this request; omit cuisine to browse it.`,
      });
    }
  }

  const effectiveCuisine =
    eligibility.cuisine ?? (requestedCuisine.length > 0 ? requestedCuisine : null);
  const effectiveCategory = args.category?.trim() ?? null;
  const needle = args.query?.trim().toLowerCase() ?? null;
  const limit = Math.min(args.limit ?? pageLimit, pageLimit);

  const matched = pool.filter((row) => {
    if (effectiveCuisine !== null && !nonNullStrings(row.cuisines).includes(effectiveCuisine)) {
      return false;
    }

    if (effectiveCategory !== null && !nonNullStrings(row.categories).includes(effectiveCategory)) {
      return false;
    }

    if (needle !== null) {
      const haystack = `${row.name} ${row.description ?? ""}`.toLowerCase();

      if (!haystack.includes(needle)) {
        return false;
      }
    }

    return true;
  });

  const page = matched.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const exhausted = nextOffset >= matched.length;

  return SearchToolOutcome.Matched({
    result: {
      dishes: page.map(summarizeCandidate),
      nextCursor: exhausted ? null : encodeAgentCursor(nextOffset),
    },
    servedIds: page.map((row) => row.id),
  });
};

export interface DetailsBatchInput {
  readonly pool: ReadonlyArray<RecommendationCandidateRow>;
  readonly eligibility: AgentEligibility;
  readonly rawArgs: unknown;
  readonly detailsPerCall: number;
}

export type DetailsToolOutcome = Data.TaggedEnum<{
  Resolved: {
    readonly details: ReadonlyArray<AgentDishDetail>;
    readonly omittedIds: ReadonlyArray<string>;
    readonly servedIds: ReadonlyArray<string>;
  };
  Rejected: { readonly message: string };
}>;

export const DetailsToolOutcome = Data.taggedEnum<DetailsToolOutcome>();

type DetailsEnv = DishRelationsRepository | IngredientRepository | PlaceRepository;

const MAX_INGREDIENT_NAMES = 12;

/**
 * Inspect previously-served dish ids. Per-row isolation: each requested id
 * resolves independently against the eligible pool and the relation reads —
 * an unknown id is omitted (reported in `omittedIds`, never served, so it
 * can never be selected), never fatal to the surviving rows. Only ids in
 * the eligible pool can resolve; pool membership was fixed server-side.
 */
export const fetchDishDetails = (
  input: DetailsBatchInput,
): Effect.Effect<DetailsToolOutcome, DatabaseError, DetailsEnv> =>
  Effect.gen(function* () {
    const parsed = getDishDetailsArgsSchema.safeParse(input.rawArgs);

    if (!parsed.success) {
      return DetailsToolOutcome.Rejected({ message: "Invalid getDishDetails arguments." });
    }

    const args: GetDishDetailsInput = parsed.data;

    if (args.ids.length > input.detailsPerCall) {
      return DetailsToolOutcome.Rejected({
        message: `Too many ids (max ${input.detailsPerCall.toString()} per call).`,
      });
    }

    const seen = new Set<string>();

    for (const id of args.ids) {
      if (!isDbIdString(id)) {
        return DetailsToolOutcome.Rejected({ message: "Invalid dish id format." });
      }

      if (seen.has(id)) {
        return DetailsToolOutcome.Rejected({ message: "Duplicate dish ids in one call." });
      }

      seen.add(id);
    }

    const poolById = new Map<string, RecommendationCandidateRow>();

    for (const row of input.pool) {
      poolById.set(row.id, row);
    }

    const eligibleIds: Array<bigint> = [];
    const omittedIds: Array<string> = [];

    for (const id of args.ids) {
      if (poolById.has(id)) {
        eligibleIds.push(BigInt(id));
      } else {
        omittedIds.push(id);
      }
    }

    if (eligibleIds.length === 0) {
      return DetailsToolOutcome.Resolved({ details: [], omittedIds, servedIds: [] });
    }

    const relations = yield* Effect.flatMap(DishRelationsRepository, (repo) =>
      Effect.all(
        [
          repo.namesByDishIds(eligibleIds),
          repo.descriptionsByDishIds(eligibleIds),
          repo.ingredientsByDishIds(eligibleIds),
          repo.placesByDishIds(eligibleIds),
          repo.categoriesByDishIds(eligibleIds),
          repo.cuisinesByDishIds(eligibleIds),
        ] as const,
        { concurrency: "unbounded" },
      ),
    );

    const [nameRows, descriptionRows, ingredientRows, placeRows, categoryRows, cuisineRows] =
      relations;

    const ingredientIds = [...new Set(ingredientRows.map((row) => row.ingredient_id))];
    const placeIds = [...new Set(placeRows.map((row) => row.place_id))];

    const [ingredientNameRows, placeNameRows] = yield* Effect.all(
      [
        ingredientIds.length > 0
          ? Effect.flatMap(IngredientRepository, (repo) => repo.namesByIngredientIds(ingredientIds))
          : Effect.succeed([] as const),
        placeIds.length > 0
          ? Effect.flatMap(PlaceRepository, (repo) => repo.namesByPlaceIds(placeIds))
          : Effect.succeed([] as const),
      ] as const,
      { concurrency: "unbounded" },
    );

    const groupByDishId = <Row>(rows: ReadonlyArray<Row>, key: (row: Row) => bigint) => {
      const groups = new Map<string, Array<Row>>();

      for (const row of rows) {
        const groupKey = key(row).toString();
        const existing = groups.get(groupKey);

        if (existing === undefined) {
          groups.set(groupKey, [row]);
        } else {
          existing.push(row);
        }
      }

      return groups;
    };

    const namesByDish = groupByDishId(nameRows, (row) => row.dish_id);
    const descriptionsByDish = groupByDishId(descriptionRows, (row) => row.dish_id);
    const ingredientsByDish = groupByDishId(ingredientRows, (row) => row.dish_id);
    const categoriesByDish = groupByDishId(categoryRows, (row) => row.dish_id);
    const cuisinesByDish = groupByDishId(cuisineRows, (row) => row.dish_id);

    const ingredientNamesByIngredient = groupByDishId(
      ingredientNameRows,
      (row) => row.ingredient_id,
    );

    const locale = input.eligibility.locale;
    const details: Array<AgentDishDetail> = [];

    for (const id of eligibleIds) {
      const key = id.toString();
      const poolRow = poolById.get(key);

      if (poolRow === undefined) {
        omittedIds.push(key);
        continue;
      }

      const names = namesByDish.get(key) ?? [];
      const display = pickDisplayName(names.map(asLocalizedName), locale);

      const descriptions = descriptionsByDish.get(key) ?? [];
      const pickedDescription =
        descriptions.find((entry) => entry.language_tag === locale) ??
        descriptions.find((entry) => entry.language_tag === "en") ??
        descriptions[0];

      const dishIngredients = (ingredientsByDish.get(key) ?? []).slice(0, MAX_INGREDIENT_NAMES);
      const ingredientNames: Array<string> = [];

      for (const entry of dishIngredients) {
        const labels = (ingredientNamesByIngredient.get(entry.ingredient_id.toString()) ?? []).map(
          asLocalizedName,
        );
        const picked = pickDisplayName(labels, locale);

        if (picked !== undefined && !ingredientNames.includes(picked.name)) {
          ingredientNames.push(picked.name);
        }
      }

      const relationCategories = (categoriesByDish.get(key) ?? []).map((row) => row.slug);

      details.push({
        categories:
          relationCategories.length > 0 ? relationCategories : nonNullStrings(poolRow.categories),
        cuisines: (cuisinesByDish.get(key) ?? []).map((row) => row.slug),
        description: pickedDescription
          ? (pickedDescription.description ?? pickedDescription.summary)
          : poolRow.description,
        id: key,
        ingredients: ingredientNames,
        name: display?.name ?? poolRow.name,
        regionLabel: input.eligibility.regionLabel,
      });
    }

    return DetailsToolOutcome.Resolved({
      details,
      omittedIds,
      servedIds: details.map((detail) => detail.id),
    });
  });

/**
 * Provider-facing JSON Schemas for the two catalog tools (workstream B
 * attaches these to the model request). Hand-written: no new deps, and the
 * parity test pins every bound against the Zod schemas above so the two
 * can never drift (same pattern as `meta-schema-parity`).
 */
export const SEARCH_DISHES_JSON_SCHEMA = {
  type: "object",
  properties: {
    cuisine: { type: "string", maxLength: 80 },
    category: { type: "string", maxLength: 80 },
    query: { type: "string", maxLength: 200 },
    cursor: { type: "string", maxLength: 500 },
    limit: { type: "integer", minimum: 1, maximum: 30 },
  },
  additionalProperties: false,
} as const;

export const GET_DISH_DETAILS_JSON_SCHEMA = {
  type: "object",
  properties: {
    ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
  },
  required: ["ids"],
  additionalProperties: false,
} as const;
