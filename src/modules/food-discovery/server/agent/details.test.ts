import "@/modules/food-discovery/server/agent/test-env";
import { afterAll, describe, expect, test } from "bun:test";

import { SQL } from "bun";
import { Layer, ManagedRuntime } from "effect";

import {
  fetchDishDetails,
} from "@/modules/food-discovery/server/agent/catalog-tools";
import {
  buildAgentEligibility,
  type AgentEligibility,
} from "@/modules/food-discovery/server/agent/eligibility";
import { RepositoriesLive } from "@/modules/food-discovery/server/index";
import type { RecommendationCandidateRow } from "@/modules/food-discovery/server/operations/recommendation-service";
import { DatabaseLive } from "@/server/database/client";

/**
 * Integration coverage for getDishDetails against the seeded disposable
 * database with the real repositories: per-row isolation (one unknown id
 * cannot fail its siblings), bounded limits, and relation assembly.
 * Read-only: no fixtures are created, only seed rows are read.
 *
 * Skipped unless DATABASE_URL points at the loopback disposable database,
 * mirroring the guard in tests/integration/cleanup.ts.
 */

const hasLoopbackDb = (process.env.DATABASE_URL ?? "").includes("127.0.0.1");
const testDb = hasLoopbackDb ? test : test.skip;

const rowFor = (id: string, name: string): RecommendationCandidateRow =>
  ({
    id,
    slug: `dish-${id}`,
    name,
    englishName: null,
    cuisines: [],
    categories: [],
    description: null,
    ingredientNames: [],
    updatedAt: "2026-01-01",
  }) as RecommendationCandidateRow;

const eligibility: AgentEligibility = (() => {
  const snapshot = buildAgentEligibility({
    scope: "country",
    cuisine: "vietnamese",
    excludedIds: [],
    canonicalExclusions: [],
    locale: "en",
    meal: "dinner",
    regionLabel: "VN",
  });

  if (snapshot === null) {
    throw new Error("test eligibility must be valid");
  }

  return snapshot;
})();

const runtime = ManagedRuntime.make(Layer.mergeAll(DatabaseLive, RepositoriesLive));

afterAll(async () => {
  await runtime.dispose();
});

const seededDishIds = async (): Promise<ReadonlyArray<{ id: string; name: string }>> => {
  const sql = new SQL(process.env.DATABASE_URL ?? "");

  try {
    return await sql<ReadonlyArray<{ id: string; name: string }>>`
      SELECT d.id::text AS id, dn.name AS name
      FROM feastjourney.dishes AS d
      JOIN feastjourney.dish_names AS dn ON dn.dish_id = d.id
      WHERE d.status = 'published' AND dn.language_tag = 'en' AND dn.is_preferred
      ORDER BY d.id ASC LIMIT 2`;
  } finally {
    await sql.end();
  }
};

describe("fetchDishDetails (seeded database)", () => {
  testDb("resolves eligible ids with relations and the coarse region label", async () => {
    const seeds = await seededDishIds();

    expect(seeds.length).toBe(2);

    const first = seeds[0];
    const second = seeds[1];

    if (first === undefined || second === undefined) {
      throw new Error("seed catalog must hold two published dishes");
    }

    const pool = [rowFor(first.id, first.name), rowFor(second.id, second.name)];

    const outcome = await runtime.runPromise(
      fetchDishDetails({
        detailsPerCall: 10,
        eligibility,
        pool,
        rawArgs: { ids: [first.id, second.id] },
      }),
    );

    expect(outcome._tag).toBe("Resolved");

    if (outcome._tag !== "Resolved") {
      return;
    }

    expect(outcome.omittedIds).toEqual([]);
    expect(outcome.servedIds).toEqual([first.id, second.id]);
    expect(outcome.details).toHaveLength(2);

    for (const detail of outcome.details) {
      expect(detail.id.length).toBeGreaterThan(0);
      expect(detail.name.length).toBeGreaterThan(0);
      expect(detail.regionLabel).toBe("VN");
      expect(Array.isArray(detail.ingredients)).toBe(true);
      expect(Array.isArray(detail.cuisines)).toBe(true);
      expect(Array.isArray(detail.categories)).toBe(true);
    }
  });

  testDb("isolates an unserved id per row without failing its siblings", async () => {
    const seeds = await seededDishIds();
    const first = seeds[0];

    if (first === undefined) {
      throw new Error("seed catalog must hold a published dish");
    }

    const pool = [rowFor(first.id, first.name)];

    const outcome = await runtime.runPromise(
      fetchDishDetails({
        detailsPerCall: 10,
        eligibility,
        pool,
        rawArgs: { ids: [first.id, "999999999998"] },
      }),
    );

    expect(outcome._tag).toBe("Resolved");

    if (outcome._tag !== "Resolved") {
      return;
    }

    expect(outcome.details).toHaveLength(1);
    expect(outcome.details[0]?.id).toBe(first.id);
    expect(outcome.omittedIds).toEqual(["999999999998"]);
    expect(outcome.servedIds).toEqual([first.id]);
  });

  testDb("rejects duplicates, over-limit, malformed, and empty id lists", async () => {
    const seeds = await seededDishIds();
    const first = seeds[0];
    const second = seeds[1];

    if (first === undefined || second === undefined) {
      throw new Error("seed catalog must hold two published dishes");
    }

    const pool = [rowFor(first.id, first.name), rowFor(second.id, second.name)];

    const cases: ReadonlyArray<{ readonly args: unknown; readonly limit: number }> = [
      { args: { ids: [first.id, first.id] }, limit: 10 },
      { args: { ids: [first.id, second.id] }, limit: 1 },
      { args: { ids: ["not-a-decimal"] }, limit: 10 },
      { args: { ids: [] }, limit: 10 },
    ];

    for (const { args, limit } of cases) {
      const outcome = await runtime.runPromise(
        fetchDishDetails({ detailsPerCall: limit, eligibility, pool, rawArgs: args }),
      );

      expect(outcome._tag).toBe("Rejected");
    }
  });
});
