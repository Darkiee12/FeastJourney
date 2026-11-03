import { describe, expect, test } from "bun:test";

import {
  discoveryHeaderCopyFor,
  discoveryIndicatorFor,
} from "@/components/home/discovery-location";

/**
 * Indicator + header-status copy contracts. Pure helpers only — no DOM
 * renderer is installed, matching tests/discovery-location.test.ts.
 */

const HEADER_KEYS = [
  "worldwide",
  "chooseLocation",
  "findingDishes",
  "updatingDishes",
  "dishesFailed",
  "retryDishes",
] as const;

const BANNED_PHRASES = [
  "near you",
  "network region",
  "precise fix",
  "IP-derived",
  "Cloudflare",
  "lat-lon",
] as const;

describe("discovery header copy", () => {
  test("every string exists and is non-empty in English and Vietnamese", () => {
    for (const lang of ["en", "vi"] as const) {
      const copy = discoveryHeaderCopyFor(lang);

      for (const key of HEADER_KEYS) {
        expect(copy[key].length, `${lang}.${key}`).toBeGreaterThan(0);
      }
    }

    const actualKeys = Object.keys(discoveryHeaderCopyFor("en")).toSorted().join(",");
    const expectedKeys = [...HEADER_KEYS].toSorted().join(",");

    expect(actualKeys).toBe(expectedKeys);
  });

  test("non-Vietnamese locales fall back to English", () => {
    expect(discoveryHeaderCopyFor("hi")).toEqual(discoveryHeaderCopyFor("en"));
  });

  test("status lines never describe requests as near-you", () => {
    for (const lang of ["en", "vi"] as const) {
      const copy = discoveryHeaderCopyFor(lang);

      for (const key of HEADER_KEYS) {
        const value = copy[key].toLowerCase();

        expect(value.includes("near you"), `${lang}.${key}`).toBe(false);
      }
    }
  });
});

describe("discovery indicator", () => {
  test("worldwide scope reads as worldwide with the globe icon", () => {
    expect(
      discoveryIndicatorFor({ lang: "en", regionName: "Vietnam", scope: "worldwide" }),
    ).toEqual({ icon: "globe", label: "Worldwide" });
    expect(
      discoveryIndicatorFor({ lang: "vi", regionName: "Việt Nam", scope: "worldwide" }),
    ).toEqual({ icon: "globe", label: "Khắp thế giới" });
  });

  test("city and country scopes name the served place with the pin icon", () => {
    expect(
      discoveryIndicatorFor({
        lang: "en",
        regionName: "Bengaluru, Karnataka, India",
        scope: "city",
      }),
    ).toEqual({ icon: "pin", label: "Bengaluru, Karnataka, India" });
    expect(discoveryIndicatorFor({ lang: "en", regionName: "Vietnam", scope: "regional" })).toEqual(
      { icon: "pin", label: "Vietnam" },
    );
    expect(discoveryIndicatorFor({ lang: "en", regionName: "Hanoi", scope: "nearby" })).toEqual({
      icon: "pin",
      label: "Hanoi",
    });
  });

  test("empty or missing labels fall back to choose-location, never invented text", () => {
    expect(discoveryIndicatorFor({ lang: "en", regionName: null, scope: "regional" })).toEqual({
      icon: "pin",
      label: "Choose location",
    });
    expect(discoveryIndicatorFor({ lang: "vi", regionName: "  ", scope: null })).toEqual({
      icon: "pin",
      label: "Chọn vị trí",
    });
    expect(discoveryIndicatorFor({ lang: "en", regionName: null, scope: null })).toEqual({
      icon: "pin",
      label: "Choose location",
    });
  });

  test("indicator markup carries no banned phrases", () => {
    const labels = [
      discoveryIndicatorFor({ lang: "en", regionName: "Vietnam", scope: "regional" }).label,
      discoveryIndicatorFor({ lang: "en", regionName: null, scope: "worldwide" }).label,
      discoveryHeaderCopyFor("en").findingDishes,
      discoveryHeaderCopyFor("en").updatingDishes,
      discoveryHeaderCopyFor("en").dishesFailed,
    ];

    for (const label of labels) {
      for (const banned of BANNED_PHRASES) {
        expect(label.toLowerCase().includes(banned), `${label} contains ${banned}`).toBe(false);
      }
    }
  });
});
