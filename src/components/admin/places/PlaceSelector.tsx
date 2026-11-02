import { X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { z } from "zod";

import {
  parseSearchHits,
  placeFnAvailable,
  type PlaceSearchHit,
} from "@/components/admin/places/place-contracts";
import {
  formatPlaceContext,
  isCanonicalPlaceId,
  isVerifiedPlaceRef,
  parsePlaceRef,
} from "@/components/admin/places/place-grammar";
import { adminPlaceDetailFn, adminPlacesListFn } from "@/modules/food-discovery/place.functions";
import type { Locale, Messages } from "@/shared/i18n";

/**
 * Searchable place selector with geographic context.
 *
 * Two modes, never decorative:
 * - Reference mode (default): a grammar input (`VN`, `place:45:popular`,
 *   `Hanoi@VN`) with a live geographic preview (`Hanoi, VN · associated`)
 *   and inline validation. No raw id is ever shown without its context.
 * - Search mode: typing also queries the registry and offers
 *   `Name (kind, ISO)` hits; picking one fills the canonical `place:<id>`
 *   reference. The search box renders only while its server function is
 *   available (same gating as every Edit trigger).
 * - Parent-filter mode (`variant="parentFilter"`): the toolbar variant.
 *   `value` is a canonical decimal place id or `""` (no filter); the input
 *   searches the registry by human-readable name and the selected parent
 *   renders as geographic context (`Hanoi, Vietnam`), never a raw id. The
 *   canonical id still flows out through `onChange`, so filtering semantics
 *   are unchanged.
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

function ReferencePlaceSelector({
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
  const unverified = preview.text !== null && !isVerifiedPlaceRef(value);
  const unverifiedHintId = `${id}-unverified-hint`;

  let describedBy = `${id}-hint`;

  if (preview.invalid) {
    describedBy += ` ${id}-error`;
  }

  if (unverified) {
    describedBy += ` ${unverifiedHintId}`;
  }

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
        aria-describedby={describedBy}
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
      {unverified ? (
        <p id={unverifiedHintId} className="text-sm text-muted">
          {copy.adminPlaceRefUnverified}
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

/** Boundary parser for the selected-parent label: unparseable details keep the `Place #id` fallback. */
const parentFilterDetailSchema = z.object({
  displayName: z.string().nullable(),
  iso3166: z.string().nullable(),
  parents: z.array(z.object({ displayName: z.string().nullable() })),
});

function ParentFilterOption({
  active,
  hit,
  lang,
  listboxId,
  onPick,
}: {
  readonly active: boolean;
  readonly hit: PlaceSearchHit;
  readonly lang: Locale;
  readonly listboxId: string;
  readonly onPick: (hit: PlaceSearchHit) => void;
}): ReactNode {
  const hitLabel = formatPlaceContext({
    name: hit.name,
    parentName: hit.parentName,
    iso: hit.iso,
    placeId: hit.id,
    lang,
  });

  // WAI-ARIA combobox pattern: async search hits carry per-hit metadata
  // (kind) that a native `<option>` cannot host, so the option role is
  // explicit on the list item. Its accessible name mirrors the button text
  // announced as a single option.
  return (
    <li
      key={hit.id}
      id={`${listboxId}-${hit.id}`}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role
      role="option"
      aria-selected={active}
      aria-label={hitLabel}
    >
      <button
        type="button"
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={() => {
          onPick(hit);
        }}
        className={`flex min-h-11 w-full min-w-0 cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm outline-none hover:bg-cream focus-visible:bg-cream ${active ? "bg-cream" : ""}`}
      >
        <span className="min-w-0 truncate font-semibold">{hitLabel}</span>
        <span className="shrink-0 text-xs text-muted">{hit.kind}</span>
      </button>
    </li>
  );
}

function ParentFilterResults({
  activeIndex,
  copy,
  hits,
  lang,
  listboxId,
  onPick,
  searching,
}: {
  readonly activeIndex: number;
  readonly copy: Messages;
  readonly hits: ReadonlyArray<PlaceSearchHit>;
  readonly lang: Locale;
  readonly listboxId: string;
  readonly onPick: (hit: PlaceSearchHit) => void;
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
      {hits.map((hit, index) => (
        <ParentFilterOption
          key={hit.id}
          active={index === activeIndex}
          hit={hit}
          lang={lang}
          listboxId={listboxId}
          onPick={onPick}
        />
      ))}
    </>
  );
}

function ParentFilterSelector({
  copy,
  id,
  label,
  lang,
  onChange,
  placeholder,
  value,
}: {
  readonly copy: Messages;
  readonly id: string;
  readonly label: string;
  readonly lang: Locale;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly value: string;
}): ReactNode {
  const searchAvailable = placeFnAvailable("adminPlacesListFn");
  const [text, setText] = useState("");
  const [hits, setHits] = useState<ReadonlyArray<PlaceSearchHit>>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(new Map());
  const focusedRef = useRef(false);
  const seqRef = useRef(0);
  const listboxId = `${id}-listbox`;

  const fallbackLabel = (placeId: string): string =>
    formatPlaceContext({ name: null, parentName: null, iso: null, placeId, lang });

  // Resolve the human-readable label for a preselected id (deep links and
  // back-navigation arrive with an id but no label). Failures keep the
  // explicit `Place #id` fallback — never a blank control.
  useEffect(() => {
    if (value === "" || !isCanonicalPlaceId(value)) {
      return () => undefined;
    }

    const known = labels.get(value);

    if (known !== undefined) {
      if (!focusedRef.current) {
        setText(known);
      }

      return () => undefined;
    }

    let cancelled = false;

    void adminPlaceDetailFn({ data: { placeId: value } }).then(
      (outcome) => {
        if (cancelled) {
          return;
        }

        const parsed = parentFilterDetailSchema.safeParse(outcome);

        if (!parsed.success) {
          if (!focusedRef.current) {
            setText(fallbackLabel(value));
          }

          return;
        }

        const nearest = parsed.data.parents.at(0);

        const resolvedLabel = formatPlaceContext({
          name: parsed.data.displayName,
          parentName: nearest?.displayName ?? null,
          iso: parsed.data.iso3166,
          placeId: value,
          lang,
        });

        setLabels((previous) => new Map(previous).set(value, resolvedLabel));

        if (!focusedRef.current) {
          setText(resolvedLabel);
        }
      },
      () => {
        if (!cancelled && !focusedRef.current) {
          setText(fallbackLabel(value));
        }
      },
    );

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fallbackLabel is a pure formatter over stable props.
  }, [value, labels, lang]);

  // External clears (toolbar reset, back-navigation) empty the field when idle.
  useEffect(() => {
    if (!focusedRef.current && value === "") {
      setText("");
    }
  }, [value]);

  // Debounced registry search; a sequence guard drops stale responses so
  // fast typing can never show results for an older query.
  useEffect(() => {
    if (!searchAvailable) {
      return () => undefined;
    }

    const query = text.trim();

    if (query.length < 2) {
      setHits([]);
      setSearching(false);
      setOpen(false);

      return () => undefined;
    }

    setSearching(true);

    const timer = setTimeout(() => {
      seqRef.current += 1;
      const seq = seqRef.current;

      void adminPlacesListFn({ data: { query, page: 0 } }).then(
        (page) => {
          if (seqRef.current !== seq) {
            return;
          }

          setHits(parseSearchHits(page));
          setSearching(false);
          setOpen(true);
          setActiveIndex(0);
        },
        () => {
          if (seqRef.current !== seq) {
            return;
          }

          setHits([]);
          setSearching(false);
          setOpen(true);
        },
      );
    }, 200);

    return () => {
      clearTimeout(timer);
    };
  }, [text, searchAvailable]);

  const pick = (hit: PlaceSearchHit): void => {
    const hitLabel = formatPlaceContext({
      name: hit.name,
      parentName: hit.parentName,
      iso: hit.iso,
      placeId: hit.id,
      lang,
    });

    setLabels((previous) => new Map(previous).set(hit.id, hitLabel));
    onChange(hit.id);
    setText(hitLabel);
    setOpen(false);
  };

  const clear = (): void => {
    onChange("");
    setText("");
    setHits([]);
    setOpen(false);
  };

  const handleTextChange = (next: string): void => {
    setText(next);

    if (next === "" && value !== "") {
      onChange("");
    }
  };

  const handleFocus = (): void => {
    focusedRef.current = true;

    if (value !== "") {
      setText("");
    }
  };

  const handleBlur = (): void => {
    focusedRef.current = false;
    setOpen(false);

    if (value !== "") {
      setText(labels.get(value) ?? fallbackLabel(value));
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" && (open || hits.length > 0)) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((previous) => {
        if (hits.length === 0) {
          return 0;
        }

        return (previous + 1) % hits.length;
      });
    } else if (event.key === "ArrowUp" && open) {
      event.preventDefault();
      setActiveIndex((previous) => {
        if (hits.length === 0) {
          return 0;
        }

        return (previous - 1 + hits.length) % hits.length;
      });
    } else if (event.key === "Enter" && open && hits.length > 0) {
      // A highlighted hit wins; otherwise Enter bubbles to the toolbar form
      // and applies the filters — a single submit per keypress, never two.
      const hit = hits.at(activeIndex);

      if (hit === undefined) {
        return;
      }

      event.preventDefault();
      pick(hit);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  const activeHit = hits.at(activeIndex);

  const activeDescendant =
    open && activeHit !== undefined ? `${listboxId}-${activeHit.id}` : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <div className="relative min-w-0">
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={activeDescendant}
          aria-autocomplete="list"
          autoComplete="off"
          value={text}
          placeholder={placeholder}
          onChange={(event) => {
            handleTextChange(event.target.value);
          }}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          className="min-h-11 w-full min-w-0 rounded-lg border border-border-soft bg-white px-3 py-2 pr-10 text-sm text-ink outline-none focus-visible:border-brand-blue focus-visible:ring-2 focus-visible:ring-brand-blue/40"
        />
        {value === "" ? null : (
          <button
            type="button"
            onClick={clear}
            aria-label={copy.adminRemove}
            title={copy.adminRemove}
            className="absolute top-1/2 right-1 inline-flex min-h-9 min-w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted outline-none hover:bg-cream hover:text-ink focus-visible:ring-2 focus-visible:ring-brand-blue/40"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        )}
        {searchAvailable && open ? (
          <ul
            id={listboxId}
            // WAI-ARIA combobox pattern: async search hits with per-hit
            // metadata cannot live in a native `<select>`/`<datalist>`, so
            // the listbox role is explicit here. Absolutely positioned, so
            // it never shifts toolbar layout or escapes horizontally.
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role
            role="listbox"
            aria-label={label}
            className="absolute inset-x-0 top-full z-30 mt-1 max-h-56 min-w-0 overflow-y-auto rounded-lg border border-border-soft bg-white py-1 shadow-lg"
          >
            <ParentFilterResults
              activeIndex={activeIndex}
              copy={copy}
              hits={hits}
              lang={lang}
              listboxId={listboxId}
              onPick={pick}
              searching={searching}
            />
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function PlaceSelector({
  copy,
  id,
  label,
  lang,
  onChange,
  placeholder,
  value,
  variant,
}: {
  readonly copy: Messages;
  readonly id: string;
  readonly label: string;
  readonly lang: Locale;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly value: string;
  readonly variant?: "reference" | "parentFilter";
}): ReactNode {
  if (variant === "parentFilter") {
    return (
      <ParentFilterSelector
        copy={copy}
        id={id}
        label={label}
        lang={lang}
        onChange={onChange}
        placeholder={placeholder}
        value={value}
      />
    );
  }

  return (
    <ReferencePlaceSelector
      copy={copy}
      id={id}
      label={label}
      lang={lang}
      onChange={onChange}
      value={value}
    />
  );
}
