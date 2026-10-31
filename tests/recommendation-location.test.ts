import { describe, expect, test } from "bun:test";

import {
  buildSurprisePayload,
  draftFromSavedPrefs,
  draftLocation,
  EMPTY_DRAFT,
  formatAccuracyM,
  isExplicitRegionChoice,
  persistPrefs,
  readSavedPrefs,
  regionChoiceFor,
  scopeLabelFor,
  serializePrefs,
  toCoarseSnapshot,
  toTransportPayload,
  validateRegion,
  type QuizDraft,
} from "@/components/home/recommend/quiz-model";
import {
  accuracyLabelFor,
  classifyGeoError,
  fallbackOptionsFor,
  initialLocatorSnapshot,
  isPoorAccuracy,
  PreciseLocator,
  readLocatorEnvironment,
  type LocatorEnvironment,
  type LocatorPosition,
} from "@/components/home/recommend/use-precise-location";
import {
  recommendationLocationSchema,
  recommendationQuerySchema,
} from "@/modules/food-discovery/food.schema";
import {
  NEARBY_MAX_M,
  NEARBY_START_M,
  nearbyRadiiM,
} from "@/modules/food-discovery/server/operations/dish-service";
import {
  LocationScope,
  locationLogFields,
  resolveLocationScope,
  scopeCountryOf,
  toRankContext,
  type RecommendDishesInput,
} from "@/modules/food-discovery/server/operations/recommendation-service";
import { messagesFor } from "@/shared/i18n";

const copyEn = messagesFor("en");
const copyVi = messagesFor("vi");

const baseInput: RecommendDishesInput = {
  meal: "anything",
  avoid: [],
  allergies: [],
  cuisine: undefined,
  country: undefined,
  location: undefined,
  mood: "any",
  locale: "en",
  surpriseSeed: 0,
};

const successEnv = (position: LocatorPosition, code = 0): LocatorEnvironment => ({
  geolocation: {
    getCurrentPosition: (success, error) => {
      if (code === 0) {
        success(position);
      } else {
        error?.({ code });
      }
    },
  },
  secureContext: true,
});

const coords = (latitude: number, longitude: number, accuracy: number | null) => ({
  coords: { latitude, longitude, accuracy },
});

const preciseResult = (latitude: number, longitude: number, accuracy?: number) =>
  recommendationLocationSchema.safeParse(
    accuracy === undefined
      ? { kind: "precise", latitude, longitude }
      : { kind: "precise", latitude, longitude, accuracy },
  );

