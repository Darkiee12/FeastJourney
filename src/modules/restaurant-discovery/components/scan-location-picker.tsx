import { useQuery } from "@tanstack/react-query";
import { Data } from "effect";
import { Check, Loader2, LocateFixed, MapPin, Search } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { nearestCityFn, searchCitiesFn } from "@/modules/food-discovery/food.functions";
import {
  scanLocationCopy,
  scanLocationPickerCopy,
} from "@/modules/restaurant-discovery/components/menu-copy";
import type { ScanMenuLocation } from "@/modules/restaurant-discovery/components/scan-capture";

export interface ScanLocationPickerProps {
  readonly locale: string;
  readonly open: boolean;
  readonly disabled: boolean;
  readonly current: ScanMenuLocation | null;
  readonly recent: ReadonlyArray<ScanMenuLocation>;
  readonly presets: ReadonlyArray<ScanMenuLocation>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (location: ScanMenuLocation | null) => void;
}

/**
 * Geolocation lifecycle: idle, an explicit in-flight lookup, or a failed
 * lookup carrying the display message. Failures never clear the current
 * selection — the trigger keeps showing the previous choice.
 */
type GeoState = Data.TaggedEnum<{
  GeoIdle: {};
  GeoLocating: {};
  GeoFailed: { readonly message: string };
}>;

const GeoState = Data.taggedEnum<GeoState>();

const SEARCH_LIMIT = 12;

const DEBOUNCE_MS = 250;

/**
 * Single location picker: Radix Dialog (modal) styled as a bottom sheet on
 * mobile and a top-anchored dialog on desktop. One primitive covers both —
 * it supplies the focus trap, Escape handling, backdrop dismissal, body
 * scroll lock, and trigger focus restoration. A dropdown/popover primitive
 * was rejected: neither traps focus nor locks scroll for a sheet.
 *
 * Contents: explicit opt-in geolocation (nearestCityFn result used as-is —
 * it already threshold-guards at 50km server-side), debounced city search
 * (searchCitiesFn, canonical `place:<id>` identities), curated presets, real
 * session-history recents (no invented entries; the section hides when
 * empty), and clear/done. Search failure keeps the rest usable.
 */
