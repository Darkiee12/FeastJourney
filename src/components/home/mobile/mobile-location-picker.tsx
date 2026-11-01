import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  CheckIcon,
  Globe2Icon,
  LocateFixedIcon,
  MapPinIcon,
  SearchIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  discoveryCityCopyFor,
  discoveryCityLabelFor,
  discoveryLocationCopyFor,
  filterCountryOptions,
  type DiscoveryCityOption,
  type DiscoveryCountryOption,
  type DiscoverySelection,
} from "@/components/home/discovery-location";
import { searchCitiesFn } from "@/modules/food-discovery/food.functions";
import type { Locale } from "@/shared/i18n";

type PickerView = "root" | "country" | "city";

export interface MobileLocationPickerProps {
  readonly lang: Locale;
  readonly countries: ReadonlyArray<DiscoveryCountryOption>;
  readonly countriesLoading: boolean;
  readonly selectedCountry: string | null;
  readonly selectedCity: DiscoveryCityOption | null;
  readonly selection: DiscoverySelection;
  readonly locating: boolean;
  readonly preciseDenied: boolean;
  readonly preciseDisabled: boolean;
  readonly onUsePrecise: () => void;
  readonly onChooseCountry: (country: string) => void;
  readonly onChooseCity: (city: DiscoveryCityOption) => void;
  readonly onExploreWorldwide: () => void;
  readonly onDone: () => void;
  readonly onBack: () => void;
}

