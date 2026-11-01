import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PROVENANCE_LABELS,
  draftFromSavedPrefs,
  EMPTY_DRAFT,
  flagOriginFor,
  readSavedPrefs,
  regionOriginFor,
  textOriginFor,
  toCoarseSnapshot,
  writeJourneySnapshot,
  type JourneyWriteModel,
  type QuizDraft,
  type SavedRecommendPrefs,
} from "@/components/home/recommend/quiz-model";

const savedPrefs = (overrides: Partial<SavedRecommendPrefs> = {}): SavedRecommendPrefs => ({
  country: "VN",
  excludedIngredients: ["cilantro"],
  remember: true,
  ...overrides,
});

const savedDraft = (): QuizDraft => draftFromSavedPrefs(savedPrefs());

describe("regionOriginFor", () => {
  test("any tap this visit is explicit, even over saved or detected values", () => {
    expect(regionOriginFor({ draft: savedDraft(), savedCountry: "VN", touched: true })).toBe(
      "explicit",
    );
  });

  test("fresh opt-in destination restores with its saved label", () => {
    expect(regionOriginFor({ draft: savedDraft(), savedCountry: "VN", touched: false })).toBe(
      "restored",
    );
  });

  test("restored match is case-insensitive", () => {
    const draft: QuizDraft = { ...savedDraft(), country: "vn" };

    expect(regionOriginFor({ draft, savedCountry: "VN", touched: false })).toBe("restored");
  });

  test("detected source is suggested until confirmed", () => {
    const draft: QuizDraft = {
      ...EMPTY_DRAFT,
      country: "VN",
      countrySource: "detected",
      regionMode: "country",
    };

    expect(regionOriginFor({ draft, savedCountry: null, touched: false })).toBe("suggested");
  });

  test("anywhere default is untouched even when a preference exists", () => {
    expect(regionOriginFor({ draft: EMPTY_DRAFT, savedCountry: "VN", touched: false })).toBe(
      "untouched",
    );
  });

  test("chosen destination without a matching saved pref is untouched, never restored", () => {
    const draft: QuizDraft = {
      ...EMPTY_DRAFT,
      country: "JP",
      countrySource: "chosen",
      regionMode: "country",
    };

    expect(regionOriginFor({ draft, savedCountry: "VN", touched: false })).toBe("untouched");
  });

  test("empty destination lane is untouched", () => {
    const draft: QuizDraft = { ...EMPTY_DRAFT, regionMode: "country" };

    expect(regionOriginFor({ draft, savedCountry: "VN", touched: false })).toBe("untouched");
  });
});

describe("textOriginFor", () => {
  test("typing is explicit", () => {
    expect(textOriginFor({ savedValue: "cilantro", touched: true, value: "cilantro" })).toBe(
      "explicit",
    );
  });

  test("matching saved dislikes restore", () => {
    expect(textOriginFor({ savedValue: "cilantro", touched: false, value: "cilantro" })).toBe(
      "restored",
    );
  });

  test("empty text is untouched even when a preference exists", () => {
    expect(textOriginFor({ savedValue: "cilantro", touched: false, value: "" })).toBe("untouched");
  });

  test("edited text is untouched, never claimed as saved", () => {
    expect(
      textOriginFor({ savedValue: "cilantro", touched: false, value: "cilantro, mushrooms" }),
    ).toBe("untouched");
  });
});

describe("flagOriginFor", () => {
  test("meal and mood are explicit only after a tap", () => {
    expect(flagOriginFor(false)).toBe("untouched");
    expect(flagOriginFor(true)).toBe("explicit");
  });
});

describe("provenance labels", () => {
  test("fallbacks are honest English until i18n keys land", () => {
    expect(DEFAULT_PROVENANCE_LABELS.saved).toBe("Saved from last visit");
    expect(DEFAULT_PROVENANCE_LABELS.approximate).toBe("Approximate");
  });
});

describe("saved-preference privacy", () => {
  test("unified exclusions restore from storage with no separate allergy field", () => {
    expect(savedDraft().excludedRaw).toBe("cilantro");
  });

  test("meal and mood always restart at defaults", () => {
    expect(EMPTY_DRAFT.regionMode).toBe("anywhere");
  });

  test("corrupt or non-consensual storage restores nothing", () => {
    expect(readSavedPrefs(() => "{nope")).toBeNull();
    expect(readSavedPrefs(() => JSON.stringify({ excludedIngredients: "cilantro" }))).toBeNull();
    expect(draftFromSavedPrefs(null)).toEqual(EMPTY_DRAFT);
  });

  test("exclusions restore as raw text; the destination restores only with opt-in", () => {
    expect(savedDraft().excludedRaw).toBe("cilantro");
    expect(savedDraft().remember).toBe(true);
    expect(
      draftFromSavedPrefs(savedPrefs({ city: undefined, country: undefined, remember: false }))
        .excludedRaw,
    ).toBe("cilantro");
  });
});

describe("journey snapshot privacy", () => {
  const baseModel: JourneyWriteModel = {
    draft: {
      ...EMPTY_DRAFT,
      precise: { accuracy: 20, latitude: 21, longitude: 105 },
      regionMode: "precise",
    },
    meal: "dinner",
    mood: "any",
    showResults: true,
    stepIndex: 0,
    submitted: null,
    surpriseSeed: 0,
  };

  test("precise fixes never enter the journey cache", () => {
    const snapshot = toCoarseSnapshot(baseModel);

    expect(snapshot.draft.regionMode).toBe("precise");
    expect(snapshot.draft.country).toBe("");
  });

  test("precise results drop to the quiz instead of re-running a stale fix", () => {
    const snapshot = toCoarseSnapshot({
      ...baseModel,
      submitted: {
        country: undefined,
        excludedIngredients: [],
        locale: "en",
        meal: "dinner",
        mood: "any",
        surpriseSeed: 0,
        location: { accuracy: 20, kind: "precise", latitude: 21, longitude: 105 },
      },
    });

    expect(snapshot.submitted).toBeNull();
    expect(snapshot.showResults).toBe(false);
  });

  test("writeJourneySnapshot is a no-op without a window", () => {
    expect(writeJourneySnapshot(toCoarseSnapshot(baseModel))).toBeUndefined();
  });
});
