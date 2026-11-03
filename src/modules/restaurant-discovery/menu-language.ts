/**
 * Independent menu-reading language preference.
 *
 * The application UI locale and the language a traveler reads menus in are
 * different preferences: someone may navigate in English but read menus in
 * Malay. Menu language therefore resolves through its own chain and never
 * changes the application UI.
 *
 * Resolution order: explicit session choice > saved preference > current
 * application language (when supported) > browser language (when supported)
 * > English fallback. Geolocation, ethnicity, or IP never decide.
 *
 * Only languages with a persisted, review-gated translation path are
 * offered as reading targets (the seven CHECK-constrained codes). Hinglish
 * is modeled explicitly as a presentation style layered over English with
 * an honest unavailable notice — never a silent relabel of English or Hindi.
 */

export const MENU_READING_LANGUAGES = ["en", "vi", "ja", "zh", "ko", "fr", "es"] as const;

export type MenuReadingLanguage = (typeof MENU_READING_LANGUAGES)[number];

/** Presentation style layered over stored English; unavailable Hinglish
 *  text is never synthesized — the UI says so explicitly. */
export const HINGLISH_STYLE = "hinglish";

export type MenuLanguageChoice = MenuReadingLanguage | typeof HINGLISH_STYLE;

/** Display-only entries for languages travelers ask about but that have
 *  no persisted, review-gated translation path. Listed as disabled options
 *  with an honest unavailable note — never selectable, never silent. */
export const UNAVAILABLE_MENU_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "ms", label: "Bahasa Melayu (Malay)" },
  { code: "hi", label: "हिन्दी (Hindi)" },
];

/** Human-readable endonyms for the selector; raw ISO codes never render. */
export const menuReadingLanguageNames: ReadonlyMap<string, string> = new Map([
  ["en", "English"],
  ["vi", "Tiếng Việt"],
  ["ja", "日本語"],
  ["zh", "中文 (简体)"],
  ["ko", "한국어"],
  ["fr", "Français"],
  ["es", "Español"],
]);

export function isMenuLanguageChoice(
  value: string | null | undefined,
): value is MenuLanguageChoice {
  if (value === HINGLISH_STYLE) return true;

  if (value === null || value === undefined) return false;

  return isMenuReadingLanguage(value.trim());
}

/** Narrows without assertions: loop comparison keeps the literal union. */
export function isMenuReadingLanguage(code: string): code is MenuReadingLanguage {
  for (const entry of MENU_READING_LANGUAGES) {
    if (entry === code) return true;
  }

  return false;
}

/**
 * Resolve the menu-reading language. First valid choice wins; unknown or
 * blank inputs never count. Defaults to English.
 */
export function resolveMenuLanguage(input: {
  readonly explicit?: string | null | undefined;
  readonly saved?: string | null | undefined;
  readonly app?: string | null | undefined;
  readonly browser?: string | null | undefined;
}): MenuReadingLanguage | typeof HINGLISH_STYLE {
  const candidates = [input.explicit, input.saved, input.app, input.browser];

  for (const candidate of candidates) {
    const cleaned = candidate?.trim() ?? "";

    if (cleaned !== "" && isMenuLanguageChoice(cleaned)) return cleaned;
  }

  return "en";
}

const MENU_STORAGE_KEY = "feastjourney.menu-reading-language";

/** Saved preference only: a benign UI choice, never private scan text. */
export function readSavedMenuLanguage(): string | null {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") return null;

  try {
    const saved = window.localStorage.getItem(MENU_STORAGE_KEY);

    return saved !== null && isMenuLanguageChoice(saved) ? saved : null;
  } catch {
    return null;
  }
}

export function writeSavedMenuLanguage(value: string): void {
  if (!isMenuLanguageChoice(value)) return;

  if (typeof window === "undefined" || typeof window.localStorage === "undefined") return;

  try {
    window.localStorage.setItem(MENU_STORAGE_KEY, value);
  } catch {
    // Private mode or quota: the session choice still applies.
  }
}

/**
 * Match browser language tags against genuinely supported reading targets.
 * Hindi, Malay, and other unsupported codes honestly yield null instead of
 * collapsing onto an unrelated language. Nullish input (non-browser
 * runtimes leave navigator.languages undefined) yields null.
 */
export function detectMenuBrowserLanguage(
  languages: ReadonlyArray<string> | null | undefined,
): string | null {
  if (languages === null || languages === undefined) return null;

  for (const tag of languages) {
    const primary = tag.split("-")[0]?.trim().toLowerCase() ?? "";

    if (primary !== "" && isMenuReadingLanguage(primary)) return primary;
  }

  return null;
}

/**
 * Regional suggestions from trusted venue country metadata. Suggestions
 * only — never auto-applied — and restricted to genuinely supported reading
 * targets. Regions without a supported translation fall back to English.
 */
export function suggestedMenuLanguagesFor(
  countryCode: string | null | undefined,
): ReadonlyArray<string> {
  const code = countryCode?.trim().toUpperCase() ?? "";

  if (code === "VN") return ["vi", "en"];

  if (code === "MY" || code === "SG") return ["en", "zh"];

  if (code === "JP") return ["ja", "en"];

  if (code === "KR") return ["ko", "en"];

  if (code === "CN" || code === "TW" || code === "HK") return ["zh", "en"];

  if (code === "FR" || code === "BE" || code === "CH") return ["fr", "en"];

  if (code === "ES" || code === "MX") return ["es", "en"];

  return ["en"];
}
