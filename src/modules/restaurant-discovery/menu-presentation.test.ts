import { describe, expect, test } from "bun:test";

import type { InteractiveMenu } from "@/modules/restaurant-discovery/menu-presentation";
import {
  menuBcp47TagFor,
  menuItemDisplayFor,
  resolveMenuLocale,
  resolveMenuText,
  waiterDishNameFor,
  waiterVariantLabelFor,
} from "@/modules/restaurant-discovery/menu-presentation";

const itemFixture = (
  overrides?: Partial<InteractiveMenu["items"][number]>,
): InteractiveMenu["items"][number] => ({
  id: "item-1",
  section: null,
  originalName: "Phở bò",
  translatedName: "Beef noodle soup",
  originalDescription: "Nước dùng xương bò",
  translatedDescription: "Beef bone broth",
  explanatorySummary: null,
  ingredients: null,
  uncertainties: [],
  assetIds: [],
  dishId: null,
  variants: [
    {
      id: "variant-1",
      originalLabel: "Tô lớn",
      translatedLabel: "Large bowl",
      price: null,
      provenance: "Reviewed listed menu price",
      sourceUrl: null,
    },
  ],
  ...overrides,
});

describe("menuBcp47TagFor", () => {
  test("maps the seven menu languages, with zh on Hans", () => {
    expect(menuBcp47TagFor("en")).toBe("en");
    expect(menuBcp47TagFor("vi")).toBe("vi");
    expect(menuBcp47TagFor("ja")).toBe("ja");
    expect(menuBcp47TagFor("zh")).toBe("zh-Hans");
    expect(menuBcp47TagFor("ko")).toBe("ko");
    expect(menuBcp47TagFor("fr")).toBe("fr");
    expect(menuBcp47TagFor("es")).toBe("es");
  });

  test("never guesses: missing, blank, or unknown codes become und", () => {
    expect(menuBcp47TagFor(null)).toBe("und");
    expect(menuBcp47TagFor(undefined)).toBe("und");
    expect(menuBcp47TagFor("  ")).toBe("und");
    expect(menuBcp47TagFor("de")).toBe("und");
  });

  test("normalizes case and strips region subtags", () => {
    expect(menuBcp47TagFor("VI")).toBe("vi");
    expect(menuBcp47TagFor("zh-CN")).toBe("zh-Hans");
  });
});

describe("resolveMenuLocale", () => {
  test("explicit visitor choice wins over any fallback", () => {
    expect(resolveMenuLocale("vi", "en")).toEqual({ locale: "vi", source: "explicit" });
    expect(resolveMenuLocale("en", "vi")).toEqual({ locale: "en", source: "explicit" });
  });

  test("browser/default resolution only fills the gap", () => {
    expect(resolveMenuLocale(null, "vi")).toEqual({ locale: "vi", source: "fallback" });
    expect(resolveMenuLocale("  ", "vi")).toEqual({ locale: "vi", source: "fallback" });
    expect(resolveMenuLocale(undefined, null)).toEqual({ locale: "en", source: "fallback" });
  });

  test("trims an explicit choice instead of rejecting it", () => {
    expect(resolveMenuLocale("  vi  ", "en")).toEqual({ locale: "vi", source: "explicit" });
  });
});

