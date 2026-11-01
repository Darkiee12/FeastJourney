import { describe, expect, test } from "bun:test";

import {
  buildRecommendPayload,
  buildSurprisePayload,
  draftFromSavedPrefs,
  EMPTY_DRAFT,
  mealSchema,
  moodSchema,
  parseCommaList,
  readSavedPrefs,
  readSavedPrefsWithMigration,
  recCountrySchema,
  removeSavedPrefs,
  serializePrefs,
  termLengthError,
  tooLongTerms,
  validateRegion,
} from "@/components/home/recommend-section";
import {
  MEAL_OCCASIONS,
  RECOMMENDATION_MOODS,
} from "@/modules/food-discovery/recommendation.constants";
import { messagesFor } from "@/shared/i18n";

const copy = messagesFor("en");

describe("recommend route client parsing", () => {
  test("meal and mood schemas mirror the shared vocabularies", () => {
    expect(mealSchema.safeParse("lunch").success).toBe(true);
    expect(mealSchema.safeParse("brunch").success).toBe(false);
    expect(moodSchema.safeParse("spicy").success).toBe(true);
    expect(moodSchema.safeParse("hangry").success).toBe(false);
    expect([...MEAL_OCCASIONS]).toHaveLength(6);
    expect([...RECOMMENDATION_MOODS]).toHaveLength(7);
  });

  test("region resolves against the catalog country list, not free text", () => {
    expect(validateRegion("country", "", copy)).toBe(copy.recCountryError);
    expect(validateRegion("country", "x1!", copy)).toBe(copy.recCountryError);
    expect(validateRegion("country", " vn ", copy)).toBeNull();
    expect(validateRegion("anywhere", "", copy)).toBeNull();
  });

  test("country schema mirrors the server ISO pattern", () => {
    expect(recCountrySchema.safeParse("VN").success).toBe(true);
    expect(recCountrySchema.safeParse("VN-01").success).toBe(true);
    expect(recCountrySchema.safeParse("vn").success).toBe(false);
    expect(recCountrySchema.safeParse("USA!").success).toBe(false);
  });

  test("comma lists trim, drop empties, and dedupe", () => {
    expect(parseCommaList("peanuts, shrimp ,peanuts,, ")).toEqual(["peanuts", "shrimp"]);
    expect(parseCommaList("  ")).toEqual([]);
  });

  test("overlong exclusion terms are rejected before the server call", () => {
    expect(tooLongTerms(["a".repeat(100)])).toBe(false);
    expect(tooLongTerms(["a".repeat(101)])).toBe(true);
    expect(termLengthError("cilantro, peanuts", copy)).toBeNull();
    expect(termLengthError("a".repeat(101), copy)).toBe(copy.recTermTooLong);
  });

  test("region validation requires a real choice per lane", () => {
    expect(validateRegion("anywhere", "", copy)).toBeNull();
    expect(validateRegion("country", "", copy)).toBe(copy.recCountryError);
    expect(validateRegion("country", "x1!", copy)).toBe(copy.recCountryError);
    expect(validateRegion("country", " vn ", copy)).toBeNull();
  });

  test("payload builder keeps undefined lanes undefined", () => {
    const payload = buildRecommendPayload({
      meal: "dinner",
      excludedIngredients: ["cilantro"],
      country: "VN",
      mood: "comforting",
      locale: "en",
    });

    expect(payload.meal).toBe("dinner");
    expect(payload.country).toBe("VN");
    expect(payload.excludedIngredients).toEqual(["cilantro"]);
  });

  test("stored prefs parse only a known shape", () => {
    expect(readSavedPrefs(() => null)).toBeNull();
    expect(readSavedPrefs(() => "not json")).toBeNull();
    expect(
      readSavedPrefs(() => JSON.stringify({ remember: true, excludedIngredients: [1] })),
    ).toBeNull();

    const saved = readSavedPrefs(() =>
      serializePrefs({ remember: true, excludedIngredients: ["x"], country: "VN" }),
    );

    expect(saved?.country).toBe("VN");
    expect(saved?.excludedIngredients).toEqual(["x"]);
  });

  test("legacy v1 prefs migrate forward once and the v1 key is removed", () => {
    const store = new Map<string, string>([
      ["v1", JSON.stringify({ remember: true, avoid: ["mushrooms"], country: "VN" })],
    ]);

    const migrated = readSavedPrefsWithMigration(
      () => null,
      () => store.get("v1") ?? null,
      () => {
        store.delete("v1");
      },
    );

    expect(migrated?.excludedIngredients).toEqual(["mushrooms"]);
    expect(migrated?.remember).toBe(true);
    expect(migrated?.country).toBe("VN");
    expect(store.has("v1")).toBe(false);

    // Legacy shape under the current key migrates too instead of dropping the list.
    const migratedInline = readSavedPrefsWithMigration(
      () => JSON.stringify({ remember: true, avoid: ["cilantro"] }),
      () => null,
      () => {},
    );

    expect(migratedInline?.excludedIngredients).toEqual(["cilantro"]);
  });

  test("saved prefs restore exclusions and destination without touching meal or mood", () => {
    expect(draftFromSavedPrefs(null)).toEqual(EMPTY_DRAFT);

    const draft = draftFromSavedPrefs({
      remember: true,
      excludedIngredients: ["cilantro"],
      country: "VN",
    });

    expect(draft.excludedRaw).toBe("cilantro");
    expect(draft.regionMode).toBe("country");
    expect(draft.country).toBe("VN");
    expect(draft.remember).toBe(true);
  });

  test("exclusions restore even without destination consent", () => {
    const draft = draftFromSavedPrefs({
      remember: false,
      excludedIngredients: ["peanuts"],
    });

    expect(draft.excludedRaw).toBe("peanuts");
    expect(draft.regionMode).toBe("anywhere");
    expect(draft.remember).toBe(false);
  });

  test("surprise keeps the current meal, mood, region, and exclusions", () => {
    const payload = buildSurprisePayload({
      draft: {
        ...EMPTY_DRAFT,
        excludedRaw: "cilantro, peanuts",
        regionMode: "country",
        country: "vn",
      },
      meal: "dinner",
      mood: "comforting",
      locale: "en",
      surpriseSeed: 0,
    });

    expect(payload.meal).toBe("dinner");
    expect(payload.mood).toBe("comforting");
    expect(payload.country).toBe("VN");
    expect(payload.excludedIngredients).toEqual(["cilantro", "peanuts"]);
  });

  test("surprise carries saved exclusions and destination through the restored draft", () => {
    const saved = readSavedPrefs(() =>
      serializePrefs({ remember: true, excludedIngredients: ["mushrooms"], country: "JP" }),
    );

    const payload = buildSurprisePayload({
      draft: draftFromSavedPrefs(saved),
      meal: "anything",
      mood: "any",
      locale: "en",
      surpriseSeed: 0,
    });

    expect(payload.excludedIngredients).toEqual(["mushrooms"]);
    expect(payload.country).toBe("JP");
  });

  test("surprise with no preferences still builds a valid payload", () => {
    const payload = buildSurprisePayload({
      draft: EMPTY_DRAFT,
      meal: "anything",
      mood: "any",
      locale: "en",
      surpriseSeed: 2,
    });

    expect(payload.excludedIngredients).toEqual([]);
    expect(payload.country).toBeUndefined();
  });

  test("surprise never mutates the draft it reads", () => {
    const draft = {
      ...EMPTY_DRAFT,
      excludedRaw: "cilantro",
      regionMode: "country" as const,
      country: "vn",
    };

    const before = { ...draft };

    buildSurprisePayload({ draft, meal: "lunch", mood: "light", locale: "en", surpriseSeed: 0 });

    expect(draft).toEqual(before);
  });

  test("clear action removes storage through the injected remover", () => {
    let removed = 0;

    removeSavedPrefs(() => {
      removed += 1;
    });

    expect(removed).toBe(1);
  });
});
