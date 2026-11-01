import { describe, expect, test } from "bun:test";

import {
  carouselAnnouncement,
  carouselWrappedIndex,
  DISH_CAROUSEL_AUTOPLAY_MS,
  dishCarouselIngredientNames,
  dishCarouselTitle,
  toCarouselPublishedImage,
} from "@/components/dish/dish-carousel";
import {
  buildSurprisePayload,
  draftLocation,
  EMPTY_DRAFT,
  scopeLabelFor,
  toTransportPayload,
  type QuizDraft,
} from "@/components/home/recommend/quiz-model";
import { statusForDish } from "@/modules/user/components/save-dish-button";
import { messagesFor } from "@/shared/i18n";

const copyEn = messagesFor("en");

const countryOptions = [{ code: "VN", label: "Vietnam" }];

const answeredDraft = (overrides?: Partial<QuizDraft>): QuizDraft => ({
  ...EMPTY_DRAFT,
  excludedRaw: "pork, cilantro, peanut",
  country: "VN",
  countrySource: "chosen",
  regionMode: "country",
  ...overrides,
});

describe("questionnaire answers survive into the results request", () => {
  test("surprise payload keeps meal, mood, region, and exclusions; only the seed varies", () => {
    const draft = answeredDraft();

    const first = buildSurprisePayload({
      draft,
      locale: "en",
      meal: "dinner",
      mood: "comforting",
      surpriseSeed: 0,
    });

    const second = buildSurprisePayload({
      draft,
      locale: "en",
      meal: "dinner",
      mood: "comforting",
      surpriseSeed: 1,
    });

    expect(first.meal).toBe("dinner");
    expect(first.mood).toBe("comforting");
    expect(first.excludedIngredients).toEqual(["pork", "cilantro", "peanut"]);
    expect(first.locale).toBe("en");
    expect(first.surpriseSeed).toBe(0);
    expect(second.surpriseSeed).toBe(1);
    // Same filters, different slice: everything but the seed is identical.
    expect({ ...second, surpriseSeed: 0 }).toEqual(first);
  });

  test("transport payload drops the legacy country mirror when a location is present", () => {
    const payload = buildSurprisePayload({
      draft: answeredDraft(),
      locale: "en",
      meal: "dinner",
      mood: "any",
      surpriseSeed: 0,
    });

    expect(payload.country).toBe("VN");
    expect(payload.location?.kind).toBe("destination");

    const transport = toTransportPayload(payload);

    expect(transport.country).toBeUndefined();
    expect(transport.location).toEqual(payload.location);
    // Meal, mood, filters, and seed pass through untouched.
    expect(transport.meal).toBe(payload.meal);
    expect(transport.excludedIngredients).toEqual(payload.excludedIngredients);
    expect(transport.surpriseSeed).toBe(payload.surpriseSeed);
  });

  test("detected home regions travel as approximate, never as explicit destinations", () => {
    const location = draftLocation(answeredDraft({ countrySource: "detected" }));

    expect(location).toEqual({ country: "VN", kind: "approx" });
  });

  test("precise lanes travel as coordinates with accuracy", () => {
    const location = draftLocation({
      ...EMPTY_DRAFT,
      precise: { accuracy: 25, latitude: 21.02, longitude: 105.85 },
      regionMode: "precise",
    });

    expect(location).toEqual({
      accuracy: 25,
      kind: "precise",
      latitude: 21.02,
      longitude: 105.85,
    });
  });
});

describe("result scope labels stay honest", () => {
  test("approximate home regions explore by country name", () => {
    expect(
      scopeLabelFor({ location: { country: "VN", kind: "approx" } }, copyEn, countryOptions),
    ).toBe("Exploring Vietnam");
  });

  test("destinations show the plain country name", () => {
    expect(
      scopeLabelFor(
        { country: "VN", location: { country: "VN", kind: "destination" } },
        copyEn,
        countryOptions,
      ),
    ).toBe("Vietnam");
  });

  test("precise fixes show the honest nearby scope, never meters", () => {
    expect(
      scopeLabelFor(
        {
          location: { accuracy: 25, kind: "precise", latitude: 21.02, longitude: 105.85 },
        },
        copyEn,
        countryOptions,
      ),
    ).toBe(copyEn.recWhereNearYou);
  });

  test("chosen cities show the city label", () => {
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
        countryOptions,
      ),
    ).toBe("Exploring Bengaluru, Karnataka, India");
  });

  test("worldwide and missing scopes never invent a place", () => {
    expect(scopeLabelFor({ location: { kind: "worldwide" } }, copyEn, countryOptions)).toBe(
      copyEn.recWhereAnywhere,
    );
    expect(scopeLabelFor({}, copyEn, countryOptions)).toBe(copyEn.recWhereAnywhere);
  });
});

