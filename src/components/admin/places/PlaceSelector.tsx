import { useState, type ReactNode } from "react";

import {
  parseSearchHits,
  placeFnAvailable,
  type PlaceSearchHit,
} from "@/components/admin/places/place-contracts";
import { formatPlaceContext, parsePlaceRef } from "@/components/admin/places/place-grammar";
import { adminPlacesListFn } from "@/modules/food-discovery/place.functions";
import type { Locale, Messages } from "@/shared/i18n";

/**
 * Searchable place selector with geographic context.
 *
 * Two modes, never decorative:
 * - Reference mode (always): a grammar input (`VN`, `place:45:popular`,
 *   `Hanoi@VN`) with a live geographic preview (`Hanoi, VN · associated`)
 *   and inline validation. No raw id is ever shown without its context.
 * - Search mode: typing also queries the registry and offers
 *   `Name (kind, ISO)` hits; picking one fills the canonical `place:<id>`
 *   reference. The search box renders only while its server function is
 *   available (same gating as every Edit trigger).
 */
interface PlaceRefPreview {
  readonly invalid: boolean;
  readonly text: string | null;
}

const previewFor = (raw: string, lang: Locale): PlaceRefPreview => {
  const trimmed = raw.trim();

  if (trimmed === "") {
    return { invalid: false, text: null };
  }

  const parsed = parsePlaceRef(trimmed);

  if (!parsed.ok) {
    return { invalid: true, text: null };
  }

  const { association, ref } = parsed.value;

  if ("city" in ref) {
    return { invalid: false, text: `${ref.city}, ${ref.parentIso} · ${association}` };
  }

  if ("iso" in ref) {
    return { invalid: false, text: `${ref.iso} · ${association}` };
  }

  if (lang === "vi") {
    return { invalid: false, text: `Địa điểm registry #${ref.placeId} · ${association}` };
  }

  return { invalid: false, text: `Registry place #${ref.placeId} · ${association}` };
};

function SearchHits({
  copy,
  hits,
  lang,
  onPick,
  searching,
}: {
  readonly copy: Messages;
  readonly hits: ReadonlyArray<PlaceSearchHit>;
  readonly lang: Locale;
  readonly onPick: (placeId: string) => void;
  readonly searching: boolean;
}): ReactNode {
  if (searching) {
    return <li className="px-3 py-2 text-sm text-muted">{copy.settingsSaving}</li>;
  }

  if (hits.length === 0) {
    return <li className="px-3 py-2 text-sm text-muted">{copy.adminNoResults}</li>;
  }

  return (
    <>
      {hits.map((hit) => (
        <li key={hit.id}>
          <button
            type="button"
            onClick={() => {
              onPick(hit.id);
            }}
            className="flex min-h-11 w-full min-w-0 cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-cream"
          >
            <span className="min-w-0 truncate font-semibold">
              {formatPlaceContext({
                name: hit.name,
                parentName: hit.parentName,
                iso: hit.iso,
                placeId: hit.id,
                lang,
              })}
            </span>
            <span className="shrink-0 text-xs text-muted">{hit.kind}</span>
          </button>
        </li>
      ))}
    </>
  );
}

export function PlaceSelector({
  copy,
  id,
  label,
  lang,
  onChange,
  value,
}: {
  readonly copy: Messages;
  readonly id: string;
  readonly label: string;
  readonly lang: Locale;
  readonly onChange: (value: string) => void;
  readonly value: string;
}): ReactNode {
  const [hits, setHits] = useState<ReadonlyArray<PlaceSearchHit>>([]);
  const [searching, setSearching] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const preview = previewFor(value, lang);

  const searchAvailable = placeFnAvailable("adminPlacesListFn");

  const search = (query: string): void => {
    if (!searchAvailable) {
      return;
    }

    const trimmed = query.trim();

    if (trimmed.length < 2) {
      setSearchOpen(false);

      return;
    }

    setSearching(true);
    setSearchOpen(true);

    void adminPlacesListFn({ data: { query: trimmed, page: 0 } }).then(
      (page) => {
        setHits(parseSearchHits(page));
        setSearching(false);
      },
      () => {
        setHits([]);
        setSearching(false);
      },
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <p id={`${id}-hint`} className="text-sm text-muted">
        {copy.adminPlaceRefHint}
      </p>
      <input
        id={id}
        value={value}
        autoComplete="off"
        aria-describedby={`${id}-hint${preview.invalid ? ` ${id}-error` : ""}`}
        aria-invalid={preview.invalid}
        onChange={(event) => {
          onChange(event.target.value);

          if (searchAvailable) {
            search(event.target.value);
          } else {
            setSearchOpen(false);
          }
        }}
        placeholder="Hanoi@VN:associated"
        className="min-h-11 w-full rounded-lg border border-border-soft bg-white px-3 py-2 font-mono text-sm text-ink outline-none focus-visible:border-brand-blue focus-visible:ring-2 focus-visible:ring-brand-blue/40"
      />
      {preview.text !== null ? (
        <p aria-live="polite" className="text-sm font-semibold text-food-orange-dark">
          {preview.text}
        </p>
      ) : null}
      {preview.invalid ? (
        <p id={`${id}-error`} role="alert" className="text-sm font-semibold text-red-800">
          {copy.adminSaveFailed}
        </p>
      ) : null}
      {searchAvailable && searchOpen ? (
        <ul
          aria-label={copy.adminSelectPlace}
          className="z-10 max-h-56 min-w-0 overflow-y-auto rounded-lg border border-border-soft bg-white shadow-lg"
        >
          <SearchHits
            copy={copy}
            hits={hits}
            lang={lang}
            onPick={(placeId) => {
              onChange(`place:${placeId}`);
              setSearchOpen(false);
            }}
            searching={searching}
          />
        </ul>
      ) : null}
    </div>
  );
}
