import { describe, expect, test } from "bun:test";

import {
  cacheKeyInputFor,
  DISH_RECOMMENDATIONS_KEY,
  geographicScopeKeyFor,
  normalizeCacheTerms,
  RECOMMENDATION_CACHE_VERSION,
  recommendationCacheKey,
  toCoarseSnapshot,
  type JourneyWriteModel,
  type RecommendPayload,
} from "@/components/home/recommend/quiz-model";

/**
 * Agent C — ranking-cache key + restoration pins (PR §7).
 *
 * DB-free and DOM-free: pure key builders and the coarse snapshot. These
 * are the mechanical guarantees behind "Back restores with ZERO new Meta
 * calls": same canonical request → same key → QueryClient serves the entry
 * instead of refiring; prefs/identity/locale/scope/seed changes key
 * differently and fetch exactly once.
 */

const payloadFor = (overrides?: Partial<RecommendPayload>): RecommendPayload => ({
  meal: "dinner",
  excludedIngredients: ["pork", "cilantro"],
  mood: "comforting",
  locale: "en",
  surpriseSeed: 0,
  ...overrides,
});

const near = (latitude: number, longitude: number): RecommendPayload =>
  payloadFor({
    location: { kind: "precise", latitude, longitude, accuracy: 10 },
  });

const keyFor = (payload: RecommendPayload, userIdOrGuest: string) =>
  recommendationCacheKey(cacheKeyInputFor(payload, userIdOrGuest));

describe("normalizeCacheTerms", () => {
  test("lowercases, trims, dedupes, and sorts so cosmetic typing never refires", () => {
    expect(normalizeCacheTerms(["Pork", "pork ", " CILANTRO", "cilantro"])).toEqual([
      "cilantro",
      "pork",
    ]);
  });

  test("drops blanks", () => {
    expect(normalizeCacheTerms(["", "  ", "pork"])).toEqual(["pork"]);
  });
});

describe("geographicScopeKeyFor", () => {
  test("worldwide payloads key as world", () => {
    expect(geographicScopeKeyFor(payloadFor({ location: { kind: "worldwide" } }))).toBe("world");
  });

  test("country payloads key as uppercase ISO", () => {
    expect(
      geographicScopeKeyFor(payloadFor({ location: { kind: "destination", country: "VN" } })),
    ).toBe("country:VN");
  });

  test("city payloads key as the canonical place id", () => {
    expect(
      geographicScopeKeyFor(
        payloadFor({ location: { kind: "city", placeId: "123" }, country: undefined }),
      ),
    ).toBe("city:123");
  });

  test("precise fixes round to coarse cells: jitter shares, moves differ", () => {
    expect(geographicScopeKeyFor(near(10.7761, 106.7001))).toBe(
      geographicScopeKeyFor(near(10.7764, 106.7004)),
    );
    expect(geographicScopeKeyFor(near(10.77, 106.7))).not.toBe(
      geographicScopeKeyFor(near(11.95, 108.43)),
    );
  });

  test("precise keys carry no raw high-precision coordinates", () => {
    const key = geographicScopeKeyFor(
      payloadFor({
        location: { kind: "precise", latitude: 10.77653, longitude: 106.70092, accuracy: 8 },
      }),
    );

    expect(key).not.toContain("10.77653");
    expect(key).not.toContain("106.70092");
  });
});

describe("recommendationCacheKey", () => {
  test("identical canonical requests share one key (Back = zero new calls)", () => {
    const first = keyFor(payloadFor(), "member-1");

    const second = keyFor(
      payloadFor({ excludedIngredients: [" cilantro", "PORK", "pork"] }),
      "member-1",
    );

    expect(second).toEqual(first);
  });

  test("per-user isolation: member and guest keys differ", () => {
    expect(keyFor(payloadFor(), "member-1")).not.toEqual(keyFor(payloadFor(), "guest"));
    expect(keyFor(payloadFor(), "member-1")).not.toEqual(keyFor(payloadFor(), "member-2"));
  });

  test("locale change keys differently (one fetch, never a double-fire)", () => {
    expect(keyFor(payloadFor(), "member-1")).not.toEqual(
      keyFor(payloadFor({ locale: "vi" }), "member-1"),
    );
  });

  test("prefs, scope, and seed changes key differently", () => {
    const base = keyFor(payloadFor(), "member-1");

    expect(keyFor(payloadFor({ excludedIngredients: ["beef"] }), "member-1")).not.toEqual(base);
    expect(
      keyFor(payloadFor({ location: { kind: "destination", country: "JP" } }), "member-1"),
    ).not.toEqual(base);
    expect(keyFor(payloadFor({ surpriseSeed: 1 }), "member-1")).not.toEqual(base);
    expect(keyFor(payloadFor({ meal: "lunch" }), "member-1")).not.toEqual(base);
  });

  test("key carries the root, contract version, and identity first", () => {
    const key = keyFor(payloadFor(), "member-1");

    expect(key[0]).toBe(DISH_RECOMMENDATIONS_KEY);
    expect(key[1]).toBe(RECOMMENDATION_CACHE_VERSION);
    expect(key[2]).toBe("member-1");
  });
});

const modelFor = (overrides?: Partial<JourneyWriteModel>): JourneyWriteModel => ({
  meal: "dinner",
  mood: "comforting",
  draft: {
    excludedRaw: "pork",
    regionMode: "country",
    country: "VN",
    countrySource: "chosen",
    precise: null,
    remember: false,
    cityId: null,
    cityLabel: null,
    cityCountry: null,
  },
  stepIndex: 2,
  submitted: payloadFor({ location: { kind: "destination", country: "VN" } }),
  showResults: true,
  surpriseSeed: 0,
  railIndex: 4,
  ...overrides,
});

describe("toCoarseSnapshot presentation state", () => {
  test("slide-4 Back restoration: selected slide survives the snapshot", () => {
    const snapshot = toCoarseSnapshot(modelFor({ railIndex: 3 }));

    expect(snapshot.showResults).toBe(true);
    expect(snapshot.railIndex).toBe(3);
    expect(snapshot.submitted).not.toBeNull();
  });

  test("precise results drop on snapshot (no stale geo rerun), slide resets", () => {
    const snapshot = toCoarseSnapshot(
      modelFor({
        draft: {
          excludedRaw: "",
          regionMode: "precise",
          country: "",
          countrySource: null,
          precise: { latitude: 10.77, longitude: 106.7, accuracy: 10 },
          remember: false,
          cityId: null,
          cityLabel: null,
          cityCountry: null,
        },
        submitted: payloadFor({
          location: { kind: "precise", latitude: 10.77, longitude: 106.7, accuracy: 10 },
        }),
      }),
    );

    expect(snapshot.submitted).toBeNull();
    expect(snapshot.showResults).toBe(false);
    expect(snapshot.railIndex).toBe(0);
  });

  test("quiz answers and presentation state stay separate fields", () => {
    const snapshot = toCoarseSnapshot(modelFor({ railIndex: 2 }));

    expect(snapshot.draft.excludedRaw).toBe("pork");
    expect(snapshot.railIndex).toBe(2);
  });
});
