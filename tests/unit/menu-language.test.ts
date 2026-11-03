import { describe, expect, test } from "bun:test";

import {
  HINGLISH_STYLE,
  UNAVAILABLE_MENU_LANGUAGES,
  detectMenuBrowserLanguage,
  isMenuLanguageChoice,
  isMenuReadingLanguage,
  resolveMenuLanguage,
  suggestedMenuLanguagesFor,
} from "@/modules/restaurant-discovery/menu-language";

describe("menu reading language resolution", () => {
  test("explicit session choice wins over everything", () => {
    expect(resolveMenuLanguage({ explicit: "ja", saved: "vi", app: "en", browser: "fr" })).toBe(
      "ja",
    );
  });

  test("saved preference beats app and browser languages", () => {
    expect(resolveMenuLanguage({ saved: "vi", app: "en", browser: "ja" })).toBe("vi");
  });

  test("application language applies when supported", () => {
    expect(resolveMenuLanguage({ app: "vi", browser: "en" })).toBe("vi");
  });

  test("unsupported app and browser languages fall back to English", () => {
    expect(resolveMenuLanguage({ app: "ms", browser: "hi" })).toBe("en");
    expect(resolveMenuLanguage({})).toBe("en");
  });

  test("blank inputs never count as a choice", () => {
    expect(resolveMenuLanguage({ explicit: "  ", saved: "", app: "vi" })).toBe("vi");
  });

  test("geography, ethnicity, and IP never decide: no such inputs exist", () => {
    expect(resolveMenuLanguage({ app: "en", browser: "en" })).toBe("en");
  });

  test("Malay and Hindi are display-only: never selected, never resolved", () => {
    expect(UNAVAILABLE_MENU_LANGUAGES.map((entry) => entry.code)).toEqual(["ms", "hi"]);
    expect(isMenuLanguageChoice("ms")).toBe(false);
    expect(isMenuLanguageChoice("hi")).toBe(false);
    expect(resolveMenuLanguage({ explicit: "ms", app: "en" })).toBe("en");
    expect(resolveMenuLanguage({ saved: "hi", app: "vi" })).toBe("vi");
  });
});

describe("menu language validation", () => {
  test("only persisted translation codes and Hinglish pass", () => {
    expect(isMenuReadingLanguage("vi")).toBe(true);
    expect(isMenuReadingLanguage("zh")).toBe(true);
    expect(isMenuReadingLanguage("ms")).toBe(false);
    expect(isMenuReadingLanguage("hi")).toBe(false);
    expect(isMenuLanguageChoice(HINGLISH_STYLE)).toBe(true);
    expect(isMenuLanguageChoice("xx")).toBe(false);
  });

  test("browser tags match supported codes honestly", () => {
    expect(detectMenuBrowserLanguage(["ms-MY", "en"])).toBe("en");
    expect(detectMenuBrowserLanguage(["hi-IN", "en-IN"])).toBe("en");
    expect(detectMenuBrowserLanguage(["vi-VN"])).toBe("vi");
    expect(detectMenuBrowserLanguage(["fr-FR"])).toBe("fr");
    expect(detectMenuBrowserLanguage([])).toBeNull();
  });
});

describe("regional suggestions", () => {
  test("Vietnam suggests Vietnamese first", () => {
    expect(suggestedMenuLanguagesFor("VN")).toEqual(["vi", "en"]);
  });

  test("Malaysia suggests supported languages only", () => {
    const suggestions = suggestedMenuLanguagesFor("MY");

    expect(suggestions).toContain("en");
    expect(suggestions).toContain("zh");
    expect(suggestions.includes("ms")).toBe(false);
  });

  test("India does not fabricate Hindi support", () => {
    const suggestions = suggestedMenuLanguagesFor("IN");

    expect(suggestions.includes("hi")).toBe(false);
  });

  test("unknown regions fall back to English", () => {
    expect(suggestedMenuLanguagesFor("XX")).toEqual(["en"]);
    expect(suggestedMenuLanguagesFor(null)).toEqual(["en"]);
  });
});
