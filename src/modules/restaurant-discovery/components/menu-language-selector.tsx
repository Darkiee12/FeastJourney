import { Languages } from "lucide-react";

import {
  HINGLISH_STYLE,
  MENU_READING_LANGUAGES,
  UNAVAILABLE_MENU_LANGUAGES,
  isMenuReadingLanguage,
  menuReadingLanguageNames,
  suggestedMenuLanguagesFor,
} from "@/modules/restaurant-discovery/menu-language";

/**
 * Compact menu-reading language control. Independent of the application UI
 * locale: a globe icon with the current language plus a native select of
 * genuinely supported translation targets. Regional suggestion chips come
 * from trusted venue country metadata and only suggest — tapping one sets
 * the explicit session choice, nothing auto-applies.
 */
export function MenuLanguageSelector({
  id,
  value,
  available,
  countryCode,
  onChange,
  languageLabel,
  hinglishLabel,
  hinglishUnavailable,
  unavailableLabel,
  moreLanguagesLabel,
}: {
  readonly id: string;
  readonly value: string;
  readonly available: ReadonlyArray<string>;
  readonly countryCode: string | null;
  readonly onChange: (value: string) => void;
  readonly languageLabel: string;
  readonly hinglishLabel: string;
  readonly hinglishUnavailable: string;
  readonly unavailableLabel: string;
  readonly moreLanguagesLabel: string;
}) {
  const availableSet = new Set(available);

  const suggestions = suggestedMenuLanguagesFor(countryCode).filter(
    (code) => code !== value && isMenuReadingLanguage(code),
  );

  return (
    <div className="menu-panel-lang">
      <label htmlFor={id} className="menu-panel-lang-label">
        <Languages aria-hidden="true" />
        <span className="sr-only">{languageLabel}</span>
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="menu-panel-lang-select"
        aria-label={languageLabel}
      >
        <optgroup label={languageLabel}>
          {MENU_READING_LANGUAGES.map((code) => (
            <option key={code} value={code}>
              {menuReadingLanguageNames.get(code) ?? code}
              {availableSet.has(code) ? " ✓" : ""}
            </option>
          ))}
        </optgroup>
        <optgroup label="Style">
          <option value={HINGLISH_STYLE}>{hinglishLabel}</option>
        </optgroup>
        <optgroup label={moreLanguagesLabel}>
          {UNAVAILABLE_MENU_LANGUAGES.map((entry) => (
            <option key={entry.code} value={entry.code} disabled>
              {entry.label} — {unavailableLabel}
            </option>
          ))}
        </optgroup>
      </select>
      {suggestions.length > 0 && (
        <div className="menu-panel-lang-suggest">
          {suggestions.map((code) => (
            <button key={code} type="button" onClick={() => onChange(code)}>
              {menuReadingLanguageNames.get(code) ?? code}
            </button>
          ))}
        </div>
      )}
      {value === HINGLISH_STYLE && (
        <p className="menu-panel-lang-note" aria-live="polite">
          {hinglishUnavailable}
        </p>
      )}
    </div>
  );
}