export function MobileLocationPicker(props: MobileLocationPickerProps) {
  const copy = discoveryLocationCopyFor(props.lang);
  const cityCopy = discoveryCityCopyFor(props.lang);
  const [view, setView] = useState<PickerView>("root");
  const [countryQuery, setCountryQuery] = useState("");
  const [cityText, setCityText] = useState("");
  const [debouncedCity, setDebouncedCity] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedCity(cityText), 250);

    return () => window.clearTimeout(timer);
  }, [cityText]);

  const trimmedCity = debouncedCity.trim();

  const cities = useQuery({
    queryKey: ["catalog", "cities", props.lang, trimmedCity],
    queryFn: () => searchCitiesFn({ data: { q: trimmedCity, locale: props.lang, limit: 12 } }),
    enabled: view === "city" && trimmedCity.length >= 2,
    retry: 1,
    staleTime: 5 * 60_000,
  });

  const filteredCountries = filterCountryOptions(props.countries, countryQuery);

  const back = (): void => {
    if (view === "root") props.onBack();
    else setView("root");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-location-picker>
      <div className="flex flex-none items-center gap-2 px-4 pb-2">
        <button
          type="button"
          onClick={back}
          aria-label={props.lang === "vi" ? "Quay lại" : "Back"}
          className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full border-2 border-border-soft bg-white"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
        </button>
        <h3 className="text-base font-extrabold text-ink">{copy.menuLabel}</h3>
      </div>

      {view === "root" ? (
        <div className="flex flex-col gap-2 overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            disabled={props.locating || props.preciseDisabled}
            onClick={() => {
              props.onUsePrecise();
              props.onDone();
            }}
            className="flex min-h-14 items-center gap-3 rounded-2xl border-2 border-border-soft bg-white px-4 text-left font-bold disabled:opacity-60"
          >
            <LocateFixedIcon aria-hidden="true" className="size-5 flex-none" />
            <span className="flex-1">{props.lang === "vi" ? "Gần tôi" : "Near me"}</span>
            {props.selection === "nearby" ? <CheckIcon aria-hidden="true" /> : null}
          </button>
          {props.preciseDisabled ? (
            <p className="text-sm text-muted">{copy.preciseUnavailable}</p>
          ) : null}
          {props.preciseDenied ? <p className="text-sm text-muted">{copy.deniedNote}</p> : null}
          <button
            type="button"
            onClick={() => setView("country")}
            className="flex min-h-14 items-center gap-3 rounded-2xl border-2 border-border-soft bg-white px-4 text-left font-bold"
          >
            <MapPinIcon aria-hidden="true" className="size-5 flex-none" />
            <span className="flex-1">{copy.chooseDestination}</span>
            {props.selectedCountry ? (
              <span className="text-sm text-muted">{props.selectedCountry}</span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => setView("city")}
            className="flex min-h-14 items-center gap-3 rounded-2xl border-2 border-border-soft bg-white px-4 text-left font-bold"
          >
            <SearchIcon aria-hidden="true" className="size-5 flex-none" />
            <span className="flex-1">{cityCopy.chooseCity}</span>
            {props.selectedCity ? (
              <span className="max-w-32 truncate text-sm text-muted">
                {discoveryCityLabelFor(props.selectedCity)}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => {
              props.onExploreWorldwide();
              props.onDone();
            }}
            className="flex min-h-14 items-center gap-3 rounded-2xl border-2 border-border-soft bg-white px-4 text-left font-bold"
          >
            <Globe2Icon aria-hidden="true" className="size-5 flex-none" />
            <span className="flex-1">{copy.exploreWorldwide}</span>
            {props.selection === "worldwide" ? <CheckIcon aria-hidden="true" /> : null}
          </button>
        </div>
      ) : null}

      {view === "country" ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <label htmlFor="mobile-country-search" className="sr-only">
            {props.lang === "vi" ? "Tìm quốc gia" : "Search countries"}
          </label>
          <div className="relative flex-none">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted"
            />
            <input
              id="mobile-country-search"
              type="search"
              autoComplete="off"
              value={countryQuery}
              onChange={(e) => setCountryQuery(e.target.value)}
              placeholder={props.lang === "vi" ? "Tìm quốc gia…" : "Search countries…"}
              className="min-h-12 w-full rounded-xl border-2 border-border-soft bg-white py-2 pr-3 pl-10 text-base text-ink"
            />
          </div>
          <div
            className="mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain"
            aria-label={copy.chooseDestination}
          >
            {props.countriesLoading ? (
              <output className="block py-3 text-sm text-muted">{copy.destinationsLoading}</output>
            ) : null}
            {!props.countriesLoading && filteredCountries.length === 0 ? (
              <output className="block py-3 text-sm text-muted">
                {props.lang === "vi" ? "Không có quốc gia nào khớp." : "No matching country."}
              </output>
            ) : null}
            {filteredCountries.map((country) => (
              <button
                key={country.code}
                type="button"
                aria-pressed={props.selectedCountry === country.code}
                onClick={() => {
                  props.onChooseCountry(country.code);
                  props.onDone();
                }}
                className="flex min-h-12 w-full items-center gap-2 rounded-xl px-3 text-left font-bold hover:bg-white"
              >
                <span className="flex-1">{country.label}</span>
                <span className="text-xs text-muted">{country.code}</span>
                {props.selectedCountry === country.code ? (
                  <CheckIcon aria-hidden="true" className="size-4" />
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {view === "city" ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <label htmlFor="mobile-city-search" className="sr-only">
            {cityCopy.citySearchLabel}
          </label>
          <div className="relative flex-none">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted"
            />
            <input
              id="mobile-city-search"
              type="search"
              autoComplete="off"
              value={cityText}
              onChange={(e) => setCityText(e.target.value)}
              placeholder={cityCopy.citySearchPlaceholder}
              className="min-h-12 w-full rounded-xl border-2 border-border-soft bg-white py-2 pr-3 pl-10 text-base text-ink"
            />
          </div>
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {trimmedCity.length < 2 ? (
              <output className="block py-3 text-sm text-muted">{cityCopy.citySearchHint}</output>
            ) : null}
            {cities.isPending && trimmedCity.length >= 2 ? (
              <output className="block py-3 text-sm text-muted">{cityCopy.citySearching}</output>
            ) : null}
            {cities.isError ? (
              <p role="alert" className="py-3 text-sm font-bold text-danger">
                {cityCopy.citySearchError}
              </p>
            ) : null}
            {trimmedCity.length >= 2 && cities.isSuccess && cities.data.length === 0 ? (
              <output className="block py-3 text-sm text-muted">{cityCopy.citySearchEmpty}</output>
            ) : null}
            {(cities.isSuccess ? cities.data : []).map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => {
                  props.onChooseCity({
                    id: entry.id,
                    name: entry.name,
                    context: entry.context,
                    country: entry.country,
                  });
                  props.onDone();
                }}
                className="flex min-h-12 w-full items-center gap-2 rounded-xl px-3 text-left hover:bg-white"
              >
                <MapPinIcon aria-hidden="true" className="size-4 flex-none" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{entry.name ?? entry.id}</span>
                  {entry.context ? (
                    <span className="block truncate text-xs text-muted">{entry.context}</span>
                  ) : null}
                </span>
                {props.selectedCity?.id === entry.id ? (
                  <CheckIcon aria-hidden="true" className="size-4" />
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
