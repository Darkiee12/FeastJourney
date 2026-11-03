import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";

import {
  HINGLISH_STYLE,
  UNAVAILABLE_MENU_LANGUAGES,
  changeMenuLanguage,
  clearSavedMenuLanguage,
  detectMenuBrowserLanguage,
  getMenuLanguageClientSnapshot,
  getMenuLanguageServerSnapshot,
  isMenuLanguageChoice,
  isMenuReadingLanguage,
  readMenuLanguageRemember,
  readSavedMenuLanguage,
  resetMenuLanguageSessionForTests,
  resolveMenuLanguage,
  setMenuLanguageRemember,
  suggestedMenuLanguagesFor,
  useMenuLanguage,
  writeSavedMenuLanguage,
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

/** Map-backed stand-in for window.localStorage (bun has no DOM window). */
interface FakeMenuWindow {
  readonly localStorage: {
    readonly getItem: (key: string) => string | null;
    readonly setItem: (key: string, value: string) => void;
    readonly removeItem: (key: string) => void;
  };
  readonly addEventListener: () => void;
  readonly removeEventListener: () => void;
  readonly dispatchEvent: () => boolean;
}

function fakeMenuWindow(store: Map<string, string>): FakeMenuWindow {
  return {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
}

function installFakeMenuWindow(store: Map<string, string>): void {
  Object.defineProperty(globalThis, "window", {
    value: fakeMenuWindow(store),
    configurable: true,
    writable: true,
  });
}

function removeFakeMenuWindow(): void {
  Reflect.deleteProperty(globalThis, "window");
}

function MenuLanguageProbe({ app }: { readonly app: string }): ReactNode {
  const state = useMenuLanguage(app);

  return createElement(
    "p",
    null,
    `${state.menuLang}:${state.remember}:${state.changeMenuLanguage.name}:${state.setRemember.name}`,
  );
}

describe("menu language remember flag", () => {
  // Mirrors the private storage keys in menu-language.ts.
  const SAVED_KEY = "feastjourney.menu-reading-language";
  const REMEMBER_KEY = "feastjourney.menu-reading-language.remember";

  let store: Map<string, string>;

  beforeEach(() => {
    resetMenuLanguageSessionForTests();
    store = new Map<string, string>();
    installFakeMenuWindow(store);
  });

  afterEach(() => {
    resetMenuLanguageSessionForTests();
    removeFakeMenuWindow();
  });

  test("remember is off by default and invalid flags mean off", () => {
    expect(readMenuLanguageRemember()).toBe(false);
    store.set(REMEMBER_KEY, "yes");
    expect(readMenuLanguageRemember()).toBe(false);
  });

  test("explicit choice is session-only until remember turns on", () => {
    changeMenuLanguage("ja");
    expect(getMenuLanguageClientSnapshot("en")).toBe("ja");
    expect(readSavedMenuLanguage()).toBeNull();

    setMenuLanguageRemember(true, getMenuLanguageClientSnapshot("en"));
    expect(readMenuLanguageRemember()).toBe(true);
    expect(readSavedMenuLanguage()).toBe("ja");
  });

  test("remembered choice beats an app language change", () => {
    setMenuLanguageRemember(true, "ja");
    expect(getMenuLanguageClientSnapshot("en")).toBe("ja");
    expect(getMenuLanguageClientSnapshot("vi")).toBe("ja");
  });

  test("turning remember off clears the saved value and the session choice continues", () => {
    changeMenuLanguage("ja");
    setMenuLanguageRemember(true, getMenuLanguageClientSnapshot("en"));
    setMenuLanguageRemember(false, getMenuLanguageClientSnapshot("en"));

    expect(readMenuLanguageRemember()).toBe(false);
    expect(readSavedMenuLanguage()).toBeNull();
    expect(getMenuLanguageClientSnapshot("en")).toBe("ja");
  });

  test("turning remember off with no prior explicit choice promotes the current one", () => {
    setMenuLanguageRemember(true, "vi");
    setMenuLanguageRemember(false, getMenuLanguageClientSnapshot("vi"));

    expect(readSavedMenuLanguage()).toBeNull();
    expect(getMenuLanguageClientSnapshot("en")).toBe("vi");
  });

  test("clearSavedMenuLanguage drops the persisted value", () => {
    writeSavedMenuLanguage("ja");
    expect(readSavedMenuLanguage()).toBe("ja");
    clearSavedMenuLanguage();
    expect(readSavedMenuLanguage()).toBeNull();
  });

  test("app language change updates the default when nothing overrides", () => {
    expect(getMenuLanguageClientSnapshot("en")).toBe("en");
    expect(getMenuLanguageClientSnapshot("vi")).toBe("vi");
  });

  test("explicit beats app", () => {
    changeMenuLanguage("fr");
    expect(getMenuLanguageClientSnapshot("vi")).toBe("fr");
    expect(resolveMenuLanguage({ explicit: "fr", saved: "ja", app: "vi", browser: "es" })).toBe(
      "fr",
    );
  });

  test("browser is the fallback when the app language is unsupported", () => {
    expect(resolveMenuLanguage({ app: "ms", browser: "fr" })).toBe("fr");
    expect(resolveMenuLanguage({ app: "ms", browser: "hi" })).toBe("en");
  });

  test("invalid stored and session values are ignored", () => {
    store.set(SAVED_KEY, "xx");
    store.set(REMEMBER_KEY, "1");
    expect(readSavedMenuLanguage()).toBeNull();
    expect(getMenuLanguageClientSnapshot("vi")).toBe("vi");

    writeSavedMenuLanguage("xx");
    expect(readSavedMenuLanguage()).toBeNull();

    resetMenuLanguageSessionForTests();
    changeMenuLanguage("xx");
    changeMenuLanguage("  ");
    expect(getMenuLanguageClientSnapshot("en")).toBe("en");
  });

  test("Hinglish passes through as an explicit and remembered choice", () => {
    changeMenuLanguage(HINGLISH_STYLE);
    expect(getMenuLanguageClientSnapshot("en")).toBe(HINGLISH_STYLE);

    setMenuLanguageRemember(true, getMenuLanguageClientSnapshot("en"));
    expect(readSavedMenuLanguage()).toBe(HINGLISH_STYLE);
    expect(getMenuLanguageClientSnapshot("vi")).toBe(HINGLISH_STYLE);
  });
});

describe("menu language server snapshot", () => {
  test("server snapshot resolves from the app language only", () => {
    resetMenuLanguageSessionForTests();
    expect(getMenuLanguageServerSnapshot("vi")).toBe("vi");
    expect(getMenuLanguageServerSnapshot("ms")).toBe("en");
    resetMenuLanguageSessionForTests();
  });

  test("hook server-renders from the app language without browser globals", () => {
    resetMenuLanguageSessionForTests();
    removeFakeMenuWindow();

    expect(renderToString(createElement(MenuLanguageProbe, { app: "vi" }))).toContain(
      "vi:false:changeMenuLanguage:setRemember",
    );
    resetMenuLanguageSessionForTests();
  });
});
