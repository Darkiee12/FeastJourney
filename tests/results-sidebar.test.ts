import { describe, expect, test } from "bun:test";

import type { RecommendPayload } from "@/components/home/recommend/quiz-model";
import { toYourPicksProps } from "@/components/home/recommend/results-sidebar";

const submittedPayload = (overrides: Partial<RecommendPayload> = {}): RecommendPayload => ({
  excludedIngredients: ["cilantro", "mushrooms"],
  country: "VN",
  location: { kind: "destination", country: "VN" },
  locale: "en",
  meal: "dinner",
  mood: "comforting",
  surpriseSeed: 0,
  ...overrides,
});

describe("toYourPicksProps", () => {
  test("projects the submitted request verbatim with no reinterpretation", () => {
    const submitted = submittedPayload();
    const picks = toYourPicksProps(submitted);

    expect(picks.meal).toBe("dinner");
    expect(picks.mood).toBe("comforting");
    expect(picks.country).toBe("VN");
    expect(picks.location).toEqual({ kind: "destination", country: "VN" });
    expect(picks.excludedIngredients).toBe(submitted.excludedIngredients);
  });

  test("passes a precise location through untouched for the scope label to word honestly", () => {
    const picks = toYourPicksProps(
      submittedPayload({
        country: undefined,
        location: { accuracy: 25, kind: "precise", latitude: 10.77, longitude: 106.68 },
      }),
    );

    expect(picks.country).toBeUndefined();
    expect(picks.location).toEqual({
      accuracy: 25,
      kind: "precise",
      latitude: 10.77,
      longitude: 106.68,
    });
  });

  test("passes worldwide scope through without inventing a region", () => {
    const picks = toYourPicksProps(
      submittedPayload({ country: undefined, location: { kind: "worldwide" } }),
    );

    expect(picks.country).toBeUndefined();
    expect(picks.location).toEqual({ kind: "worldwide" });
  });
});
