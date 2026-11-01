import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { SQL } from "bun";
import { Effect, Layer, ManagedRuntime } from "effect";

import type { DishSummary } from "@/modules/food-discovery/server/domain/dish";
import { CatalogServicesLive, RepositoriesLive } from "@/modules/food-discovery/server/index";
import { CatalogImportServiceLive } from "@/modules/food-discovery/server/operations/catalog-import-service";
import { CurationServiceLive } from "@/modules/food-discovery/server/operations/curation-service";
import {
  RankingProvenance,
  type RecommendDishesInput,
  RecommendationMisconfigured,
  RecommendationOutcome,
  RecommendationService,
  RecommendationServiceLive,
  toWireOutcome,
} from "@/modules/food-discovery/server/operations/recommendation-service";
import { IngredientRepository } from "@/modules/food-discovery/server/repository/ingredient-repository";
import { Actor } from "@/server/auth/actor";
import { withActor } from "@/server/auth/current-actor";
import { DatabaseLive, type Database } from "@/server/database/client";
import { resetServerEnvCache } from "@/server/env";
import {
  MetaClient,
  type MetaError,
  MetaAuthError,
  MetaInvalidOutput,
  type MetaRankCandidate,
  type MetaRankContext,
  type MuseRankingConfig,
  MetaPermanentError,
  MetaRateLimited,
  MetaRequestError,
} from "@/server/integrations/meta-client";

// Recommendation tests use the real database with a fake MetaClient injected
// per runtime. The live MetaClientLive is never provided, so no test can
// reach the network; fakes that must stay silent fail loudly if invoked.
const CurationLive = Layer.provide(CurationServiceLive, RepositoriesLive);

const DomainLive = Layer.provide(
  Layer.mergeAll(CatalogServicesLive, CatalogImportServiceLive),
  Layer.mergeAll(RepositoriesLive, CurationLive),
);

type RankImpl = (
  candidates: ReadonlyArray<MetaRankCandidate>,
  context: MetaRankContext,
  config: MuseRankingConfig,
) => Effect.Effect<ReadonlyArray<string>, MetaError>;

const makeRuntime = (rank: RankImpl) => {
  const fakeMeta = Layer.succeed(MetaClient, { rank });

  const recommendationLive = Layer.provide(
    RecommendationServiceLive,
    Layer.mergeAll(RepositoriesLive, fakeMeta),
  );

  return ManagedRuntime.make(
    Layer.mergeAll(
      DatabaseLive,
      RepositoriesLive,
      CurationLive,
      DomainLive,
      recommendationLive,
      fakeMeta,
    ),
  );
};

type TestRuntime = ReturnType<typeof makeRuntime>;

type TestServices = Database | IngredientRepository | RecommendationService | MetaClient;

const runtimes: Array<TestRuntime> = [];

const track = (runtime: TestRuntime): TestRuntime => {
  runtimes.push(runtime);

  return runtime;
};

const runOn = <A, E>(runtime: TestRuntime, effect: Effect.Effect<A, E, TestServices>): Promise<A> =>
  runtime.runPromise(effect);

interface RankingEnvOverrides {
  readonly provider?: string | undefined;
  readonly key?: string | undefined;
  readonly outputLimit?: string | undefined;
  readonly candidateLimit?: string | undefined;
}

const withRankingEnv = (overrides: RankingEnvOverrides): void => {
  if (overrides.provider === undefined) {
    delete process.env.RECOMMENDATION_PROVIDER;
  } else {
    process.env.RECOMMENDATION_PROVIDER = overrides.provider;
  }

  if (overrides.key === undefined) {
    delete process.env.MODEL_API_KEY;
  } else {
    process.env.MODEL_API_KEY = overrides.key;
  }

  if (overrides.outputLimit === undefined) {
    delete process.env.MODEL_OUTPUT_LIMIT;
  } else {
    process.env.MODEL_OUTPUT_LIMIT = overrides.outputLimit;
  }

  if (overrides.candidateLimit === undefined) {
    delete process.env.MODEL_CANDIDATE_LIMIT;
  } else {
    process.env.MODEL_CANDIDATE_LIMIT = overrides.candidateLimit;
  }

  resetServerEnvCache();
};

const baseInput: RecommendDishesInput = {
  meal: "anything",
  excludedIngredients: [],
  cuisine: undefined,
  country: undefined,
  mood: "any",
  locale: "en",
  surpriseSeed: 0,
};