export function ScanLocationPicker({
  locale,
  open,
  disabled,
  current,
  recent,
  presets,
  onOpenChange,
  onSelect,
}: ScanLocationPickerProps): ReactNode {
  const copy = scanLocationPickerCopy(locale);
  const hint = scanLocationCopy(locale).hint;
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [geo, setGeo] = useState<GeoState>(() => GeoState.GeoIdle());
  const searchRef = useRef<HTMLInputElement>(null);

  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      setQuery("");
      setDebounced("");
      setGeo(GeoState.GeoIdle());
    }

    onOpenChange(next);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query]);

  const visibleRecent = recent.filter((entry) => entry.cityId !== current?.cityId);

  /**
   * Exhaustive geo presentation: one stable row whose icon, label, and
   * pending state derive from the GeoState tag, plus an optional alert.
   * Selection never changes on failure, so the previous choice survives.
   */
  const geoView: { readonly label: string; readonly busy: boolean; readonly error: string | null } =
    GeoState.$match(geo, {
      GeoIdle: () => ({ label: copy.useLocation, busy: false, error: null }),
      GeoLocating: () => ({ label: copy.locating, busy: true, error: null }),
      GeoFailed: ({ message }) => ({ label: copy.useLocation, busy: false, error: message }),
    });

  const trimmed = debounced.trim();

  const cities = useQuery({
    queryKey: ["catalog", "cities", locale, trimmed],
    queryFn: () => searchCitiesFn({ data: { q: trimmed, locale, limit: SEARCH_LIMIT } }),
    enabled: open && trimmed.length >= 2,
    retry: 1,
    staleTime: 5 * 60_000,
  });

  const useMyLocation = (): void => {
    if (disabled) return;

    // SSR guard: this handler only runs in the browser, but the reference
    // must not evaluate during server render.
    const geolocation = typeof navigator === "undefined" ? undefined : navigator.geolocation;

    if (geolocation === undefined) {
      setGeo(GeoState.GeoFailed({ message: copy.unavailable }));

      return;
    }

    setGeo(GeoState.GeoLocating());
    geolocation.getCurrentPosition(
      (position) => {
        // Coarsen to ~1km before the lookup; the fix itself never persists.
        const latitude = Math.round(position.coords.latitude * 100) / 100;
        const longitude = Math.round(position.coords.longitude * 100) / 100;
        nearestCityFn({ data: { latitude, longitude, locale } }).then(
          (city) => {
            if (city === null || city.name === undefined || city.name === "") {
              setGeo(GeoState.GeoFailed({ message: copy.unavailable }));

              return;
            }

            setGeo(GeoState.GeoIdle());
            onSelect({ cityId: `geo:${city.name}`, label: city.name });
          },
          () => {
            setGeo(GeoState.GeoFailed({ message: copy.unavailable }));
          },
        );
      },
      () => {
        setGeo(GeoState.GeoFailed({ message: copy.unavailable }));
      },
      { timeout: 10000, maximumAge: 300000 },
    );
  };

  const renderOption = (entry: ScanMenuLocation): ReactNode => {
    const selected = current?.cityId === entry.cityId;

    return (
      <li key={entry.cityId}>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={selected}
          onClick={() => onSelect(selected ? null : entry)}
          className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left font-bold hover:bg-cream disabled:opacity-60"
        >
          <MapPin aria-hidden="true" className="size-4 flex-none text-muted" />
          <span className="min-w-0 flex-1 truncate text-sm text-ink">{entry.label}</span>
          {selected ? <Check aria-hidden="true" className="size-4 flex-none" /> : null}
        </button>
      </li>
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange} modal>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/40 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchRef.current?.focus({ preventScroll: true });
          }}
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] w-full flex-col rounded-t-2xl border border-border-soft bg-white shadow-xl focus:outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-bottom-4 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-4 sm:top-[8%] sm:right-0 sm:bottom-auto sm:left-0 sm:mx-auto sm:w-full sm:max-w-md sm:rounded-2xl"
        >
          <div className="flex-none px-4 pt-4">
            <Dialog.Title className="text-base font-extrabold text-ink">
              {copy.sheetTitle}
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-sm text-muted">{hint}</Dialog.Description>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-4 py-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <button
              type="button"
              disabled={disabled || geoView.busy}
              aria-live="polite"
              onClick={useMyLocation}
              className="flex min-h-11 items-center gap-2 rounded-xl border-2 border-border-soft bg-white px-3 text-left text-sm font-bold text-ink disabled:opacity-60"
            >
              {geoView.busy ? (
                <Loader2 aria-hidden="true" className="size-4 flex-none animate-spin" />
              ) : (
                <LocateFixed aria-hidden="true" className="size-4 flex-none" />
              )}
              <span className="flex-1">{geoView.label}</span>
            </button>
            {geoView.error === null ? null : (
              <p role="alert" className="text-sm font-bold text-food-orange-strong">
                {geoView.error}
              </p>
            )}

            <div className="relative flex-none">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
              />
              <input
                ref={searchRef}
                type="search"
                autoComplete="off"
                disabled={disabled}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={copy.searchPlaceholder}
                aria-label={copy.searchPlaceholder}
                className="min-h-11 w-full rounded-xl border-2 border-border-soft bg-white py-2 pr-3 pl-9 text-sm text-ink disabled:opacity-60"
              />
            </div>

            {trimmed.length >= 2 ? (
              <div aria-live="polite">
                {cities.isPending ? (
                  <output className="block py-2 text-sm text-muted">{copy.searching}</output>
                ) : null}
                {cities.isError ? (
                  <p role="alert" className="flex min-h-11 items-center gap-2 py-2">
                    <span className="flex-1 text-sm font-bold text-food-orange-strong">
                      {copy.unavailable}
                    </span>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        void cities.refetch();
                      }}
                      className="min-h-11 rounded-xl border border-border-soft bg-white px-3 text-sm font-bold text-ink disabled:opacity-60"
                    >
                      {copy.retry}
                    </button>
                  </p>
                ) : null}
                {cities.isSuccess && cities.data.length === 0 ? (
                  <output className="block py-2 text-sm text-muted">{copy.empty}</output>
                ) : null}
                {cities.isSuccess && cities.data.length > 0 ? (
                  <ul className="flex flex-col">
                    {cities.data.map((entry) => (
                      <li key={entry.id}>
                        <button
                          type="button"
                          disabled={disabled}
                          aria-pressed={current?.cityId === `place:${entry.id}`}
                          onClick={() =>
                            onSelect({
                              cityId: `place:${entry.id}`,
                              label: entry.context ?? entry.name ?? entry.id,
                            })
                          }
                          className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left hover:bg-cream disabled:opacity-60"
                        >
                          <MapPin aria-hidden="true" className="size-4 flex-none text-muted" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-bold text-ink">
                              {entry.name ?? entry.id}
                            </span>
                            {entry.context ? (
                              <span className="block truncate text-xs text-muted">
                                {entry.context}
                              </span>
                            ) : null}
                          </span>
                          {current?.cityId === `place:${entry.id}` ? (
                            <Check aria-hidden="true" className="size-4 flex-none" />
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <section aria-label={copy.suggested}>
              <h3 className="px-3 py-1 text-xs font-bold tracking-wide text-muted uppercase">
                {copy.suggested}
              </h3>
              <ul className="flex flex-col">{presets.map(renderOption)}</ul>
            </section>

            {visibleRecent.length > 0 ? (
              <section aria-label={copy.recent}>
                <h3 className="px-3 py-1 text-xs font-bold tracking-wide text-muted uppercase">
                  {copy.recent}
                </h3>
                <ul className="flex flex-col">{visibleRecent.map(renderOption)}</ul>
              </section>
            ) : null}

            {current !== null ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSelect(null)}
                className="min-h-11 rounded-xl px-3 text-left text-sm font-bold text-brand-blue-hover disabled:opacity-60"
              >
                {copy.clear}
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => handleOpenChange(false)}
              className="min-h-11 w-full flex-none rounded-xl bg-ink px-3 text-sm font-bold text-white"
            >
              {copy.done}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