describe("recommendation location (phase 1 geography)", () => {
  test("defaults to anywhere with no country, source, or fix", () => {
    expect(EMPTY_DRAFT.regionMode).toBe("anywhere");
    expect(EMPTY_DRAFT.country).toBe("");
    expect(EMPTY_DRAFT.countrySource).toBeNull();
    expect(EMPTY_DRAFT.precise).toBeNull();
    expect(isExplicitRegionChoice(EMPTY_DRAFT)).toBe(false);
    expect(regionChoiceFor(EMPTY_DRAFT, "VN")).toBe("worldwide");
  });

  test("saved opt-in preference restores as an explicit chosen destination", () => {
    const saved = readSavedPrefs(() =>
      serializePrefs({ remember: true, avoid: ["cilantro"], country: "VN" }),
    );

    const draft = draftFromSavedPrefs(saved);

    expect(draft.regionMode).toBe("country");
    expect(draft.country).toBe("VN");
    expect(draft.countrySource).toBe("chosen");
    expect(isExplicitRegionChoice(draft)).toBe(true);
    expect(regionChoiceFor(draft, "VN")).toBe("destination");
  });

  test("an explicit journey choice stays explicit and beats trusted detection", () => {
    const chosen: QuizDraft = {
      ...EMPTY_DRAFT,
      regionMode: "country",
      country: "JP",
      countrySource: "chosen",
    };

    const detected: QuizDraft = {
      ...EMPTY_DRAFT,
      regionMode: "country",
      country: "VN",
      countrySource: "detected",
    };

    const precise: QuizDraft = {
      ...EMPTY_DRAFT,
      regionMode: "precise",
      precise: { latitude: 21.0278, longitude: 105.8342, accuracy: 40 },
    };

    expect(isExplicitRegionChoice(chosen)).toBe(true);
    expect(isExplicitRegionChoice(precise)).toBe(true);
    expect(isExplicitRegionChoice(detected)).toBe(false);
    expect(regionChoiceFor(chosen, "VN")).toBe("destination");
    expect(regionChoiceFor(detected, "VN")).toBe("home");
    expect(regionChoiceFor(precise, "VN")).toBe("precise");
  });

  test("untouched defaults stay non-explicit so async trusted region may apply once", () => {
    expect(isExplicitRegionChoice(EMPTY_DRAFT)).toBe(false);
    expect(regionChoiceFor(EMPTY_DRAFT, null)).toBe("worldwide");
    expect(
      validateRegion(EMPTY_DRAFT.regionMode, EMPTY_DRAFT.country, copyEn, EMPTY_DRAFT.precise),
    ).toBeNull();
  });

  test("locator runs idle until an explicit request, then succeeds with a fix", () => {
    const locator = new PreciseLocator(successEnv(coords(21.0278, 105.8342, 40)));
    let observed = initialLocatorSnapshot;

    const stop = locator.subscribe(() => {
      observed = locator.getSnapshot();
    });

    try {
      expect(locator.getSnapshot().status).toBe("idle");

      locator.request();

      expect(observed.status).toBe("success");
      expect(observed.fix?.latitude).toBeCloseTo(21.0278, 4);
      expect(observed.fix?.longitude).toBeCloseTo(105.8342, 4);
      expect(observed.fix?.accuracy).toBe(40);
      expect(observed.fix).not.toHaveProperty("city");
    } finally {
      stop();
    }
  });

  test("construction and subscription never prompt for geolocation", () => {
    let calls = 0;

    const env: LocatorEnvironment = {
      geolocation: {
        getCurrentPosition: (success) => {
          calls += 1;
          success(coords(0, 0, null));
        },
      },
      secureContext: true,
    };

    const locator = new PreciseLocator(env);
    const stop = locator.subscribe(() => {});

    try {
      expect(calls).toBe(0);
      expect(locator.getSnapshot().status).toBe("idle");
    } finally {
      stop();
    }
  });

  test("concurrent requests do not duplicate prompts; only the latest attempt settles", () => {
    const pending: Array<(position: LocatorPosition) => void> = [];

    const env: LocatorEnvironment = {
      geolocation: {
        getCurrentPosition: (success) => {
          pending.push(success);
        },
      },
      secureContext: true,
    };

    const locator = new PreciseLocator(env);

    locator.request();
    locator.request();

    expect(pending).toHaveLength(1);

    pending[0]?.(coords(10, 10, 10));

    expect(locator.getSnapshot().status).toBe("success");
    expect(locator.getSnapshot().fix?.latitude).toBe(10);
  });

  test("denial surfaces alternatives with retry, not a dead end", () => {
    const locator = new PreciseLocator(successEnv(coords(0, 0, null), 1));

    locator.request();

    expect(locator.getSnapshot().status).toBe("denied");
    expect(classifyGeoError(1)).toBe("denied");

    const options = fallbackOptionsFor("denied", "VN");

    expect(options.some((option) => option.retryPrecise)).toBe(true);
    expect(options.map((option) => option.choice)).toEqual([
      "precise",
      "home",
      "destination",
      "worldwide",
    ]);
    expect(validateRegion("precise", "", copyEn, null)).not.toBeNull();
  });

  test("timeout is transient and offers a manual retry only", () => {
    let calls = 0;

    const env: LocatorEnvironment = {
      geolocation: {
        getCurrentPosition: (_success, error) => {
          calls += 1;
          error?.({ code: 3 });
        },
      },
      secureContext: true,
    };

    const locator = new PreciseLocator(env);

    locator.request();

    expect(locator.getSnapshot().status).toBe("timeout");
    expect(classifyGeoError(3)).toBe("timeout");
    expect(calls).toBe(1);

    const options = fallbackOptionsFor("timeout", null);

    expect(options.some((option) => option.retryPrecise)).toBe(true);
    expect(options.map((option) => option.choice)).toEqual(["precise", "destination", "worldwide"]);
  });

  test("unsupported contexts fail without a retry that would fail identically", () => {
    const locator = new PreciseLocator({ geolocation: null, secureContext: true });

    locator.request();

    expect(locator.getSnapshot().status).toBe("unsupported");

    const options = fallbackOptionsFor("unsupported", "VN");

    expect(options.some((option) => option.retryPrecise)).toBe(false);
    expect(options.map((option) => option.choice)).toEqual(["home", "destination", "worldwide"]);
  });

  test("insecure contexts fail without prompting or retry", () => {
    let calls = 0;

    const env: LocatorEnvironment = {
      geolocation: {
        getCurrentPosition: (success) => {
          calls += 1;
          success(coords(0, 0, null));
        },
      },
      secureContext: false,
    };

    const locator = new PreciseLocator(env);

    locator.request();

    expect(locator.getSnapshot().status).toBe("insecure");
    expect(calls).toBe(0);
    expect(fallbackOptionsFor("insecure", null).some((option) => option.retryPrecise)).toBe(false);
  });

  test("accuracy labels are unit-only and poor fixes are flagged", () => {
    expect(formatAccuracyM(40.4)).toBe("±40 m");
    expect(accuracyLabelFor({ latitude: 0, longitude: 0, accuracy: 40 })).toBe("±40 m");
    expect(accuracyLabelFor({ latitude: 0, longitude: 0, accuracy: null })).toBeNull();
    expect(isPoorAccuracy({ latitude: 0, longitude: 0, accuracy: 40 })).toBe(false);
    expect(isPoorAccuracy({ latitude: 0, longitude: 0, accuracy: 5000 })).toBe(true);
    expect(isPoorAccuracy({ latitude: 0, longitude: 0, accuracy: null })).toBe(false);
  });

  test("location variants are mutually exclusive and range-checked", () => {
    expect(recommendationLocationSchema.safeParse({ kind: "worldwide" }).success).toBe(true);
    expect(recommendationLocationSchema.safeParse({ kind: "approx", country: "VN" }).success).toBe(
      true,
    );
    expect(
      recommendationLocationSchema.safeParse({
        kind: "precise",
        latitude: 21.0278,
        longitude: 105.8342,
        accuracy: 40,
      }).success,
    ).toBe(true);

    expect(preciseResult(Number.NaN, 0).success).toBe(false);
    expect(preciseResult(91, 0).success).toBe(false);
    expect(preciseResult(0, 181).success).toBe(false);
    expect(preciseResult(0, 0, -1).success).toBe(false);
    expect(preciseResult(0, 0, 1_000_001).success).toBe(false);
    expect(recommendationLocationSchema.safeParse({ kind: "approx", country: "vn" }).success).toBe(
      false,
    );

    expect(recommendationQuerySchema.safeParse({ ...baseInput, country: "VN" }).success).toBe(true);
    expect(
      recommendationQuerySchema.safeParse({
        ...baseInput,
        country: "VN",
        location: { kind: "worldwide" },
      }).success,
    ).toBe(false);
    expect(
      recommendationQuerySchema.safeParse({
        ...baseInput,
        location: { kind: "destination", country: "JP" },
      }).success,
    ).toBe(true);
  });

  test("scope resolution keeps country, precise, and worldwide influence separate", () => {
    const approx = resolveLocationScope({ location: { kind: "approx", country: "VN" } });

    const destination = resolveLocationScope({
      location: { kind: "destination", country: "JP" },
    });

    expect(approx._tag).toBe("Country");
    expect(destination._tag).toBe("Country");
    expect(scopeCountryOf({ location: { kind: "approx", country: "VN" } })).toBe("VN");
    expect(scopeCountryOf({ location: { kind: "destination", country: "JP" } })).toBe("JP");
    expect(scopeCountryOf({ location: { kind: "worldwide" } })).toBeNull();
    expect(scopeCountryOf({ country: "VN" })).toBe("VN");
    expect(scopeCountryOf({})).toBeNull();

    const checked = LocationScope.$match(
      resolveLocationScope({
        location: { kind: "precise", latitude: 21.0278, longitude: 105.8342, accuracy: 40 },
      }),
      {
        Precise: (scope) => scope,
        City: () => null,
        Country: () => null,
        Worldwide: () => null,
      },
    );

    expect(checked?.latitude).toBeCloseTo(21.0278, 6);
    expect(checked?.accuracy).toBe(40);

    const city = resolveLocationScope({
      location: { kind: "city", placeId: "264", country: "IN" },
    });

    expect(city._tag).toBe("City");
    expect(
      scopeCountryOf({ location: { kind: "city", placeId: "264", country: "IN" } }),
    ).toBeNull();
    expect(locationLogFields({ location: { kind: "city", placeId: "264" } })).toEqual({
      locationKind: "city",
    });

    expect(nearbyRadiiM()).toEqual([NEARBY_START_M, 200_000, NEARBY_MAX_M]);
    expect(NEARBY_START_M).toBe(50_000);
    expect(NEARBY_MAX_M).toBe(500_000);
  });

  test("worldwide scope carries no country label or filter", () => {
    expect(scopeLabelFor({ location: { kind: "worldwide" } }, copyEn, [])).toBe(
      copyEn.recWhereAnywhere,
    );
    expect(scopeLabelFor({ location: undefined, country: undefined }, copyEn, [])).toBe(
      copyEn.recWhereAnywhere,
    );
    expect(locationLogFields({ location: { kind: "worldwide" } })).toEqual({
      locationKind: "worldwide",
    });
  });

  test("draft locations feed payloads while allergies still refuse and surprise varies", () => {
    const preciseDraft: QuizDraft = {
      ...EMPTY_DRAFT,
      regionMode: "precise",
      precise: { latitude: 21.0278, longitude: 105.8342, accuracy: 40 },
    };

    const location = draftLocation(preciseDraft);

    expect(location).toEqual({
      kind: "precise",
      latitude: 21.0278,
      longitude: 105.8342,
      accuracy: 40,
    });
    expect(draftLocation({ ...preciseDraft, precise: null })).toBeUndefined();
    expect(draftLocation(EMPTY_DRAFT)).toEqual({ kind: "worldwide" });

    const payload = buildSurprisePayload({
      draft: preciseDraft,
      meal: "dinner",
      mood: "any",
      locale: "en",
      surpriseSeed: 3,
    });

    expect(payload.location).toEqual(location);
    expect(payload.surpriseSeed).toBe(3);

    const transport = toTransportPayload(payload);

    expect(transport.location).toEqual(location);
    expect(transport.country).toBeUndefined();
    expect(toTransportPayload({ ...payload, location: undefined }).country).toBe(payload.country);
  });

  test("summary scope labels stay honest in English", () => {
    const options = [
      { code: "VN", label: "Vietnam" },
      { code: "JP", label: "Japan" },
    ];

    expect(scopeLabelFor({ location: { kind: "approx", country: "VN" } }, copyEn, options)).toBe(
      "Exploring Vietnam",
    );
    expect(
      scopeLabelFor({ location: { kind: "destination", country: "JP" } }, copyEn, options),
    ).toBe("Japan");
    expect(
      scopeLabelFor(
        { location: { kind: "precise", latitude: 0, longitude: 0, accuracy: 40 } },
        copyEn,
        options,
      ),
    ).toBe(copyEn.recWhereNearYou);
    expect(
      scopeLabelFor(
        {
          location: {
            kind: "city",
            placeId: "42",
            country: "IN",
            label: "Bengaluru, Karnataka, India",
          },
        },
        copyEn,
        options,
      ),
    ).toBe("Exploring Bengaluru, Karnataka, India");
    expect(scopeLabelFor({ location: { kind: "worldwide" } }, copyEn, options)).toBe(
      copyEn.recWhereAnywhere,
    );
    expect(scopeLabelFor({ location: undefined, country: "VN" }, copyEn, options)).toBe("Vietnam");
  });

  test("summary scope labels stay honest in Vietnamese", () => {
    const options = [
      { code: "VN", label: "Việt Nam" },
      { code: "JP", label: "Nhật Bản" },
    ];

    expect(scopeLabelFor({ location: { kind: "approx", country: "VN" } }, copyVi, options)).toBe(
      `Đang khám phá Việt Nam`,
    );
    expect(
      scopeLabelFor({ location: { kind: "destination", country: "JP" } }, copyVi, options),
    ).toBe("Nhật Bản");
    expect(
      scopeLabelFor(
        { location: { kind: "precise", latitude: 0, longitude: 0, accuracy: null } },
        copyVi,
        options,
      ),
    ).toBe(copyVi.recWhereNearYou);
    expect(scopeLabelFor({ location: { kind: "worldwide" } }, copyVi, options)).toBe(
      copyVi.recWhereAnywhere,
    );
  });

  test("precise coordinates never reach storage or journey restores", () => {
    const store = new Map<string, string>();

    const fakeWindow = {
      isSecureContext: true,
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    };

    // Test-only global swap: bun has no window, so defining it here cannot
    // collide with a real DOM. The property is deleted in `finally`.
    Object.defineProperty(globalThis, "window", {
      value: fakeWindow,
      configurable: true,
      writable: true,
    });

    try {
      persistPrefs(true, ["cilantro"], "VN");

      const stored = store.get("feastjourney.recommend.prefs.v1") ?? "";

      expect(stored).toContain('"avoid"');
      expect(stored).toContain('"country"');
      expect(stored).toContain('"remember"');
      expect(stored).not.toContain("latitude");
      expect(stored).not.toContain("precise");
    } finally {
      Reflect.deleteProperty(globalThis, "window");
    }

    const preciseDraft: QuizDraft = {
      ...EMPTY_DRAFT,
      regionMode: "precise",
      precise: { latitude: 21.0278, longitude: 105.8342, accuracy: 40 },
    };

    const snapshot = toCoarseSnapshot({
      meal: "dinner",
      mood: "any",
      draft: preciseDraft,
      stepIndex: 0,
      submitted: buildSurprisePayload({
        draft: preciseDraft,
        meal: "dinner",
        mood: "any",
        locale: "en",
        surpriseSeed: 0,
      }),
      showResults: true,
      surpriseSeed: 0,
    });

    expect("precise" in snapshot.draft).toBe(false);
    expect(snapshot.submitted).toBeNull();
    expect(snapshot.showResults).toBe(false);

    const countrySnapshot = toCoarseSnapshot({
      meal: "dinner",
      mood: "any",
      draft: { ...EMPTY_DRAFT, regionMode: "country", country: "VN", countrySource: "chosen" },
      stepIndex: 0,
      submitted: buildSurprisePayload({
        draft: { ...EMPTY_DRAFT, regionMode: "country", country: "VN", countrySource: "chosen" },
        meal: "dinner",
        mood: "any",
        locale: "en",
        surpriseSeed: 0,
      }),
      showResults: true,
      surpriseSeed: 0,
    });

    expect(countrySnapshot.submitted?.country).toBe("VN");
    expect(countrySnapshot.submitted !== null && "location" in countrySnapshot.submitted).toBe(
      false,
    );
    expect(countrySnapshot.showResults).toBe(true);
  });

  test("server logs and ranking context never carry coordinates", () => {
    const preciseInput: RecommendDishesInput = {
      ...baseInput,
      location: { kind: "precise", latitude: 21.0278, longitude: 105.8342, accuracy: 40 },
    };

    const logged = JSON.stringify(locationLogFields(preciseInput));

    expect(logged).not.toContain("21.0278");
    expect(logged).not.toContain("105.8342");
    expect(logged).not.toContain("latitude");
    expect(logged).not.toContain("longitude");
    expect(logged).not.toContain("accuracy");
    expect(locationLogFields(preciseInput)).toEqual({
      locationKind: "precise",
      searchRadiusMaxM: NEARBY_MAX_M,
    });
    expect(locationLogFields({ country: "VN" })).toEqual({
      locationKind: "country",
      country: "VN",
    });

    const context = toRankContext(preciseInput);

    expect(context.cuisineOrRegion).toBeNull();
    expect(JSON.stringify(context)).not.toContain("21.0278");
    expect(toRankContext({ ...baseInput, country: "VN" }).cuisineOrRegion).toBe("VN");
    expect(toRankContext({ ...baseInput, cuisine: "pho" }).cuisineOrRegion).toBe("pho");
  });

  test("new UI copy exists in English and Vietnamese and the POST contract holds", () => {
    const keys = [
      "recWhereLegend",
      "recWhereHint",
      "recWhereExploring",
      "recWhereDetectedNote",
      "recWhereNearYou",
      "recWhereAnother",
      "recWhereAnywhere",
      "recWhereUsingLocation",
      "recWhereAccuracyNote",
      "recWhereCountryLabel",
      "recWhereChoose",
      "recWhereLocating",
      "recCountryLoadError",
      "recCountryError",
      "recRetry",
      "recError",
      "recEmptySuggest",
      "recSummaryLabel",
      "recSummaryChange",
      "discoverLocalUnknown",
      "discoverLocalLoading",
      "discoverLocalError",
      "discoverLocalNear",
      "discoverLocalSub",
      "carouselWorldwide",
    ] as const;

    for (const key of keys) {
      expect(copyEn[key].length, `en.${key}`).toBeGreaterThan(0);
      expect(copyVi[key].length, `vi.${key}`).toBeGreaterThan(0);
    }

    expect(recommendationQuerySchema.safeParse({ ...baseInput, country: "VN" }).success).toBe(true);
    expect(
      recommendationQuerySchema.safeParse({ ...baseInput, location: { kind: "worldwide" } })
        .success,
    ).toBe(true);
    expect(readLocatorEnvironment().secureContext).toBe(true);
  });
});
