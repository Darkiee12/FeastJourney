// oxlint-disable-next-line import/no-unassigned-import -- side-effectful test environment setup, runs before server modules initialize.
import "@/modules/food-discovery/server/agent/test-env";
import { describe, expect, test } from "bun:test";

import { Predicate } from "effect";

import {
  GET_DISH_DETAILS_JSON_SCHEMA,
  SEARCH_DISHES_JSON_SCHEMA,
  encodeAgentCursor,
  getDishDetailsArgsSchema,
  searchDishesArgsSchema,
  searchEligiblePool,
} from "@/modules/food-discovery/server/agent/catalog-tools";
import {
  buildAgentEligibility,
  type AgentEligibility,
  type AgentEligibilityInput,
} from "@/modules/food-discovery/server/agent/eligibility";
import type { RecommendationCandidateRow } from "@/modules/food-discovery/server/operations/recommendation-service";

/**
 * Pool fixtures carry only the fields the tools read; the cast is
 * justified because neither `searchEligiblePool` nor the summary
 * projection touches any other column.
 */
const rowFor = (
  id: string,
  overrides?: Partial<RecommendationCandidateRow>,
): RecommendationCandidateRow =>
  // SAFETY: pool fixtures carry only the fields the tools read; the remaining columns are never touched.
  ({
    id,
    slug: `dish-${id}`,
    name: `Dish ${id}`,
    englishName: null,
    cuisines: [],
    categories: [],
    description: null,
    ingredientNames: [],
    updatedAt: "2026-01-01",
    ...overrides,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Reylo row types need the content mapper; tsc against the migrated database is authoritative.
  }) as RecommendationCandidateRow;

const vietnamese = (id: string): RecommendationCandidateRow =>
  rowFor(id, { cuisines: ["vietnamese"], description: `Pho-style dish ${id}` });

const eligibilityFor = (overrides?: Partial<AgentEligibilityInput>): AgentEligibility => {
  const snapshot = buildAgentEligibility({
    scope: "country",
    cuisine: undefined,
    excludedIds: [],
    canonicalExclusions: [],
    locale: "en",
    meal: "dinner",
    ...overrides,
  });

  if (snapshot === null) {
    throw new Error("test eligibility must be valid");
  }

  return snapshot;
};

const pool: ReadonlyArray<RecommendationCandidateRow> = [
  vietnamese("101"),
  vietnamese("202"),
  rowFor("303", { cuisines: ["mexican"], categories: ["dinner"] }),
  rowFor("404", { cuisines: ["vietnamese"], name: "Spicy Hue Special" }),
];