describe("resolveMenuText", () => {
  test("falls back to original when no translation is stored", () => {
    expect(
      resolveMenuText({
        original: "Phở bò",
        sourceLanguage: "vi",
        translated: null,
        translationLanguage: null,
        targetLanguage: "en",
        reviewed: true,
      }),
    ).toEqual({
      primary: "Phở bò",
      primaryLang: "vi",
      secondary: null,
      secondaryLang: null,
      provenance: "original",
    });
  });

  test("approved translation leads, original stays secondary", () => {
    expect(
      resolveMenuText({
        original: "Phở bò",
        sourceLanguage: "vi",
        translated: "Beef noodle soup",
        translationLanguage: "en",
        targetLanguage: "en",
        reviewed: true,
      }),
    ).toEqual({
      primary: "Beef noodle soup",
      primaryLang: "en",
      secondary: "Phở bò",
      secondaryLang: "vi",
      provenance: "approved",
    });
  });

  test("same-language request never duplicates the name", () => {
    expect(
      resolveMenuText({
        original: "Phở bò",
        sourceLanguage: "vi",
        translated: "Phở bò",
        translationLanguage: "vi",
        targetLanguage: "vi",
        reviewed: true,
      }),
    ).toEqual({
      primary: "Phở bò",
      primaryLang: "vi",
      secondary: null,
      secondaryLang: null,
      provenance: "original",
    });
  });

  test("a translation for another language does not leak in", () => {
    const display = resolveMenuText({
      original: "Phở bò",
      sourceLanguage: "vi",
      translated: "Beef noodle soup",
      translationLanguage: "en",
      targetLanguage: "ja",
      reviewed: true,
    });

    expect(display.primary).toBe("Phở bò");
    expect(display.secondary).toBeNull();
    expect(display.provenance).toBe("original");
  });

  test("blank or identical translations collapse to original", () => {
    for (const translated of ["   ", "Phở bò"]) {
      const display = resolveMenuText({
        original: "Phở bò",
        sourceLanguage: "vi",
        translated,
        translationLanguage: "en",
        targetLanguage: "en",
        reviewed: true,
      });

      expect(display.secondary).toBeNull();
      expect(display.provenance).toBe("original");
    }
  });

  test("unreviewed provenance stays labeled unverified", () => {
    const display = resolveMenuText({
      original: "Phở bò",
      sourceLanguage: "vi",
      translated: "Beef noodle soup",
      translationLanguage: "en",
      targetLanguage: "en",
      reviewed: false,
    });

    expect(display.provenance).toBe("unverified");
  });
});

describe("menuItemDisplayFor", () => {
  test("VI visitor on a Vietnamese menu sees the original once", () => {
    const display = menuItemDisplayFor(itemFixture(), {
      sourceLanguage: "vi",
      targetLanguage: "vi",
      provenance: "reviewed",
    });

    expect(display.title).toBe("Phở bò");
    expect(display.titleLang).toBe("vi");
    expect(display.subtitle).toBeNull();
    expect(display.nativeName).toBe("Phở bò");
    expect(display.nativeLang).toBe("vi");
    expect(display.provenance).toBe("original");
  });

  test("EN visitor sees localized title, original secondary, native name kept", () => {
    const display = menuItemDisplayFor(itemFixture(), {
      sourceLanguage: "vi",
      targetLanguage: "en",
      provenance: "reviewed",
    });

    expect(display.title).toBe("Beef noodle soup");
    expect(display.titleLang).toBe("en");
    expect(display.subtitle).toBe("Phở bò");
    expect(display.subtitleLang).toBe("vi");
    expect(display.description).toBe("Beef bone broth");
    expect(display.descriptionLang).toBe("en");
    expect(display.nativeName).toBe("Phở bò");
    expect(display.nativeLang).toBe("vi");
    expect(display.provenance).toBe("approved");
  });

  test("missing descriptions stay null instead of invented", () => {
    const display = menuItemDisplayFor(
      itemFixture({ originalDescription: null, translatedDescription: null }),
      { sourceLanguage: "vi", targetLanguage: "en", provenance: "reviewed" },
    );

    expect(display.description).toBeNull();
    expect(display.descriptionLang).toBeNull();
  });

  test("private scans keep unverified provenance", () => {
    const display = menuItemDisplayFor(itemFixture(), {
      sourceLanguage: "vi",
      targetLanguage: "en",
      provenance: "private_scan",
    });

    expect(display.provenance).toBe("unverified");
  });
});

describe("waiter helpers", () => {
  test("waiter card leads with the original menu language", () => {
    const item = itemFixture();
    const firstVariant = item.variants[0];

    if (firstVariant === undefined) {
      throw new Error("waiter variant fixture needs at least one variant");
    }

    expect(waiterDishNameFor(item, "vi")).toEqual({ text: "Phở bò", lang: "vi" });
    expect(waiterVariantLabelFor(firstVariant, "vi")).toEqual({
      text: "Tô lớn",
      lang: "vi",
    });
  });

  test("unknown source language stays und, never guessed", () => {
    expect(waiterDishNameFor(itemFixture(), null)).toEqual({ text: "Phở bò", lang: "und" });
  });
});
