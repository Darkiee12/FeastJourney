import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

/** Preferred codes pinned above the full catalog. Only codes present in
 *  `codes` (the FX catalog) ever render — ordering never invents coverage. */
const FALLBACK_COMMON = ["USD", "EUR", "VND", "GBP", "JPY", "KRW", "THB", "SGD"] as const;

function currencyName(code: string, locale: string | undefined): string {
  try {
    return new Intl.DisplayNames(locale, { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function matches(code: string, name: string, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();

  if (needle === "") return true;

  return code.toLocaleLowerCase().includes(needle) || name.toLocaleLowerCase().includes(needle);
}

export interface SearchableCurrencyPickerProps {
  readonly value: string;
  readonly codes: ReadonlyArray<string>;
  /** Eligible-price / display / settings codes, pinned first. */
  readonly common?: ReadonlyArray<string>;
  readonly locale?: string | undefined;
  readonly label: string;
  readonly placeholder: string;
  readonly searchPlaceholder?: string | undefined;
  readonly emptyMessage?: string | undefined;
  readonly unavailableNote?: string | undefined;
  readonly commonLabel?: string | undefined;
  readonly allLabel?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly onChange: (code: string) => void;
}

/**
 * Searchable single-select for ISO currency codes. Names resolve through
 * `Intl.DisplayNames` (runtime locale, no network); filtering is
 * case-insensitive over code + localized name.
 *
 * Inline (non-portaled) by design: the picker lives inside the filters
 * sheet flow, so the sheet's Radix focus trap and return-focus keep working,
 * nothing unmounts, and there are no scroll jumps. A nested dialog/bottom
 * sheet was considered and rejected — it adds a second trap for no benefit
 * at this size. Keyboard: arrows move, Enter selects, Escape closes the
 * list only (the sheet stays open).
 */
export function SearchableCurrencyPicker({
  value,
  codes,
  common,
  locale,
  label,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  unavailableNote,
  commonLabel,
  allLabel,
  disabled,
  onChange,
}: SearchableCurrencyPickerProps) {
  const labelId = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const supported = useMemo(() => [...new Set(codes)].toSorted(), [codes]);

  const names = useMemo(() => {
    const entries = new Map<string, string>();

    for (const code of supported) entries.set(code, currencyName(code, locale));

    if (value !== "" && !entries.has(value)) entries.set(value, currencyName(value, locale));

    return entries;
  }, [supported, value, locale]);

  const pinned = useMemo(() => {
    const wanted = [...(common ?? []), ...FALLBACK_COMMON];
    const seen = new Set<string>();
    const result: Array<string> = [];

    for (const code of wanted) {
      if (!seen.has(code) && supported.includes(code)) {
        seen.add(code);
        result.push(code);
      }
    }

    return result;
  }, [common, supported]);

  const rest = useMemo(() => {
    const pinnedSet = new Set(pinned);

    return supported.filter((code) => !pinnedSet.has(code));
  }, [supported, pinned]);

  const visiblePinned = useMemo(
    () => pinned.filter((code) => matches(code, names.get(code) ?? code, query)),
    [pinned, names, query],
  );

  const visibleRest = useMemo(
    () => rest.filter((code) => matches(code, names.get(code) ?? code, query)),
    [rest, names, query],
  );

  const staleSelected = value !== "" && !supported.includes(value);

  const showStale = staleSelected && matches(value, names.get(value) ?? value, query);

  const flat = useMemo(
    () => [...(showStale ? [value] : []), ...visiblePinned, ...visibleRest],
    [showStale, value, visiblePinned, visibleRest],
  );

  const clampedActive = flat.length === 0 ? 0 : Math.min(active, flat.length - 1);
  const activeCode = flat[clampedActive];

  useEffect(() => {
    if (open) searchRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open || activeCode === undefined) return;

    document.getElementById(`${listId}-${activeCode}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeCode, listId]);

  const closeList = (returnFocus: boolean) => {
    setOpen(false);

    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  const choose = (code: string) => {
    onChange(code);
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (flat.length === 0 ? 0 : Math.min(index + 1, flat.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (flat.length === 0 ? 0 : Math.max(index - 1, 0)));
    } else if (event.key === "Enter") {
      event.preventDefault();

      if (activeCode !== undefined) choose(activeCode);
    } else if (event.key === "Escape") {
      // Close the list only — the filters sheet stays open.
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      closeList(true);
    }
  };

  // WAI-ARIA combobox pattern: the searchable list carries per-code
  // metadata (localized name, common grouping) that a native `<option>`
  // cannot host, so the option role is explicit on the list item. Mouse and
  // touch go through the inner button; arrow/Enter/Escape stay on the search
  // input via aria-activedescendant (mirrors PlaceSelector).
  const renderOption = (code: string) => (
    <li
      key={code}
      id={`${listId}-${code}`}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role
      role="option"
      aria-selected={code === value}
      aria-label={`${code}, ${names.get(code) ?? code}`}
    >
      <button
        type="button"
        tabIndex={-1}
        data-active={activeCode === code}
        className="rf-currency-option"
        onClick={() => choose(code)}
        onMouseEnter={() => setActive(flat.indexOf(code))}
      >
        {code === value ? (
          <Check aria-hidden="true" className="rf-check" />
        ) : (
          <span aria-hidden="true" className="rf-check-slot" />
        )}
        <span className="rf-currency-code">{code}</span>
        <span className="rf-currency-name">{names.get(code) ?? code}</span>
      </button>
    </li>
  );

  const selectedName = value === "" ? null : (names.get(value) ?? value);

  return (
    <div className="rf-currency">
      <button
        ref={triggerRef}
        type="button"
        className="rf-currency-trigger"
        aria-labelledby={labelId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled === true || supported.length === 0}
        onClick={() => setOpen((isOpen) => !isOpen)}
      >
        <span className="rf-currency-value">
          {selectedName === null ? (
            <span className="rf-currency-placeholder">{placeholder}</span>
          ) : (
            <>
              <strong>{value}</strong>
              <span>{selectedName}</span>
            </>
          )}
        </span>
        <ChevronDown aria-hidden="true" className="rf-currency-chevron" data-open={open} />
      </button>
      {supported.length === 0 && unavailableNote !== undefined ? (
        <p className="rf-hint" aria-live="polite">
          {unavailableNote}
        </p>
      ) : null}
      {open ? (
        <div className="rf-currency-panel">
          <div className="rf-currency-searchwrap">
            <Search aria-hidden="true" className="rf-currency-searchicon" />
            <input
              ref={searchRef}
              type="search"
              autoComplete="off"
              className="rf-currency-search"
              placeholder={searchPlaceholder ?? "Search currencies"}
              aria-label={searchPlaceholder ?? "Search currencies"}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKeyDown}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={
                activeCode === undefined ? undefined : `${listId}-${activeCode}`
              }
            />
          </div>
          {flat.length === 0 ? (
            <p className="rf-currency-empty" aria-live="polite">
              {emptyMessage ?? "No currencies match this search."}
            </p>
          ) : (
            <>
              {/* WAI-ARIA listbox for the searchable picker: a native
                  `<select>` cannot host the search field, grouping, and
                  localized names (mirrors PlaceSelector). */}
              {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role */}
              <ul id={listId} role="listbox" aria-label={label} className="rf-currency-list">
                {visiblePinned.length > 0 ? (
                  <li role="presentation" className="rf-currency-group">
                    {commonLabel ?? "Common"}
                  </li>
                ) : null}
                {showStale ? renderOption(value) : null}
                {visiblePinned.map(renderOption)}
                {visibleRest.length > 0 ? (
                  <li role="presentation" className="rf-currency-group">
                    {allLabel ?? "All currencies"}
                  </li>
                ) : null}
                {visibleRest.map(renderOption)}
              </ul>
            </>
          )}
        </div>
      ) : null}
      <span id={labelId} className="sr-only">
        {label}
      </span>
    </div>
  );
}
