import { Languages } from "lucide-react";

import { SharedSelect, type SharedSelectSection } from "@/components/ui/select";
import { menuCopy } from "@/modules/restaurant-discovery/components/menu-copy";
import {
  HINGLISH_STYLE,
  MENU_READING_LANGUAGES,
  UNAVAILABLE_MENU_LANGUAGES,
  isMenuReadingLanguage,
  menuReadingLanguageNames,
} from "@/modules/restaurant-discovery/menu-language";

/**
 * Compact menu-reading language control. Independent of the application UI
 * locale: a globe icon with the current language plus a Radix listbox of
 * genuinely supported translation targets. The dropdown lists stored
 * targets first (current language prioritized, then venues with reviewed
 * text marked with an availability check), the Hinglish style entry, then
 * disabled Malay/Hindi entries with an honest unavailable note.
 *
 * No native select, no regional suggestion chips, no explanation banner:
 * one visual unit. The Hinglish unavailable notice renders only while the
 * Hinglish style is active. `countryCode` stays in the contract (the panel
 * passes venue metadata) but no longer drives suggestions.
 *
 * Positioning reuses the shared primitive: portaled content with popper
 * collision handling at z-60 (above the mobile bottom sheet and desktop
 * drawer), the repo-wide select scroll-lock behavior from `src/styles.css`
 * (no per-trigger width hacks), and Radix focus return on dismiss.
 */
export function MenuLanguageSelector({
  id,
  value,
  available,
  onChange,
  languageLabel,
  hinglishLabel,
  hinglishUnavailable,
  unavailableLabel,
  moreLanguagesLabel,
  remember,
  rememberLabel,
  onToggleRemember,
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
  readonly remember?: boolean;
  readonly rememberLabel?: string;
  readonly onToggleRemember?: () => void;
}) {
  const availableSet = new Set(available);
  const current = value !== HINGLISH_STYLE && isMenuReadingLanguage(value) ? value : null;

  const orderedReading: Array<string> = [];

  if (current !== null) orderedReading.push(current);

  for (const code of MENU_READING_LANGUAGES) {
    if (code !== current && availableSet.has(code)) orderedReading.push(code);
  }

  for (const code of MENU_READING_LANGUAGES) {
    if (code !== current && !availableSet.has(code)) orderedReading.push(code);
  }

  const readingOptions = orderedReading.map((code) => {
    const name = menuReadingLanguageNames.get(code) ?? code;

    return {
      label: availableSet.has(code) ? `${name} ✓` : name,
      value: code,
    };
  });

  const sections: Array<SharedSelectSection> = [
    { label: languageLabel, options: readingOptions },
    { options: [{ label: hinglishLabel, value: HINGLISH_STYLE }] },
    {
      label: moreLanguagesLabel,
      options: UNAVAILABLE_MENU_LANGUAGES.map((entry) => ({
        disabled: true,
        label: `${entry.label} — ${unavailableLabel}`,
        value: entry.code,
      })),
    },
  ];

  const resolvedRememberLabel = rememberLabel ?? menuCopy(value).rememberMenuLanguage;

  return (
    <div className="menu-panel-lang">
      <SharedSelect
        id={id}
        ariaLabel={languageLabel}
        value={value}
        onValueChange={onChange}
        sections={sections}
        size="compact"
        triggerClassName="w-auto min-w-0 max-w-48 flex-1"
        contentClassName="z-[60]"
        leadingIcon={<Languages aria-hidden="true" className="size-4" />}
      />
      {onToggleRemember === undefined ? null : (
        <label className="inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 text-xs font-semibold text-muted">
          <input
            type="checkbox"
            checked={remember ?? false}
            onChange={onToggleRemember}
            className="size-4 shrink-0 accent-food-orange-dark"
          />
          {resolvedRememberLabel}
        </label>
      )}
      {value === HINGLISH_STYLE ? (
        <p className="menu-panel-lang-note" aria-live="polite">
          {hinglishUnavailable}
        </p>
      ) : null}
    </div>
  );
}
