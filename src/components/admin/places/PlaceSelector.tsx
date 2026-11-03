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
  parsePlaceRef,
} from "@/components/admin/places/place-grammar";
import { adminPlaceDetailFn, adminPlacesListFn } from "@/modules/food-discovery/place.functions";
import type { Locale, Messages } from "@/shared/i18n";

/**
 * Shared searchable place picker with geographic context.
 *
 * One registry search core (`useRegistrySearch` + `RegistrySearchBox`)
 * with thin adapters for the two value shapes in the admin:
 * - Canonical-id mode (`variant="parentFilter"`, the default for new
 *   flows): `value` is a decimal registry id or `""`. Picking from search
 *   is the normal path; no raw id is ever shown without its context.
 * - Grammar-reference mode (default variant): `value` is the legacy
 *   `place:<id>` reference string (kept for the place-parent editor).
 *   Search is still the normal path — picking fills the canonical
 *   `place:<id>` reference and free grammar is rejected as invalid.
 *
 * Search quality contract (both modes): debounced queries, a bounded
 * result cache, stale-response cancellation, loading/empty/error rows,
 * full keyboard navigation, correct focus handling, a clear affordance,
 * human-readable selected labels, and contextual errors. Existing links
 * keep an explicit `Place #id` fallback so a missing display name never
 * loses the association.
 */

const SEARCH_CACHE_LIMIT = 50;
const LABEL_CACHE_LIMIT = 200;

/** Bounded parent-name resolutions backing search-hit enrichment. */
const PARENT_CACHE_LIMIT = 200;

/** Visible dropdown rows enriched with parent context (matches max-h-56 list). */
const PARENT_ENRICH_LIMIT = 8;

const searchCache = new Map<string, ReadonlyArray<PlaceSearchHit>>();
const labelCache = new Map<string, string>();
const parentCache = new Map<string, string | null>();

const rememberSearch = (query: string, hits: ReadonlyArray<PlaceSearchHit>): void => {
  searchCache.set(query, hits);

  if (searchCache.size > SEARCH_CACHE_LIMIT) {
    const oldest = searchCache.keys().next();

    if (!oldest.done) {
      searchCache.delete(oldest.value);
    }
  }
};

const labelKey = (placeId: string, lang: Locale): string => `${placeId}:${lang}`;

const rememberLabel = (placeId: string, label: string, lang: Locale): void => {
  labelCache.set(labelKey(placeId, lang), label);

  if (labelCache.size > LABEL_CACHE_LIMIT) {
    const oldest = labelCache.keys().next();

    if (!oldest.done) {
      labelCache.delete(oldest.value);
    }
  }
};

const rememberParent = (placeId: string, parentName: string | null): void => {
  parentCache.set(placeId, parentName);

  if (parentCache.size > PARENT_CACHE_LIMIT) {
    const oldest = parentCache.keys().next();

    if (!oldest.done) {
      parentCache.delete(oldest.value);
    }
  }
};

/** One parent-context resolution backing search-hit enrichment. */
interface ParentResolution {
  readonly id: string;
  readonly parentName: string | null;
}

/** Fills resolved parent names into hits; unresolved hits pass through untouched. */
const withCachedParents = (hits: ReadonlyArray<PlaceSearchHit>): ReadonlyArray<PlaceSearchHit> =>
  hits.map((hit) => {
    if (hit.parentName !== null || !parentCache.has(hit.id)) {
      return hit;
    }

    return { ...hit, parentName: parentCache.get(hit.id) ?? null };
  });

/** Boundary parser for the selected-place label: unparseable details keep the `Place #id` fallback. */
const placeLabelSchema = z.object({
  displayName: z.string().nullable(),
  iso3166: z.string().nullable(),
  parents: z.array(z.object({ displayName: z.string().nullable() })),
});

/**
 * Human-readable label for a canonical registry id. Resolves through
 * `adminPlaceDetailFn` once per id (module cache shared by every picker
 * on the page) and falls back to the caller snapshot — never blank, so
 * existing associations survive display-name gaps.
 */