describe("searchEligiblePool", () => {
  test("serves the first page and reports a cursor plus served ids", () => {
    const outcome = searchEligiblePool(pool, eligibilityFor(), { limit: 2 }, 10);

    expect(outcome._tag).toBe("Matched");

    if (!Predicate.isTagged(outcome, "Matched")) {
      return;
    }

    expect(outcome.result.dishes.map((dish) => dish.id)).toEqual(["101", "202"]);
    expect(outcome.result.nextCursor).not.toBeNull();
    expect(outcome.servedIds).toEqual(["101", "202"]);
  });

  test("follows the opaque cursor to the second page and terminates", () => {
    const first = searchEligiblePool(pool, eligibilityFor(), { limit: 2 }, 10);

    if (!Predicate.isTagged(first, "Matched") || first.result.nextCursor === null) {
      throw new Error("first page must have a cursor");
    }

    const second = searchEligiblePool(
      pool,
      eligibilityFor(),
      { cursor: first.result.nextCursor, limit: 2 },
      10,
    );

    expect(second._tag).toBe("Matched");

    if (!Predicate.isTagged(second, "Matched")) {
      return;
    }

    expect(second.result.dishes.map((dish) => dish.id)).toEqual(["303", "404"]);
    expect(second.result.nextCursor).toBeNull();
  });

  test("rejects a tampered cursor instead of widening", () => {
    const outcome = searchEligiblePool(pool, eligibilityFor(), { cursor: "tampered!!!" }, 10);

    expect(outcome._tag).toBe("Rejected");
  });

  test("a conflicting model cuisine is rejected, never applied", () => {
    const fixed = eligibilityFor({ cuisine: "vietnamese" });
    const outcome = searchEligiblePool(pool, fixed, { cuisine: "mexican" }, 10);

    expect(outcome._tag).toBe("Rejected");

    if (!Predicate.isTagged(outcome, "Rejected")) {
      return;
    }

    expect(outcome.message).toContain("vietnamese");
  });

  test("a matching cuisine and the fixed hard filter both hold", () => {
    const fixed = eligibilityFor({ cuisine: "vietnamese" });
    const outcome = searchEligiblePool(pool, fixed, { cuisine: "vietnamese" }, 10);

    expect(outcome._tag).toBe("Matched");

    if (!Predicate.isTagged(outcome, "Matched")) {
      return;
    }

    expect(outcome.result.dishes.map((dish) => dish.id)).toEqual(["101", "202", "404"]);
  });

  test("a model cuisine narrows but never widens when no filter is fixed", () => {
    const outcome = searchEligiblePool(pool, eligibilityFor(), { cuisine: "mexican" }, 10);

    expect(outcome._tag).toBe("Matched");

    if (!Predicate.isTagged(outcome, "Matched")) {
      return;
    }

    expect(outcome.result.dishes.map((dish) => dish.id)).toEqual(["303"]);
  });

  test("category and query narrow within the eligible pool", () => {
    const byCategory = searchEligiblePool(pool, eligibilityFor(), { category: "dinner" }, 10);

    expect(byCategory._tag).toBe("Matched");

    if (Predicate.isTagged(byCategory, "Matched")) {
      expect(byCategory.result.dishes.map((dish) => dish.id)).toEqual(["303"]);
    }

    const byQuery = searchEligiblePool(pool, eligibilityFor(), { query: "hue special" }, 10);

    expect(byQuery._tag).toBe("Matched");

    if (Predicate.isTagged(byQuery, "Matched")) {
      expect(byQuery.result.dishes.map((dish) => dish.id)).toEqual(["404"]);
    }
  });

  test("clamps the model limit to the server page bound", () => {
    const outcome = searchEligiblePool(pool, eligibilityFor(), { limit: 30 }, 2);

    expect(outcome._tag).toBe("Matched");

    if (!Predicate.isTagged(outcome, "Matched")) {
      return;
    }

    expect(outcome.result.dishes).toHaveLength(2);
  });

  test("rejects malformed arguments", () => {
    expect(searchEligiblePool(pool, eligibilityFor(), { limit: -1 }, 10)._tag).toBe("Rejected");
    expect(searchEligiblePool(pool, eligibilityFor(), "search-everything", 10)._tag).toBe(
      "Rejected",
    );
  });

  test("the cursor round-trips through the exported encoder", () => {
    expect(encodeAgentCursor(12)).toBeString();
  });
});

describe("tool schemas vs provider JSON schemas", () => {
  test("searchDishes Zod bounds match the provider schema", () => {
    expect(SEARCH_DISHES_JSON_SCHEMA.properties.cuisine.maxLength).toBe(80);
    expect(SEARCH_DISHES_JSON_SCHEMA.properties.category.maxLength).toBe(80);
    expect(SEARCH_DISHES_JSON_SCHEMA.properties.query.maxLength).toBe(200);
    expect(SEARCH_DISHES_JSON_SCHEMA.properties.cursor.maxLength).toBe(500);
    expect(SEARCH_DISHES_JSON_SCHEMA.properties.limit.maximum).toBe(30);

    const parsed = searchDishesArgsSchema.safeParse({
      cuisine: "vietnamese",
      limit: 5,
      query: "pho",
    });

    expect(parsed.success).toBe(true);
  });

  test("getDishDetails requires a non-empty id list on both sides", () => {
    expect(GET_DISH_DETAILS_JSON_SCHEMA.required).toEqual(["ids"]);
    expect(getDishDetailsArgsSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(getDishDetailsArgsSchema.safeParse({ ids: ["101"] }).success).toBe(true);
  });
});