const modeOf = (outcome: RecommendationOutcome): string =>
  RecommendationOutcome.$match(outcome, {
    ReadyMuse: () => "ai",
    ReadyDeterministic: () => "deterministic",
    Uncertain: () => "uncertain",
    Empty: () => "empty",
  });

const dishesOf = (outcome: RecommendationOutcome): Array<DishSummary> =>
  RecommendationOutcome.$match(outcome, {
    ReadyMuse: ({ dishes }) => [...dishes],
    ReadyDeterministic: ({ dishes }) => [...dishes],
    Uncertain: () => [],
    Empty: () => [],
  });

const warningsOf = (outcome: RecommendationOutcome): Array<string> =>
  RecommendationOutcome.$match(outcome, {
    ReadyMuse: ({ warnings }) => [...warnings],
    ReadyDeterministic: ({ warnings }) => [...warnings],
    Uncertain: () => [],
    Empty: () => [],
  });

const reasonsOf = (outcome: RecommendationOutcome): Array<string> =>
  RecommendationOutcome.$match(outcome, {
    ReadyMuse: () => [],
    ReadyDeterministic: () => [],
    Uncertain: ({ reasons }) => [...reasons],
    Empty: ({ reasons }) => [...reasons],
  });

const servedOf = (outcome: RecommendationOutcome): string | undefined =>
  toWireOutcome(outcome).servedScope;

/**
 * Seeded Hanoi locality id (read-only lookup, no fixtures): the seed links
 * dishes to countries only, so the Hanoi city subtree is an empty pool with
 * a VN country hint — exactly the honest-fallback contract shape.
 */
const hanoiPlaceId = async (): Promise<string> => {
  const sql = new SQL(process.env.DATABASE_URL ?? "");

  try {
    const rows = await sql<Array<{ id: string }>>`
      SELECT p.id::text AS id FROM feastjourney.places AS p
      JOIN feastjourney.place_names AS pn ON pn.place_id = p.id
      WHERE p.kind = 'locality' AND pn.name = 'Hanoi' AND pn.is_preferred LIMIT 1`;

    const id = rows[0]?.id;

    if (id === undefined) {
      throw new Error("seeded Hanoi locality is missing");
    }

    return id;
  } finally {
    await sql.end();
  }
};

const recommendOn = (runtime: TestRuntime, input: RecommendDishesInput) =>
  runOn(
    runtime,
    Effect.flatMap(RecommendationService, (service) => service.recommend(input)),
  );

/**
 * Member-scoped recommendations: Muse-eligible path. Guest callers always
 * take the deterministic branch even when a provider is configured.
 */
const recommendAsMember = (runtime: TestRuntime, input: RecommendDishesInput) =>
  runOn(
    runtime,
    withActor(
      Actor.Member({ userId: "test-member" }),
      Effect.flatMap(RecommendationService, (service) => service.recommend(input)),
    ),
  );

const recommendOrFailure = async (
  runtime: TestRuntime,
  input: RecommendDishesInput,
): Promise<{ readonly outcome: RecommendationOutcome | null; readonly failure: unknown }> => {
  try {
    return { outcome: await recommendAsMember(runtime, input), failure: null };
  } catch (failure) {
    return { outcome: null, failure };
  }
};

const silentRank =
  (counter: { calls: number }): RankImpl =>
  () => {
    counter.calls += 1;

    return Effect.fail(new MetaRequestError({ reason: "MetaClient must not be called" }));
  };

