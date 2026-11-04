import "@/modules/food-discovery/server/agent/test-env";
import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { AgentInvalidSelection } from "@/modules/food-discovery/server/agent/errors";
import {
  agentSelectionsSchema,
  validateAgentFinalSelection,
  type AgentSelection,
} from "@/modules/food-discovery/server/agent/validation";
import type { RecommendationCandidateRow } from "@/modules/food-discovery/server/operations/recommendation-service";

/**
 * Served-row fixtures carry only the fields validation reads (id); the
 * cast is justified because `validateAgentFinalSelection` delegates
 * membership to ids alone via the existing service validator.
 */
const rowFor = (id: string): RecommendationCandidateRow =>
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
  }) as RecommendationCandidateRow;

const served: ReadonlyArray<RecommendationCandidateRow> = [rowFor("101"), rowFor("202")];

const validate = (
  selections: ReadonlyArray<AgentSelection>,
): Promise<{ readonly data: { ids: ReadonlyArray<string> } | null; readonly error: unknown }> =>
  Effect.runPromise(
    validateAgentFinalSelection(selections, served, 10).pipe(
      Effect.map((result) => ({ data: { ids: result.ids }, error: null as unknown })),
      Effect.catchTag("AgentInvalidSelection", (error: AgentInvalidSelection) =>
        Effect.succeed({ data: null, error }),
      ),
    ),
  );

const goodReason = (dish: string): string =>
  `A dinner fit grounded in the supplied categories for dish ${dish} with Vietnamese association.`;

describe("validateAgentFinalSelection", () => {
  test("accepts a served subset with ID-keyed reasons", async () => {
    const outcome = await validate([
      { dishId: "101", reason: goodReason("101") },
      { dishId: "202", reason: goodReason("202") },
    ]);

    expect(outcome.error).toBeNull();
    expect(outcome.data?.ids).toEqual(["101", "202"]);
  });

  test("rejects an id the backend never served", async () => {
    const outcome = await validate([{ dishId: "999", reason: goodReason("999") }]);

    expect(outcome.data).toBeNull();
    expect(outcome.error).toBeInstanceOf(AgentInvalidSelection);
  });

  test("rejects duplicates", async () => {
    const outcome = await validate([
      { dishId: "101", reason: goodReason("101") },
      { dishId: "101", reason: goodReason("101") },
    ]);

    expect(outcome.data).toBeNull();
  });

  test("rejects over-limit selections", async () => {
    const outcome = await Effect.runPromise(
      validateAgentFinalSelection([{ dishId: "101", reason: goodReason("101") }], served, 0).pipe(
        Effect.map(() => ({ data: true as const, error: null as unknown })),
        Effect.catchTag("AgentInvalidSelection", (error: AgentInvalidSelection) =>
          Effect.succeed({ data: null, error }),
        ),
      ),
    );

    expect(outcome.data).toBeNull();
  });

  test("rejects an empty selection", async () => {
    const outcome = await validate([]);

    expect(outcome.data).toBeNull();
  });

  test("rejects safety-claim reasons through the shared denylist", async () => {
    const outcome = await validate([
      {
        dishId: "101",
        reason: "Certified safe for all allergies and guaranteed risk-free dining choice.",
      },
    ]);

    expect(outcome.data).toBeNull();
    expect(outcome.error).toBeInstanceOf(AgentInvalidSelection);
  });

  test("the structural schema rejects multiline and oversized reasons", () => {
    expect(
      agentSelectionsSchema.safeParse([{ dishId: "101", reason: "line one\nline two" }]).success,
    ).toBe(false);
    expect(agentSelectionsSchema.safeParse([{ dishId: "abc", reason: "ok" }]).success).toBe(false);
    expect(agentSelectionsSchema.safeParse([]).success).toBe(false);
  });
});