export function usePlaceDisplayName(
  placeId: string | null,
  fallback: string,
  lang: Locale,
): string {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (placeId === null || labelCache.has(labelKey(placeId, lang))) {
      return () => undefined;
    }

    let cancelled = false;

    void adminPlaceDetailFn({ data: { placeId } }).then(
      (outcome) => {
        if (cancelled) {
          return;
        }

        const parsed = placeLabelSchema.safeParse(outcome);
        const nearest = parsed.success ? parsed.data.parents.at(0) : undefined;

        rememberLabel(
          placeId,
          formatPlaceContext({
            name: parsed.success ? parsed.data.displayName : null,
            parentName: nearest?.displayName ?? null,
            iso: parsed.success ? parsed.data.iso3166 : null,
            placeId,
            lang,
          }),
          lang,
        );
        setTick((count) => count + 1);
      },
      () => {
        if (!cancelled) {
          setTick((count) => count + 1);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [placeId, lang]);

  if (placeId === null) {
    return fallback;
  }

  return labelCache.get(labelKey(placeId, lang)) ?? fallback;
}

interface RegistrySearch {
  readonly hits: ReadonlyArray<PlaceSearchHit>;
  readonly searching: boolean;
  readonly failed: boolean;
  readonly retry: () => void;
}

/**
 * Debounced registry search over `adminPlacesListFn`. Queries shorter
 * than two characters read as idle (no request). Nothing is written
 * synchronously inside the effect: visible hits, loading, and failure are
 * derived during render from the cache plus the last settled fetch, keyed
 * by query — so fast typing can never flash results for an older query,
 * and effect cleanup (timer clear plus a sequence bump) cancels in-flight
 * resolutions on unmount or query change.
 */
function useRegistrySearch(query: string, enabled: boolean): RegistrySearch {
  const trimmed = query.trim();
  const active = enabled && trimmed.length >= 2;
  const cached = active ? searchCache.get(trimmed) : undefined;
  const detailAvailable = placeFnAvailable("adminPlaceDetailFn");

  const [fetched, setFetched] = useState<{
    readonly query: string;
    readonly hits: ReadonlyArray<PlaceSearchHit>;
  } | null>(null);

  const [failedQuery, setFailedQuery] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!active || cached !== undefined || failedQuery === trimmed) {
      return () => undefined;
    }

    seqRef.current += 1;
    const seq = seqRef.current;

    // Bounded parent-context enrichment for visible hits: the list
    // projection carries no parent field, so the nearest-parent name
    // resolves through the detail fn (locale-independent preferred-name
    // election, cached per place). Same seq guard as the search fetch —
    // stale resolutions never overwrite a newer query.
    const enrichParents = (searchQuery: string, hits: ReadonlyArray<PlaceSearchHit>): void => {
      if (!detailAvailable) {
        return;
      }

      const targets = hits
        .filter((hit) => hit.parentName === null && !parentCache.has(hit.id))
        .slice(0, PARENT_ENRICH_LIMIT);

      if (targets.length === 0) {
        return;
      }

      void Promise.all(
        targets.map((target) =>
          adminPlaceDetailFn({ data: { placeId: target.id } }).then(
            (outcome): ParentResolution => {
              const parsed = placeLabelSchema.safeParse(outcome);
              const nearest = parsed.success ? parsed.data.parents.at(0) : undefined;

              return { id: target.id, parentName: nearest?.displayName ?? null };
            },
            (): ParentResolution => ({
              id: target.id,
              parentName: null,
            }),
          ),
        ),
      ).then((resolved) => {
        if (seqRef.current !== seq) {
          return;
        }

        for (const entry of resolved) {
          rememberParent(entry.id, entry.parentName);
        }

        const merged = withCachedParents(hits);

        if (merged.some((hit, index) => hit.parentName !== hits[index]?.parentName)) {
          rememberSearch(searchQuery, merged);
          setFetched((current) =>
            current !== null && current.query === searchQuery
              ? { query: searchQuery, hits: merged }
              : current,
          );
        }
      });
    };

    const timer = setTimeout(() => {
      void adminPlacesListFn({ data: { query: trimmed, page: 0 } }).then(
        (page) => {
          if (seqRef.current !== seq) {
            return;
          }

          const parsed = withCachedParents(parseSearchHits(page));

          rememberSearch(trimmed, parsed);
          setFailedQuery((current) => (current === trimmed ? null : current));
          setFetched({ query: trimmed, hits: parsed });
          enrichParents(trimmed, parsed);
        },
        () => {
          if (seqRef.current !== seq) {
            return;
          }

          setFailedQuery(trimmed);
        },
      );
    }, 200);

    return () => {
      clearTimeout(timer);
      seqRef.current += 1;
    };
  }, [trimmed, active, cached, failedQuery, detailAvailable]);

  const settledHits = fetched !== null && fetched.query === trimmed ? fetched.hits : null;

  // Cache entries predate later parent resolutions; re-apply them on read
  // so repeat queries render enriched context without refetching.
  let hits: ReadonlyArray<PlaceSearchHit> = [];

  if (active) {
    if (cached !== undefined) {
      hits = withCachedParents(cached);
    } else if (settledHits !== null) {
      hits = settledHits;
    }
  }

  const failed = active && cached === undefined && failedQuery === trimmed;
  const searching = active && cached === undefined && settledHits === null && !failed;

  return {
    hits,
    searching,
    failed,
    retry: () => {
      setFailedQuery(null);
    },
  };
}