describe("dish recommendations", () => {
  test("serves the deterministic baseline without a provider", async () => {
    withRankingEnv({});
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    const outcome = await recommendOn(runtime, baseInput);

    expect(modeOf(outcome)).toBe("deterministic");
    expect(counter.calls).toBe(0);

    const dishes = dishesOf(outcome);
    expect(dishes).toHaveLength(10);

    const slugs = dishes.map((dish) => dish.slug);
    expect(slugs).toContain("pho");

    const warnings = warningsOf(outcome);
    expect(warnings.some((warning) => warning.includes("not configured"))).toBe(true);

    const again = await recommendOn(runtime, baseInput);
    expect(dishesOf(again).map((dish) => dish.id)).toEqual(dishes.map((dish) => dish.id));
  });

  test("excludes dishes with avoided ingredients", async () => {
    withRankingEnv({});
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    const resolved = await runOn(
      runtime,
      Effect.flatMap(IngredientRepository, (repository) =>
        repository.resolveByKey("beef", "en", 1),
      ),
    );

    expect(resolved.length).toBeGreaterThan(0);

    const outcome = await recommendOn(runtime, { ...baseInput, excludedIngredients: ["beef"] });
    const slugs = dishesOf(outcome).map((dish) => dish.slug);

    expect(slugs).not.toContain("pho");
    expect(slugs).not.toContain("pho-bo");
    expect(modeOf(outcome)).toBe("deterministic");
  });

  test("applies cuisine and country filters", async () => {
    withRankingEnv({});
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    const vietnamese = await recommendOn(runtime, { ...baseInput, cuisine: "vietnamese" });
    const vietnameseSlugs = dishesOf(vietnamese).map((dish) => dish.slug);
    expect(vietnameseSlugs).toContain("pho");
    expect(vietnameseSlugs).not.toContain("sushi");

    const japanese = await recommendOn(runtime, { ...baseInput, cuisine: "japanese" });
    const japaneseSlugs = dishesOf(japanese).map((dish) => dish.slug);
    expect(japaneseSlugs).toContain("sushi");
    expect(japaneseSlugs).not.toContain("pho");

    const vietnam = await recommendOn(runtime, { ...baseInput, country: "VN" });
    const vietnamSlugs = dishesOf(vietnam).map((dish) => dish.slug);
    expect(vietnamSlugs).toContain("pho");
  });

  test("respects the candidate cap", async () => {
    withRankingEnv({ candidateLimit: "3" });
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    try {
      const outcome = await recommendOn(runtime, baseInput);
      expect(dishesOf(outcome).length).toBeLessThanOrEqual(3);
    } finally {
      withRankingEnv({});
    }
  });

  test("applies multiple exclusions together", async () => {
    withRankingEnv({});
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    const baseline = dishesOf(await recommendOn(runtime, baseInput)).map((dish) => dish.slug);

    expect(baseline).toContain("pho");

    const outcome = await recommendOn(runtime, {
      ...baseInput,
      excludedIngredients: ["beef", "egg"],
    });

    const slugs = dishesOf(outcome).map((dish) => dish.slug);

    expect(modeOf(outcome)).toBe("deterministic");
    expect(slugs).not.toContain("pho");
    expect(slugs).not.toContain("pho-bo");
    // The window refills from the pool after exclusions, so the count can
    // stay flat on a large catalog — but exclusions must never add dishes.
    expect(slugs.length).toBeLessThanOrEqual(baseline.length);
  });

  test("resolves ingredient aliases to the same exclusion", async () => {
    withRankingEnv({});
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    // "coriander leaves" is a seeded alias of cilantro, a pho garnish that
    // pho-bo does not carry: alias resolution removes pho but keeps pho-bo.
    const outcome = await recommendOn(runtime, {
      ...baseInput,
      excludedIngredients: ["coriander leaves"],
    });

    const slugs = dishesOf(outcome).map((dish) => dish.slug);

    expect(modeOf(outcome)).toBe("deterministic");
    expect(slugs).not.toContain("pho");
    expect(slugs).toContain("pho-bo");
    expect(
      warningsOf(outcome).some((warning) => warning.includes("Could not match exclusion")),
    ).toBe(false);
  });

  test("never refuses on exclusion terms (legacy allergy refusal removed)", async () => {
    withRankingEnv({ provider: "muse", key: "test-key" });
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    // Former allergy inputs are ordinary exclusions now: no Uncertain
    // outcome, and the provider IS consulted for members (the old
    // pre-provider refusal never fires).
    const termSets = [["beef"], ["unobtainium-xyz"], ["beef", "pork"]];

    const outcomes = await Promise.all(
      termSets.map(async (terms) =>
        recommendAsMember(runtime, { ...baseInput, excludedIngredients: terms }),
      ),
    );

    for (const outcome of outcomes) {
      expect(modeOf(outcome)).not.toBe("uncertain");
      expect(dishesOf(outcome).length).toBeGreaterThan(0);
    }

    expect(counter.calls).toBe(termSets.length);
  });

  test("warns per unresolvable term and still recommends", async () => {
    withRankingEnv({});
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    const outcome = await recommendOn(runtime, {
      ...baseInput,
      excludedIngredients: ["unobtainium-xyz"],
    });

    expect(modeOf(outcome)).toBe("deterministic");
    expect(dishesOf(outcome).length).toBeGreaterThan(0);
    expect(warningsOf(outcome)).toContain(
      'Could not match exclusion "unobtainium-xyz" to a known ingredient; it was not applied as a filter.',
    );
  });

  test("ranks with the fake AI client and hydrates from candidate rows", async () => {
    withRankingEnv({ provider: "muse", key: "test-key" });
    let calls = 0;
    let candidateKeys: Array<string> = [];
    let expectedIds: Array<string> = [];

    const runtime = track(
      makeRuntime((candidates, context, config) => {
        calls += 1;
        const first = candidates[0];

        if (first !== undefined) {
          candidateKeys = Object.keys(first).toSorted();
        }

        expectedIds = candidates
          .slice(0, 3)
          .toReversed()
          .map((candidate) => candidate.id);

        expect(context.occasion).toBe("dinner");
        expect(context.mood).toBe("comforting");
        expect(config.modelId).toBe("muse-spark-1.3");

        return Effect.succeed(expectedIds);
      }),
    );

    const outcome = await recommendAsMember(runtime, {
      ...baseInput,
      meal: "dinner",
      mood: "comforting",
    });

    expect(modeOf(outcome)).toBe("ai");
    expect(calls).toBe(1);
    expect(candidateKeys).toEqual(["categories", "cuisines", "description", "id", "name"]);

    const dishes = dishesOf(outcome);
    expect(dishes).toHaveLength(3);
    expect(dishes.map((dish) => dish.id)).toEqual(expectedIds);
    expect(dishes[0]?.name).toBeDefined();
    expect(dishes[0]?.slug.length).toBeGreaterThan(0);
    expect(dishes[0]?.categorySlugs.length).toBeGreaterThan(0);
  });

  test("muse receives current meal, mood, region, and exclusions over eligible-only candidates", async () => {
    withRankingEnv({ provider: "muse", key: "test-key" });

    const seen: Array<{
      readonly candidateIds: Array<string>;
      readonly context: MetaRankContext;
    }> = [];

    const runtime = track(
      makeRuntime((candidates, context) => {
        seen.push({
          candidateIds: candidates.map((candidate) => candidate.id),
          context: { ...context, excludedIngredients: [...context.excludedIngredients] },
        });

        return Effect.succeed(candidates.slice(0, 3).map((candidate) => candidate.id));
      }),
    );

    // Eligible pool from the deterministic path: the provider must only ever
    // see ids drawn from the post-exclusion pool.
    const eligibleFirst = dishesOf(
      await recommendOn(runtime, {
        ...baseInput,
        meal: "dinner",
        mood: "comforting",
        country: "VN",
        excludedIngredients: ["beef"],
      }),
    ).map((dish) => dish.id);

    expect(eligibleFirst.length).toBeGreaterThan(0);

    const first = await recommendAsMember(runtime, {
      ...baseInput,
      meal: "dinner",
      mood: "comforting",
      country: "VN",
      excludedIngredients: ["beef"],
    });

    expect(modeOf(first)).toBe("ai");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.context.occasion).toBe("dinner");
    expect(seen[0]?.context.mood).toBe("comforting");
    expect(seen[0]?.context.cuisineOrRegion).toBe("VN");
    expect(seen[0]?.context.excludedIngredients).toEqual(["beef"]);

    for (const id of seen[0]?.candidateIds ?? []) {
      expect(eligibleFirst).toContain(id);
    }

    expect(seen[0]?.candidateIds.length ?? 0).toBeLessThanOrEqual(10);

    // A second submission with different exclusions carries only the new
    // terms: no stale exclusions leak across calls.
    const eligibleSecond = dishesOf(
      await recommendOn(runtime, {
        ...baseInput,
        meal: "dinner",
        mood: "comforting",
        country: "VN",
        excludedIngredients: ["pork"],
      }),
    ).map((dish) => dish.id);

    const second = await recommendAsMember(runtime, {
      ...baseInput,
      meal: "dinner",
      mood: "comforting",
      country: "VN",
      excludedIngredients: ["pork"],
    });

    expect(modeOf(second)).toBe("ai");
    expect(seen).toHaveLength(2);
    expect(seen[1]?.context.excludedIngredients).toEqual(["pork"]);
    expect(seen[1]?.context.excludedIngredients).not.toContain("beef");

    for (const id of seen[1]?.candidateIds ?? []) {
      expect(eligibleSecond).toContain(id);
    }
  });

  test("rejects over-limit rankings independent of seed size", async () => {
    // A small outputLimit keeps this independent of catalog growth: the fake
    // returns limit+1 valid ids drawn from the received candidates, so the
    // over-limit verdict never depends on how many dishes exist.
    withRankingEnv({ provider: "muse", key: "test-key", outputLimit: "2" });
    const silent = track(makeRuntime(silentRank({ calls: 0 })));
    const baseline = dishesOf(await recommendOn(silent, baseInput)).map((dish) => dish.id);
    expect(baseline.length).toBeGreaterThan(0);

    const overLimit = track(
      makeRuntime((candidates) => Effect.succeed(candidates.slice(0, 3).map((c) => c.id))),
    );

    const outcome = await recommendAsMember(overLimit, baseInput);

    expect(modeOf(outcome)).toBe("deterministic");
    expect(dishesOf(outcome).map((dish) => dish.id)).toEqual(baseline.slice(0, 2));
    expect(warningsOf(outcome).some((warning) => warning.includes("deterministic order"))).toBe(
      true,
    );
  });

  test("accepts exactly-at-limit rankings", async () => {
    withRankingEnv({ provider: "muse", key: "test-key", outputLimit: "2" });

    const runtime = track(
      makeRuntime((candidates) => Effect.succeed(candidates.slice(0, 2).map((c) => c.id))),
    );

    const outcome = await recommendAsMember(runtime, baseInput);

    expect(modeOf(outcome)).toBe("ai");
    expect(dishesOf(outcome)).toHaveLength(2);
    expect(warningsOf(outcome)).toEqual([]);
  });

  test("falls back to deterministic order on transient and malformed AI output", async () => {
    withRankingEnv({ provider: "muse", key: "test-key" });
    const silent = track(makeRuntime(silentRank({ calls: 0 })));
    const baseline = dishesOf(await recommendOn(silent, baseInput)).map((dish) => dish.id);
    expect(baseline.length).toBeGreaterThan(0);

    const cases: Array<{ name: string; rank: RankImpl }> = [
      {
        name: "duplicate ids",
        rank: (candidates) => Effect.succeed([candidates[0]?.id ?? "", candidates[0]?.id ?? ""]),
      },
      {
        name: "unknown id",
        rank: () => Effect.succeed(["999999999"]),
      },
      {
        name: "empty ranking",
        rank: () => Effect.succeed([]),
      },
      {
        name: "invalid output",
        rank: () => Effect.fail(new MetaInvalidOutput({ reason: "canned malformed payload" })),
      },
      {
        name: "request error",
        rank: () => Effect.fail(new MetaRequestError({ reason: "canned 500", status: 500 })),
      },
      {
        name: "timeout",
        rank: () => Effect.fail(new MetaRequestError({ reason: "canned timeout" })),
      },
    ];

    const checkFallback = async (entry: { name: string; rank: RankImpl }) => {
      const runtime = track(makeRuntime(entry.rank));
      const outcome = await recommendAsMember(runtime, baseInput);

      expect(modeOf(outcome), entry.name).toBe("deterministic");
      expect(dishesOf(outcome).map((dish) => dish.id)).toEqual(baseline);
      expect(warningsOf(outcome).some((warning) => warning.includes("deterministic order"))).toBe(
        true,
      );
    };

    await Promise.all(cases.map((entry) => checkFallback(entry)));
  });

  test("degrades with a rate-limit warning instead of pretending to return 429", async () => {
    // The server-fn transport strips non-allowlisted response headers, so a
    // 429 + Retry-After cannot round-trip to the client. The service degrades
    // to deterministic order and says so; this test pins that limitation.
    withRankingEnv({ provider: "muse", key: "test-key" });
    const silent = track(makeRuntime(silentRank({ calls: 0 })));
    const baseline = dishesOf(await recommendOn(silent, baseInput)).map((dish) => dish.id);

    const runtime = track(
      makeRuntime(() =>
        Effect.fail(new MetaRateLimited({ reason: "canned 429", retryAfterSeconds: 30 })),
      ),
    );

    const outcome = await recommendAsMember(runtime, baseInput);

    expect(modeOf(outcome)).toBe("deterministic");
    expect(dishesOf(outcome).map((dish) => dish.id)).toEqual(baseline);
    expect(warningsOf(outcome).some((warning) => warning.includes("rate-limit"))).toBe(true);
  });

  test("fails loudly on auth and permanent provider failures", async () => {
    withRankingEnv({ provider: "muse", key: "test-key" });

    const auth = track(
      makeRuntime(() => Effect.fail(new MetaAuthError({ reason: "canned 401", status: 401 }))),
    );

    const authResult = await recommendOrFailure(auth, baseInput);
    expect(authResult.outcome).toBeNull();
    expect(authResult.failure).toBeInstanceOf(MetaAuthError);

    const permanent = track(
      makeRuntime(() => Effect.fail(new MetaPermanentError({ reason: "canned 400", status: 400 }))),
    );

    const permanentResult = await recommendOrFailure(permanent, baseInput);
    expect(permanentResult.outcome).toBeNull();
    expect(permanentResult.failure).toBeInstanceOf(MetaPermanentError);
  });

  test("fails loudly when muse is requested without valid configuration", async () => {
    withRankingEnv({ provider: "muse" });
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    const result = await recommendOrFailure(runtime, baseInput);

    expect(result.outcome).toBeNull();
    expect(result.failure).toBeInstanceOf(RecommendationMisconfigured);
    expect(counter.calls).toBe(0);
  });

  test("keeps deterministic order mood-free", async () => {
    withRankingEnv({});
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    // No catalog signal encodes mood, so mood must not change the order.
    const comforting = dishesOf(
      await recommendOn(runtime, { ...baseInput, mood: "comforting" }),
    ).map((dish) => dish.id);

    const light = dishesOf(await recommendOn(runtime, { ...baseInput, mood: "light" })).map(
      (dish) => dish.id,
    );

    expect(comforting.length).toBeGreaterThan(0);
    expect(light).toEqual(comforting);
    expect(counter.calls).toBe(0);
  });

  test("surprise seed 0 reproduces the deterministic baseline", async () => {
    withRankingEnv({});
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    const first = await recommendOn(runtime, baseInput);
    const again = await recommendOn(runtime, { ...baseInput, surpriseSeed: 0 });

    expect(dishesOf(again).map((dish) => dish.id)).toEqual(dishesOf(first).map((dish) => dish.id));
    expect(warningsOf(again).some((warning) => warning.includes("Surprise variety"))).toBe(false);
    expect(counter.calls).toBe(0);
  });

  test("surprise seed surfaces a different slice of the eligible pool", async () => {
    // Explicit small output window so the contract holds regardless of seed
    // catalog size: any pool larger than the limit yields a shifted slice.
    withRankingEnv({ outputLimit: "5" });
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    const baseline = dishesOf(await recommendOn(runtime, baseInput)).map((dish) => dish.id);
    expect(baseline).toHaveLength(5);

    const varied = dishesOf(await recommendOn(runtime, { ...baseInput, surpriseSeed: 1 })).map(
      (dish) => dish.id,
    );

    // Offset-1 window over the same ranking: drops the head, keeps the tail,
    // pulls in the next eligible candidate.
    expect(varied).toHaveLength(5);
    expect(varied).not.toEqual(baseline);
    expect(varied.slice(0, 4)).toEqual(baseline.slice(1));
    expect(baseline).not.toContain(varied[4]);

    const outcome = await recommendOn(runtime, { ...baseInput, surpriseSeed: 1 });

    expect(warningsOf(outcome).some((warning) => warning.includes("Surprise variety"))).toBe(true);
    expect(counter.calls).toBe(0);
  });

  test("surprise bypasses the provider even when one is configured", async () => {
    withRankingEnv({ provider: "muse", key: "test-key" });
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    const outcome = await recommendOn(runtime, { ...baseInput, surpriseSeed: 2 });

    expect(modeOf(outcome)).toBe("deterministic");
    expect(warningsOf(outcome).some((warning) => warning.includes("Surprise variety"))).toBe(true);
    expect(counter.calls).toBe(0);
  });

  test("surprise on a small pool returns the whole pool with an honest note", async () => {
    withRankingEnv({});
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    const baseline = dishesOf(await recommendOn(runtime, { ...baseInput, cuisine: "japanese" }));
    expect(baseline.length).toBeGreaterThan(0);

    const outcome = await recommendOn(runtime, {
      ...baseInput,
      cuisine: "japanese",
      surpriseSeed: 5,
    });

    expect(
      dishesOf(outcome)
        .map((dish) => dish.id)
        .toSorted(),
    ).toEqual(baseline.map((dish) => dish.id).toSorted());
    expect(warningsOf(outcome).some((warning) => warning.includes("Surprise variety"))).toBe(true);
    expect(counter.calls).toBe(0);
  });

  test("surprise seed keeps hard exclusions and merges former allergy terms", async () => {
    withRankingEnv({});

    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    const excluded = await recommendOn(runtime, {
      ...baseInput,
      excludedIngredients: ["beef"],
      surpriseSeed: 3,
    });

    expect(modeOf(excluded)).toBe("deterministic");
    expect(dishesOf(excluded).map((dish) => dish.slug)).not.toContain("pho");

    // Former allergy terms are ordinary exclusions now: no Uncertain
    // outcome, even on the surprise path.
    const merged = await recommendOn(runtime, {
      ...baseInput,
      excludedIngredients: ["peanuts"],
      surpriseSeed: 5,
    });

    expect(modeOf(merged)).not.toBe("uncertain");
    expect(dishesOf(merged).length).toBeGreaterThan(0);
    expect(
      warningsOf(merged).some((warning) => warning.includes("Could not match exclusion")),
    ).toBe(true);
    expect(counter.calls).toBe(0);
  });

  test("returns Empty when no dishes match", async () => {
    withRankingEnv({ provider: "muse", key: "test-key" });

    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    const outcome = await recommendOn(runtime, { ...baseInput, cuisine: "ethiopian" });

    expect(modeOf(outcome)).toBe("empty");
    expect(dishesOf(outcome)).toEqual([]);
    expect(reasonsOf(outcome).length).toBeGreaterThan(0);
    expect(counter.calls).toBe(0);
  });

  test("city with an empty pool falls back honestly to the country hint pool", async () => {
    withRankingEnv({});
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));
    const hanoi = await hanoiPlaceId();

    const outcome = await recommendOn(runtime, {
      ...baseInput,
      location: { kind: "city", placeId: hanoi, country: "VN" },
    });

    expect(modeOf(outcome)).toBe("deterministic");
    expect(servedOf(outcome)).toBe("country");

    const slugs = dishesOf(outcome).map((dish) => dish.slug);
    expect(slugs).toContain("pho");

    expect(warningsOf(outcome).some((warning) => warning.includes("across Vietnam"))).toBe(true);
    expect(counter.calls).toBe(0);
  });

  test("city and country both empty returns honest empty, never silent worldwide", async () => {
    withRankingEnv({});
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));
    const hanoi = await hanoiPlaceId();

    const outcome = await recommendOn(runtime, {
      ...baseInput,
      cuisine: "ethiopian",
      location: { kind: "city", placeId: hanoi, country: "VN" },
    });

    expect(modeOf(outcome)).toBe("empty");
    expect(dishesOf(outcome)).toEqual([]);
    expect(servedOf(outcome)).toBeUndefined();
    expect(toWireOutcome(outcome)).toEqual({
      mode: "empty",
      dishes: [],
      ranking: RankingProvenance.DeterministicCatalog(),
      reasons: reasonsOf(outcome),
      warnings: [],
    });

    const reasons = reasonsOf(outcome).join(" ");
    expect(reasons).toContain("Vietnam");
    expect(reasons).toContain("worldwide catalog");
    expect(reasons).not.toContain("showing worldwide dishes");
    expect(counter.calls).toBe(0);
  });

  test("city without a country hint and an empty pool returns honest empty", async () => {
    withRankingEnv({});
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));
    const hanoi = await hanoiPlaceId();

    const outcome = await recommendOn(runtime, {
      ...baseInput,
      location: { kind: "city", placeId: hanoi },
    });

    expect(modeOf(outcome)).toBe("empty");
    expect(dishesOf(outcome)).toEqual([]);
    expect(servedOf(outcome)).toBeUndefined();
    expect(reasonsOf(outcome).join(" ")).toContain("mapped to this city yet");
    expect(counter.calls).toBe(0);
  });

  test("worldwide-explicit requests keep serving the worldwide pool", async () => {
    withRankingEnv({});
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    const outcome = await recommendOn(runtime, {
      ...baseInput,
      location: { kind: "worldwide" },
    });

    expect(modeOf(outcome)).toBe("deterministic");
    expect(servedOf(outcome)).toBe("worldwide");
    expect(dishesOf(outcome).length).toBeGreaterThan(0);
    expect(counter.calls).toBe(0);
  });

  test("returns the whole pool when fewer than ten dishes match", async () => {
    withRankingEnv({});
    const counter = { calls: 0 };
    const runtime = track(makeRuntime(silentRank(counter)));

    const outcome = await recommendOn(runtime, { ...baseInput, cuisine: "japanese" });
    const slugs = dishesOf(outcome).map((dish) => dish.slug);

    expect(modeOf(outcome)).toBe("deterministic");
    expect(slugs.length).toBeLessThan(10);
    expect(slugs).toContain("sushi");
    expect(slugs).toContain("ramen");
  });
});