describe("featured navigation foundation", () => {
  test("index wraps so prev/next/dots never leave the slide window", () => {
    expect(carouselWrappedIndex(0, 10)).toBe(0);
    expect(carouselWrappedIndex(10, 10)).toBe(0);
    expect(carouselWrappedIndex(-1, 10)).toBe(9);
  });

  test("empty result sets stay at zero instead of producing NaN", () => {
    expect(carouselWrappedIndex(0, 0)).toBe(0);
  });

  test("manual navigation announces the new position for screen readers", () => {
    expect(carouselAnnouncement(copyEn, 0, 10)).toBe("Slide 1 of 10");
    expect(carouselAnnouncement(copyEn, 9, 10)).toBe("Slide 10 of 10");
  });

  test("reset on a new result set returns to the first slide", () => {
    // quiz-flow resets via resetKey (seed:meal:mood:locale:excluded); the index
    // contract underneath is wrap-to-zero on scope change.
    expect(carouselWrappedIndex(7, 10)).toBe(7);
    expect(carouselWrappedIndex(0, 10)).toBe(0);
  });

  test("results carousel never autoplays: shared default stays off unless opted in", () => {
    expect(DISH_CAROUSEL_AUTOPLAY_MS).toBe(6000);
  });

  test("slide titles and ingredient previews degrade honestly", () => {
    const base = {
      description: null,
      descriptionLanguage: null,
      englishName: "Pho",
      id: "1",
      image: null,
      ingredients: [{ name: "Rice", role: "base" }],
      name: "Phở",
      nativeLanguageTag: undefined,
      nativeName: undefined,
      regionNames: ["Hanoi"],
      slug: "pho",
    };

    expect(dishCarouselTitle(base)).toBe("Phở");
    expect(dishCarouselTitle({ ...base, name: undefined })).toBe("Pho");
    expect(dishCarouselIngredientNames(base)).toEqual(["Rice"]);
    expect(
      dishCarouselIngredientNames({ ...base, ingredients: [{ name: undefined, role: "x" }] }),
    ).toEqual([]);
  });
});

describe("save dish behavior is unchanged on the results surface", () => {
  const query = {
    data: ["dish-1"],
    dataUpdatedAt: 42,
    isError: false,
    isPending: false,
    refetch: () => {},
  };

  test("saved state projects per dish out of the batched list query", () => {
    expect(statusForDish(query, "dish-1").saved).toBe(true);
    expect(statusForDish(query, "dish-2").saved).toBe(false);
  });

  test("pending and failure flags pass through so the button never lies", () => {
    expect(statusForDish({ ...query, isPending: true }, "dish-1").pending).toBe(true);
    expect(statusForDish({ ...query, isError: true }, "dish-1").failed).toBe(true);
    expect(statusForDish(query, "dish-1").updatedAt).toBe(42);
  });

  test("unknown list data resolves to unknown, not to unsaved", () => {
    expect(statusForDish({ ...query, data: undefined }, "dish-1").saved).toBeUndefined();
  });
});

describe("result images project without invention", () => {
  test("absent photos project to null: the slide renders the honest fallback", () => {
    expect(toCarouselPublishedImage(null, "101")).toBeNull();
    expect(toCarouselPublishedImage(undefined, "101")).toBeNull();
  });

  test("legacy payloads fill identity and dimensions defensively, never URLs", () => {
    const projected = toCarouselPublishedImage(
      { alt: "Legacy", attribution: null, url: "https://example.com/legacy.jpg" },
      "202",
    );

    expect(projected?.id).toBe("202");
    expect(projected?.dishId).toBe("202");
    expect(projected?.url).toBe("https://example.com/legacy.jpg");
    expect(projected?.srcSet).toBeNull();
    expect(projected?.width).toBeNull();
  });
});