function RegistryOption({
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

/**
 * Accessible registry combobox body shared by both adapters: one
 * keyboard-navigable listbox with loading, error-with-retry, and empty
 * states plus an optional empty-state slot (e.g. a missing-place action).
 * Controlled by the adapter (text/open/active index live there) so each
 * value shape keeps its own selection semantics.
 */
function RegistryResults({
  activeIndex,
  copy,
  emptySlot,
  error,
  hits,
  lang,
  listboxId,
  onPick,
  onRetry,
  searching,
}: {
  readonly activeIndex: number;
  readonly copy: Messages;
  readonly emptySlot?: ReactNode;
  readonly error: boolean;
  readonly hits: ReadonlyArray<PlaceSearchHit>;
  readonly lang: Locale;
  readonly listboxId: string;
  readonly onPick: (hit: PlaceSearchHit) => void;
  readonly onRetry: () => void;
  readonly searching: boolean;
}): ReactNode {
  if (searching) {
    return (
      <li className="px-3 py-2 text-sm text-muted">
        <output>{copy.settingsSaving}</output>
      </li>
    );
  }

  if (error) {
    return (
      <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="text-sm font-semibold text-red-800">{copy.adminLoadFailed}</span>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-9 cursor-pointer items-center rounded-md border border-border-soft px-3 text-sm font-semibold hover:bg-cream"
        >
          {copy.commonRetry}
        </button>
      </li>
    );
  }

  if (hits.length === 0) {
    return <li className="px-3 py-2 text-sm text-muted">{emptySlot ?? copy.adminNoResults}</li>;
  }

  return (
    <>
      {hits.map((hit, index) => (
        <RegistryOption
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

function RegistrySearchBox({
  activeIndex,
  copy,
  emptySlot,
  error,
  hasSelection,
  hits,
  id,
  label,
  lang,
  listLabel,
  onActiveIndexChange,
  onBlur,
  onClear,
  onFocus,
  onPick,
  onRetry,
  onTextChange,
  open,
  placeholder,
  searching,
  text,
}: {
  readonly activeIndex: number;
  readonly copy: Messages;
  readonly emptySlot?: ReactNode;
  readonly error: boolean;
  readonly hasSelection: boolean;
  readonly hits: ReadonlyArray<PlaceSearchHit>;
  readonly id: string;
  readonly label?: string;
  readonly lang: Locale;
  readonly listLabel: string;
  readonly onActiveIndexChange: (index: number) => void;
  readonly onBlur: () => void;
  readonly onClear?: () => void;
  readonly onFocus: () => void;
  readonly onPick: (hit: PlaceSearchHit) => void;
  readonly onRetry: () => void;
  readonly onTextChange: (value: string) => void;
  readonly open: boolean;
  readonly placeholder: string;
  readonly searching: boolean;
  readonly text: string;
}): ReactNode {
  const listboxId = `${id}-listbox`;

  // The list opens only while there is something to report: an in-flight
  // search, a retryable failure, or a submitted query. Focusing an empty
  // field never suggests "no places exist".
  const listOpen = open && (searching || error || text.trim().length >= 2);

  useEffect(() => {
    onActiveIndexChange(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset highlight whenever a new result page arrives.
  }, [hits]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" && (listOpen || hits.length > 0)) {
      event.preventDefault();
      onActiveIndexChange(hits.length === 0 ? 0 : (activeIndex + 1) % hits.length);
    } else if (event.key === "ArrowUp" && listOpen) {
      event.preventDefault();
      onActiveIndexChange(hits.length === 0 ? 0 : (activeIndex - 1 + hits.length) % hits.length);
    } else if (event.key === "Enter" && listOpen && hits.length > 0) {
      // A highlighted hit wins; otherwise Enter bubbles to the owning form
      // (toolbar apply, dialog save) — a single submit per keypress, never two.
      const hit = hits.at(activeIndex);

      if (hit === undefined) {
        return;
      }

      event.preventDefault();
      onPick(hit);
    } else if (event.key === "Escape" && listOpen) {
      event.preventDefault();
      onBlur();
    }
  };

  const activeHit = listOpen ? hits.at(activeIndex) : undefined;
  const activeDescendant = activeHit !== undefined ? `${listboxId}-${activeHit.id}` : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {label === undefined ? null : (
        <label htmlFor={id} className="text-sm font-semibold">
          {label}
        </label>
      )}
      <div className="relative min-w-0">
        <input
          id={id}
          role="combobox"
          aria-expanded={listOpen}
          aria-controls={listboxId}
          aria-activedescendant={activeDescendant}
          aria-autocomplete="list"
          aria-busy={searching}
          autoComplete="off"
          value={text}
          placeholder={placeholder}
          onChange={(event) => {
            onTextChange(event.target.value);
          }}
          onFocus={onFocus}
          onBlur={onBlur}
          onKeyDown={handleKeyDown}
          className="min-h-11 w-full min-w-0 rounded-lg border border-border-soft bg-white px-3 py-2 pr-10 text-sm text-ink outline-none focus-visible:border-brand-blue focus-visible:ring-2 focus-visible:ring-brand-blue/40"
        />
        {onClear === undefined || !hasSelection ? null : (
          <button
            type="button"
            onClick={onClear}
            aria-label={copy.adminRemove}
            title={copy.adminRemove}
            className="absolute top-1/2 right-1 inline-flex min-h-9 min-w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted outline-none hover:bg-cream hover:text-ink focus-visible:ring-2 focus-visible:ring-brand-blue/40"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        )}
        {listOpen ? (
          <ul
            id={listboxId}
            // WAI-ARIA combobox pattern: async search hits with per-hit
            // metadata cannot live in a native `<select>`/`<datalist>`, so
            // the listbox role is explicit here. Absolutely positioned, so
            // it never shifts surrounding layout or escapes horizontally.
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role
            role="listbox"
            aria-label={listLabel}
            className="absolute inset-x-0 top-full z-30 mt-1 max-h-56 min-w-0 overflow-y-auto rounded-lg border border-border-soft bg-white py-1 shadow-lg"
          >
            <RegistryResults
              activeIndex={activeIndex}
              copy={copy}
              emptySlot={emptySlot}
              error={error}
              hits={hits}
              lang={lang}
              listboxId={listboxId}
              onPick={onPick}
              onRetry={onRetry}
              searching={searching}
            />
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function ParentFilterSelector({
  copy,
  emptySlot,
  id,
  label,
  lang,
  onChange,
  onPickHit,
  placeholder,
  value,
}: {
  readonly copy: Messages;
  readonly emptySlot?: ReactNode;
  readonly id: string;
  readonly label: string;
  readonly lang: Locale;
  readonly onChange: (value: string) => void;
  readonly onPickHit?: (hit: PlaceSearchHit) => void;
  readonly placeholder?: string;
  readonly value: string;
}): ReactNode {
  const searchAvailable = placeFnAvailable("adminPlacesListFn");
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const focusedRef = useRef(false);

  const canonical = isCanonicalPlaceId(value) ? value.trim() : null;

  const fallbackLabel =
    value === ""
      ? ""
      : formatPlaceContext({ name: null, parentName: null, iso: null, placeId: value, lang });

  const displayName = usePlaceDisplayName(canonical, fallbackLabel, lang);
  const { hits, searching, failed, retry } = useRegistrySearch(text, searchAvailable);

  // External clears (toolbar reset, back-navigation) empty the field when idle.
  useEffect(() => {
    if (!focusedRef.current && value === "") {
      setText("");
    }
  }, [value]);

  // A resolved label replaces the draft once the user leaves the field, so
  // a preselected id (deep links, back-navigation) renders its context.
  useEffect(() => {
    if (!focusedRef.current && value !== "") {
      setText(displayName);
    }
  }, [value, displayName]);

  const pick = (hit: PlaceSearchHit): void => {
    // Remember the hit label first so the display effect below renders it
    // immediately; the detail fetch upgrades it with parent context.
    rememberLabel(
      hit.id,
      formatPlaceContext({
        name: hit.name,
        parentName: hit.parentName,
        iso: hit.iso,
        placeId: hit.id,
        lang,
      }),
      lang,
    );
    onChange(hit.id);
    onPickHit?.(hit);
    setOpen(false);
  };

  const clear = (): void => {
    onChange("");
    setText("");
    setOpen(false);
  };

  const handleTextChange = (next: string): void => {
    setText(next);
    setOpen(true);

    if (next === "" && value !== "") {
      onChange("");
    }
  };

  const handleFocus = (): void => {
    focusedRef.current = true;

    if (value !== "") {
      setText("");
    }

    setOpen(true);
  };

  const handleBlur = (): void => {
    focusedRef.current = false;
    setOpen(false);

    if (value !== "") {
      setText(displayName);
    }
  };

  return (
    <RegistrySearchBox
      activeIndex={activeIndex}
      copy={copy}
      emptySlot={emptySlot}
      error={failed}
      hasSelection={value !== ""}
      hits={hits}
      id={id}
      label={label}
      lang={lang}
      listLabel={label}
      onActiveIndexChange={setActiveIndex}
      onBlur={handleBlur}
      onClear={clear}
      onFocus={handleFocus}
      onPick={pick}
      onRetry={retry}
      onTextChange={handleTextChange}
      open={open && searchAvailable}
      placeholder={placeholder ?? copy.adminSearchPlacesPlaceholder}
      searching={searching}
      text={text}
    />
  );
}

const PLACE_REF_PATTERN = /^place:([0-9]+)$/;

/**
 * Grammar-reference adapter for the place-parent editor. The value stays
 * the canonical `place:<id>` string that editor parses, but selection
 * happens through registry search — never raw grammar typing. A pasted
 * canonical `place:<id>` is still accepted; anything else is invalid and
 * blocks the owning save exactly as before.
 */
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
  const searchAvailable = placeFnAvailable("adminPlacesListFn");
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const parsed = parsePlaceRef(value.trim());
  const selectedId = parsed.ok && "placeId" in parsed.value.ref ? parsed.value.ref.placeId : null;
  const invalid = value.trim() !== "" && selectedId === null;

  const fallbackLabel =
    value.trim() === ""
      ? ""
      : formatPlaceContext({ name: null, parentName: null, iso: null, placeId: value, lang });

  const displayName = usePlaceDisplayName(selectedId, selectedId ?? fallbackLabel, lang);

  const { hits, searching, failed, retry } = useRegistrySearch(
    focused ? draft : "",
    searchAvailable,
  );

  let text = value;

  if (focused) {
    text = draft;
  } else if (selectedId !== null) {
    text = displayName;
  }

  const pick = (hit: PlaceSearchHit): void => {
    rememberLabel(
      hit.id,
      formatPlaceContext({
        name: hit.name,
        parentName: hit.parentName,
        iso: hit.iso,
        placeId: hit.id,
        lang,
      }),
      lang,
    );
    onChange(`place:${hit.id}`);
    setDraft("");
    setOpen(false);
  };

  const handleTextChange = (next: string): void => {
    setDraft(next);
    setOpen(true);

    const match = PLACE_REF_PATTERN.exec(next.trim());

    if (next.trim() === "") {
      onChange("");
    } else if (match?.[1] !== undefined) {
      onChange(`place:${match[1]}`);
    }
  };

  const handleFocus = (): void => {
    setFocused(true);
    setDraft("");
    setOpen(true);
  };

  const handleBlur = (): void => {
    setFocused(false);
    setDraft("");
    setOpen(false);
  };

  const clear = (): void => {
    onChange("");
    setDraft("");
    setOpen(false);
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <RegistrySearchBox
        activeIndex={activeIndex}
        copy={copy}
        error={failed}
        hasSelection={value.trim() !== ""}
        hits={hits}
        id={id}
        label={label}
        lang={lang}
        listLabel={copy.adminSelectPlace}
        onActiveIndexChange={setActiveIndex}
        onBlur={handleBlur}
        onClear={clear}
        onFocus={handleFocus}
        onPick={pick}
        onRetry={retry}
        onTextChange={handleTextChange}
        open={open && searchAvailable}
        placeholder={copy.adminSearchPlacesPlaceholder}
        searching={searching}
        text={text}
      />
      {invalid ? (
        <p id={`${id}-error`} role="alert" className="text-sm font-semibold text-red-800">
          {copy.adminSaveFailed}
        </p>
      ) : null}
    </div>
  );
}

export function PlaceSelector({
  copy,
  emptySlot,
  id,
  label,
  lang,
  onChange,
  onPickHit,
  placeholder,
  value,
  variant,
}: {
  readonly copy: Messages;
  readonly emptySlot?: ReactNode;
  readonly id: string;
  readonly label: string;
  readonly lang: Locale;
  readonly onChange: (value: string) => void;
  readonly onPickHit?: (hit: PlaceSearchHit) => void;
  readonly placeholder?: string;
  readonly value: string;
  readonly variant?: "reference" | "parentFilter";
}): ReactNode {
  if (variant === "parentFilter") {
    return (
      <ParentFilterSelector
        copy={copy}
        emptySlot={emptySlot}
        id={id}
        label={label}
        lang={lang}
        onChange={onChange}
        onPickHit={onPickHit}
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