const dish = (id: string): DishSummary => ({
  id,
  slug: `dish-${id}`,
  name: `Dish ${id}`,
  englishName: undefined,
  regionNames: [],
  categorySlugs: ["dinner"],
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastUpdate: 1767225600,
});

describe("recommendation wire mapping", () => {
  test("maps ReadyMuse to the ai envelope", () => {
    expect(
      toWireOutcome(
        RecommendationOutcome.ReadyMuse({
          dishes: [dish("1")],
          ranking: RankingProvenance.LiveMuse(),
          warnings: ["w"],
          servedScope: "country",
        }),
      ),
    ).toEqual({
      mode: "ai",
      dishes: [dish("1")],
      ranking: RankingProvenance.LiveMuse(),
      reasons: [],
      warnings: ["w"],
      servedScope: "country",
    });
  });

  test("maps ReadyDeterministic to the deterministic envelope", () => {
    expect(
      toWireOutcome(
        RecommendationOutcome.ReadyDeterministic({
          dishes: [dish("1")],
          ranking: RankingProvenance.DeterministicCatalog(),
          warnings: ["w"],
          servedScope: "city",
        }),
      ),
    ).toEqual({
      mode: "deterministic",
      dishes: [dish("1")],
      ranking: RankingProvenance.DeterministicCatalog(),
      reasons: [],
      warnings: ["w"],
      servedScope: "city",
    });
  });

  test("maps Uncertain to the uncertain envelope", () => {
    expect(toWireOutcome(RecommendationOutcome.Uncertain({ reasons: ["r"] }))).toEqual({
      mode: "uncertain",
      dishes: [],
      ranking: RankingProvenance.DeterministicCatalog(),
      reasons: ["r"],
      warnings: [],
    });
  });

  test("maps Empty to the empty envelope", () => {
    expect(toWireOutcome(RecommendationOutcome.Empty({ reasons: ["r"] }))).toEqual({
      mode: "empty",
      dishes: [],
      ranking: RankingProvenance.DeterministicCatalog(),
      reasons: ["r"],
      warnings: [],
    });
  });
});

let savedPoolMax: string | undefined;

beforeAll(() => {
  expect(process.env.DATABASE_URL).toBeDefined();
  // Each test builds its own ManagedRuntime with a Database pool. Capped at
  // 2 connections per runtime so the ~25 runtimes in this file stay far
  // below the disposable Postgres max_connections=100 budget.
  savedPoolMax = process.env["DATABASE_POOL_MAX"];
  process.env["DATABASE_POOL_MAX"] = "2";
  withRankingEnv({});
});

afterAll(async () => {
  withRankingEnv({});

  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));

  if (savedPoolMax === undefined) {
    delete process.env["DATABASE_POOL_MAX"];
  } else {
    process.env["DATABASE_POOL_MAX"] = savedPoolMax;
  }
});

// Each test builds its own ManagedRuntimes (tracked above) and must not
// hold their database pools past the test: ~25 runtimes kept alive until
// afterAll would stack ~50+ connections on top of the shared appRuntime
// pools and breach the disposable Postgres max_connections=100 budget,
// surfacing as DatabaseUnavailable in later tests. Disposing here bounds
// live runtimes to those of the running test.
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});
