import { useQuery } from "@tanstack/react-query";
import {
  CheckIcon,
  ChevronDownIcon,
  Globe2Icon,
  LocateFixedIcon,
  MapPinIcon,
  SearchIcon,
  Undo2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { formatTemplate } from "@/components/home/recommend/quiz-model";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { searchCitiesFn } from "@/modules/food-discovery/food.functions";
import type { Locale } from "@/shared/i18n";

/**
 * Single location control for the homepage discovery section: one compact
 * indicator ("Vietnam · Change location") that opens one focused selector.
 * The lead integrator mounts this and wires the four explicit callbacks;
 * geolocation fires only when the visitor taps "Use my location", and a
 * denial keeps the existing carousel content with a quiet inline note.
 *
 * Loading, error, and empty carousel states belong to the section shell
 * (Agent C), not to this control: this file owns only the locating spinner
 * text and the denial note next to the trigger.
 */

/** One destination entry in the "Choose a destination" submenu. */
export interface DiscoveryCountryOption {
  readonly code: string;
  readonly label: string;
}

/**
 * One city entry in the "Choose a city" submenu: the canonical registry
 * identity plus display context. The id scopes the carousel; the name and
 * context build the honest heading label — never free text.
 */
export interface DiscoveryCityOption {
  readonly id: string;
  readonly name: string | undefined;
  readonly context: string | null;
  readonly country: string | null;
}

/** Which lane the section is currently serving from. */
export type DiscoverySelection = "regional" | "nearby" | "worldwide" | "city";

/**
 * Honest label for what the carousel actually served (never the ask). A
 * served city pool reads as the regional family with the city named — the
 * heading template is shared, the region name is the city label.
 */
export type DiscoveryServedScope = "nearby" | "regional" | "worldwide" | "city";

export interface DiscoveryLocationProps {
  readonly lang: Locale;
  /** Compact indicator text, e.g. "Vietnam" or "Around the world". */
  readonly currentLabel: string;
  readonly selection: DiscoverySelection;
  /** ISO code of the served country, if any; marks the submenu radio. */
  readonly selectedCountry: string | null;
  /** Canonical city choice, if any; marks the city submenu. Optional so
   * existing callers render unchanged until they wire the city lane. */
  readonly selectedCity?: DiscoveryCityOption | null | undefined;
  readonly locating: boolean;
  /** Geolocation was denied or failed: content stays, note explains. */
  readonly preciseDenied: boolean;
  /** True when the browser cannot geolocate (unsupported/insecure). */
  readonly preciseDisabled: boolean;
  /** True while a precise location is being served: offers the way back. */
  readonly showBackToRegion: boolean;
  readonly countries: ReadonlyArray<DiscoveryCountryOption>;
  readonly countriesLoading: boolean;
  readonly disabled: boolean;
  readonly onUsePrecise: () => void;
  readonly onChooseCountry: (country: string) => void;
  /** City pick commits a canonical place id, never free text. Optional
   * until the caller wires the city lane; the submenu still searches. */
  readonly onChooseCity?: ((city: DiscoveryCityOption) => void) | undefined;
  readonly onExploreWorldwide: () => void;
  readonly onBackToRegion: () => void;
}

/** Every user-visible string in this control. Coordinator promotes to i18n. */
export interface DiscoveryLocationCopy {
  readonly changeLocation: string;
  readonly menuLabel: string;
  readonly usePrecise: string;
  readonly locatingNote: string;
  readonly preciseUnavailable: string;
  readonly chooseDestination: string;
  readonly destinationsLoading: string;
  readonly destinationsEmpty: string;
  readonly exploreWorldwide: string;
  readonly backToRegion: string;
  /** Named way back, e.g. "Show dishes from Vietnam". */
  readonly backToRegionNamed: string;
  readonly deniedNote: string;
  readonly headingNearby: string;
  readonly headingRegional: string;
  readonly headingRegionalNamed: string;
  readonly headingWorldwide: string;
  /** Subtitle under the heading: dishes tied to places in the visitor's area. */
  readonly subNearby: string;
  /** Subtitle fallback when the served country has no display name. */
  readonly subRegional: string;
  /** Subtitle for country results, e.g. "Explore Vietnam favorites…". */
  readonly subRegionalNamed: string;
  /** Subtitle for nearby results topped up with country dishes. */
  readonly subSupplementedNamed: string;
  /** Subtitle for the worldwide fallback. */
  readonly subWorldwide: string;
}

const englishCopy: DiscoveryLocationCopy = {
  backToRegion: "Show regional dishes",
  backToRegionNamed: "Show dishes from {name}",
  changeLocation: "Change location",
  chooseDestination: "Choose a destination",
  deniedNote: "Couldn't get your location — keeping regional dishes.",
  destinationsEmpty: "No destinations listed yet.",
  destinationsLoading: "Loading countries…",
  exploreWorldwide: "Explore worldwide",
  headingNearby: "Dishes near you",
  headingRegional: "Discover dishes from this region",
  headingRegionalNamed: "Discover dishes from {name}",
  headingWorldwide: "A taste from around the world",
  locatingNote: "Finding your area…",
  menuLabel: "Choose where to explore",
  preciseUnavailable: "Location isn't available in this browser.",
  subNearby: "Dishes associated with places in your area.",
  subRegional: "Explore regional favorites and specialties.",
  subRegionalNamed: "Explore {name} favorites and regional specialties.",
  subSupplementedNamed: "Local discoveries and regional favorites from across {name}.",
  subWorldwide:
    "Our catalog doesn't have dishes from this region yet. Here are some discoveries from elsewhere.",
  usePrecise: "Use my location",
};

const vietnameseCopy: DiscoveryLocationCopy = {
  backToRegion: "Xem món theo vùng",
  backToRegionNamed: "Xem món từ {name}",
  changeLocation: "Đổi vị trí",
  chooseDestination: "Chọn điểm đến",
  deniedNote: "Không lấy được vị trí — vẫn hiện món theo vùng.",
  destinationsEmpty: "Chưa có điểm đến nào.",
  destinationsLoading: "Đang tải danh sách quốc gia…",
  exploreWorldwide: "Khám phá khắp thế giới",
  headingNearby: "Món ngon gần bạn",
  headingRegional: "Khám phá món ngon vùng này",
  headingRegionalNamed: "Khám phá món ngon tại {name}",
  headingWorldwide: "Hương vị khắp thế giới",
  locatingNote: "Đang xác định khu vực của bạn…",
  menuLabel: "Chọn nơi khám phá",
  preciseUnavailable: "Trình duyệt này không dùng được vị trí.",
  subNearby: "Những món gắn với các địa điểm quanh bạn.",
  subRegional: "Khám phá đặc sản và món yêu thích của vùng này.",
  subRegionalNamed: "Khám phá món yêu thích và đặc sản của {name}.",
  subSupplementedNamed: "Món ngon quanh bạn và đặc sản khắp {name}.",
  subWorldwide: "Danh mục chưa có món của vùng này. Đây là một vài khám phá từ nơi khác.",
  usePrecise: "Dùng vị trí của tôi",
};

export const discoveryLocationCopyFor = (lang: Locale): DiscoveryLocationCopy =>
  lang === "vi" ? vietnameseCopy : englishCopy;

/**
 * City submenu strings. Kept separate from DiscoveryLocationCopy so the
 * copy-key contract pinned by unit tests stays untouched.
 */
export interface DiscoveryCityCopy {
  readonly chooseCity: string;
  readonly citySearchLabel: string;
  readonly citySearchPlaceholder: string;
  readonly citySearching: string;
  readonly citySearchError: string;
  readonly citySearchEmpty: string;
  readonly cityResultsLabel: string;
}

const englishCityCopy: DiscoveryCityCopy = {
  chooseCity: "Choose a city",
  cityResultsLabel: "Matching cities",
  citySearchEmpty: "No matching city — try another spelling.",
  citySearchError: "Could not search cities. Try again.",
  citySearchLabel: "Search for a city",
  citySearchPlaceholder: "Search a city… e.g. Bangalore",
  citySearching: "Searching cities…",
};

const vietnameseCityCopy: DiscoveryCityCopy = {
  chooseCity: "Chọn thành phố",
  cityResultsLabel: "Thành phố khớp",
  citySearchEmpty: "Không có thành phố nào khớp — thử cách viết khác.",
  citySearchError: "Không tìm được thành phố. Thử lại.",
  citySearchLabel: "Tìm thành phố",
  citySearchPlaceholder: "Tìm thành phố… ví dụ Bangalore",
  citySearching: "Đang tìm thành phố…",
};

export const discoveryCityCopyFor = (lang: Locale): DiscoveryCityCopy =>
  lang === "vi" ? vietnameseCityCopy : englishCityCopy;

/**
 * Display label for a chosen city: name plus administrative context
 * ("Bengaluru, Karnataka, India"). Null when the name is missing so callers
 * fall back to country/worldwide labels instead of fabricating one.
 */
export const discoveryCityLabelFor = (
  city: Pick<DiscoveryCityOption, "name" | "context">,
): string | null => {
  const name = city.name?.trim() ?? "";

  if (name === "") {
    return null;
  }

  const context = city.context?.trim() ?? "";

  if (context === "") {
    return name;
  }

  return `${name}, ${context}`;
};

/**
 * Honest scope from what the server actually served. A precise request that
 * fell back to country dishes is labeled regional, never nearby: "nearby"
 * requires both a served nearby scope and an active precise location. A
 * supplemented nearby pool (sparse locality dishes topped up with country
 * dishes) is also regional: the heading names the country, never a city
 * the query did not actually run. A served city scope reads as its own
 * "city" lane so the heading names the city; a supplemented city pool (or
 * any supplemented pool) stays regional, and a city that fell back to the
 * ancestor country serves "country" and labels regional with that country.
 * Null while the carousel has not served yet, so the lead keeps the
 * previous heading.
 */
export const discoveryServedScopeFor = (input: {
  readonly preciseActive: boolean;
  readonly servedScope: "nearby" | "country" | "city" | "worldwide" | null;
  readonly supplemented?: boolean | undefined;
}): DiscoveryServedScope | null => {
  if (input.servedScope === null) {
    return null;
  }

  if (input.servedScope === "worldwide") {
    return "worldwide";
  }

  if (input.supplemented === true) {
    return "regional";
  }

  if (input.servedScope === "nearby" && input.preciseActive) {
    return "nearby";
  }

  if (input.servedScope === "city") {
    return "city";
  }

  return "regional";
};

/**
 * Section heading keyed off the served scope, never the requested one. The
 * city lane shares the regional template with the city named ("Discover
 * dishes from Bengaluru, Karnataka, India").
 */
export const discoveryHeadingFor = (input: {
  readonly scope: DiscoveryServedScope;
  readonly regionName: string | null;
  readonly lang: Locale;
}): string => {
  const copy = discoveryLocationCopyFor(input.lang);

  if (input.scope === "nearby") {
    return copy.headingNearby;
  }

  if (input.scope === "worldwide") {
    return copy.headingWorldwide;
  }

  if (input.regionName !== null && input.regionName !== "") {
    return formatTemplate(copy.headingRegionalNamed, input.regionName);
  }

  return copy.headingRegional;
};

/**
 * Subtitle keyed off the served scope, never the requested one. Country
 * and city results name the served place with the regional template;
 * supplemented results name the served country; worldwide owns the
 * catalog-gap explanation so the heading and subtitle never contradict
 * ("around the world" above "local favorites" is the exact mismatch this
 * prevents). Supplemented (nearby dishes topped up with country dishes)
 * reads as regional with the country named.
 */
export const discoverySubtitleFor = (input: {
  readonly scope: DiscoveryServedScope;
  readonly regionName: string | null;
  readonly supplemented: boolean;
  readonly lang: Locale;
}): string => {
  const copy = discoveryLocationCopyFor(input.lang);

  if (input.scope === "nearby") {
    return copy.subNearby;
  }

  if (input.scope === "worldwide") {
    return copy.subWorldwide;
  }

  if (input.supplemented && input.regionName !== null && input.regionName !== "") {
    return formatTemplate(copy.subSupplementedNamed, input.regionName);
  }

  if (input.regionName !== null && input.regionName !== "") {
    return formatTemplate(copy.subRegionalNamed, input.regionName);
  }

  return copy.subRegional;
};

/**
 * Human-readable way back: name the served country when known instead of
 * pointing at an implementation ("region", "network area"). Falls back to
 * the generic regional line when the country code is unknown or unnamed.
 */
export const discoveryBackLabelFor = (input: {
  readonly countries: ReadonlyArray<DiscoveryCountryOption>;
  readonly selectedCountry: string | null;
  readonly lang: Locale;
}): string => {
  const copy = discoveryLocationCopyFor(input.lang);

  const name =
    input.selectedCountry === null
      ? null
      : (input.countries.find((country) => country.code === input.selectedCountry)?.label ?? null);

  if (name === null) {
    return copy.backToRegion;
  }

  return formatTemplate(copy.backToRegionNamed, name);
};

/**
 * City search inside the "Choose a city" submenu. Queries the canonical
 * place registry (name and alias matching — "Bangalore" finds Bengaluru)
 * with a debounced minimum of 2 characters, showing administrative context
 * so identical names disambiguate. A pick commits a canonical place id,
 * never free text. Mounted only when the submenu opens, so no query fires
 * on page load. Keystrokes stay local to the field (Escape/Tab still reach
 * Radix for close and focus escape).
 */
function CitySearchContent(props: {
  readonly lang: Locale;
  readonly disabled: boolean;
  readonly selected: DiscoveryCityOption | null;
  readonly onPick: (city: DiscoveryCityOption) => void;
}) {
  const copy = discoveryCityCopyFor(props.lang);
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(text);
    }, 250);

    return () => {
      window.clearTimeout(timer);
    };
  }, [text]);

  const trimmed = debounced.trim();

  const cities = useQuery({
    queryKey: ["catalog", "cities", props.lang, trimmed],
    queryFn: () => searchCitiesFn({ data: { q: trimmed, locale: props.lang, limit: 8 } }),
    enabled: trimmed.length >= 2,
    retry: 1,
    staleTime: 5 * 60_000,
  });

  const results = cities.data ?? [];
  const selectedLabel = props.selected === null ? null : discoveryCityLabelFor(props.selected);

  return (
    <div className="p-1">
      <label
        htmlFor="discovery-city-search"
        className="mb-1 block px-2 pt-1 text-sm font-bold text-ink"
      >
        {copy.citySearchLabel}
      </label>
      <div className="relative">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted"
        />
        <input
          id="discovery-city-search"
          type="text"
          autoComplete="off"
          disabled={props.disabled}
          value={text}
          placeholder={copy.citySearchPlaceholder}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            // Keep typing and caret keys local to the field instead of
            // driving Radix menu typeahead; Escape/Tab still reach Radix
            // for close and focus escape.
            if (event.key !== "Escape" && event.key !== "Tab") {
              event.stopPropagation();
            }
          }}
          className="min-h-11 w-full rounded-xl border-2 border-border-soft bg-cream py-2 pr-3 pl-10 text-base text-ink placeholder:text-muted focus:border-brand-blue disabled:cursor-not-allowed disabled:opacity-60"
        />
      </div>
      {props.selected !== null ? (
        <DropdownMenuItem disabled className="min-h-11">
          <CheckIcon aria-hidden="true" />
          <span className="truncate">{selectedLabel ?? copy.chooseCity}</span>
        </DropdownMenuItem>
      ) : null}
      {cities.isPending && trimmed.length >= 2 ? (
        <output className="block px-2 py-1.5 text-sm font-semibold text-muted">
          {copy.citySearching}
        </output>
      ) : null}
      {cities.isError ? (
        <p className="px-2 py-1.5 text-sm font-bold text-danger" role="alert">
          {copy.citySearchError}
        </p>
      ) : null}
      {trimmed.length >= 2 && !cities.isPending && !cities.isError && results.length === 0 ? (
        <output className="block px-2 py-1.5 text-sm text-muted">{copy.citySearchEmpty}</output>
      ) : null}
      {results.length > 0 ? (
        <DropdownMenuGroup>
          <DropdownMenuLabel>{copy.cityResultsLabel}</DropdownMenuLabel>
          {results.map((entry) => {
            const displayName = entry.name ?? entry.id;

            return (
              <DropdownMenuItem
                key={entry.id}
                disabled={props.disabled}
                onSelect={() => {
                  props.onPick({
                    id: entry.id,
                    name: entry.name,
                    context: entry.context,
                    country: entry.country,
                  });
                }}
                className="min-h-11"
              >
                <MapPinIcon aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate font-bold">{displayName}</span>
                  {entry.context === null || entry.context === "" ? null : (
                    <span className="block truncate text-xs font-normal text-muted">
                      {entry.context}
                    </span>
                  )}
                </span>
                {props.selected?.id === entry.id ? (
                  <CheckIcon aria-hidden="true" className="ml-auto" />
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      ) : null}
    </div>
  );
}

export function DiscoveryLocation(props: DiscoveryLocationProps) {
  const copy = discoveryLocationCopyFor(props.lang);
  const cityCopy = discoveryCityCopyFor(props.lang);
  const busy = props.disabled || props.locating;
  const destinationsReady = !props.countriesLoading && props.countries.length > 0;

  const backLabel = discoveryBackLabelFor({
    countries: props.countries,
    lang: props.lang,
    selectedCountry: props.selectedCountry,
  });

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Non-modal: opening the menu must not lock scroll or shift the page. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={props.disabled}
            aria-label={`${props.currentLabel} · ${copy.changeLocation}`}
            className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border-2 border-ink bg-white px-5 text-sm font-bold whitespace-nowrap text-ink transition hover:bg-ink hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            <MapPinIcon aria-hidden="true" className="size-4 flex-none" />
            <span className="inline-block max-w-28 min-w-0 truncate min-[480px]:max-w-44">
              {props.currentLabel}
            </span>
            <span aria-hidden="true" className="opacity-60">
              ·
            </span>
            <span>{copy.changeLocation}</span>
            <ChevronDownIcon aria-hidden="true" className="size-4 flex-none" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" aria-label={copy.menuLabel}>
          <DropdownMenuGroup>
            {props.showBackToRegion ? (
              <DropdownMenuItem disabled={busy} onSelect={props.onBackToRegion}>
                <Undo2Icon aria-hidden="true" />
                <span>{backLabel}</span>
                {props.selection === "regional" ? (
                  <CheckIcon aria-hidden="true" className="ml-auto" />
                ) : null}
              </DropdownMenuItem>
            ) : null}
            {props.showBackToRegion ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              disabled={busy || props.preciseDisabled}
              onSelect={props.onUsePrecise}
            >
              <LocateFixedIcon aria-hidden="true" />
              <span>{copy.usePrecise}</span>
              {props.selection === "nearby" ? (
                <CheckIcon aria-hidden="true" className="ml-auto" />
              ) : null}
            </DropdownMenuItem>
            {props.preciseDisabled ? (
              <DropdownMenuLabel className="max-w-56 text-xs font-normal text-muted">
                {copy.preciseUnavailable}
              </DropdownMenuLabel>
            ) : null}
            {props.countriesLoading ? (
              <DropdownMenuItem disabled>
                <MapPinIcon aria-hidden="true" />
                <span>{copy.destinationsLoading}</span>
              </DropdownMenuItem>
            ) : null}
            {!props.countriesLoading && props.countries.length === 0 ? (
              <DropdownMenuItem disabled>
                <MapPinIcon aria-hidden="true" />
                <span>{copy.destinationsEmpty}</span>
              </DropdownMenuItem>
            ) : null}
            {destinationsReady ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={busy} className="min-h-11">
                  <MapPinIcon aria-hidden="true" />
                  <span>{copy.chooseDestination}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                  <DropdownMenuRadioGroup
                    value={props.selectedCountry ?? ""}
                    onValueChange={props.onChooseCountry}
                  >
                    {props.countries.map((country) => (
                      <DropdownMenuRadioItem
                        key={country.code}
                        disabled={busy}
                        value={country.code}
                        className="min-h-11"
                      >
                        {country.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={busy} className="min-h-11">
                <MapPinIcon aria-hidden="true" />
                <span>{cityCopy.chooseCity}</span>
                {props.selection === "city" ? (
                  <CheckIcon aria-hidden="true" className="ml-auto" />
                ) : null}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 w-72 overflow-y-auto">
                <CitySearchContent
                  disabled={busy}
                  lang={props.lang}
                  onPick={(option) => {
                    props.onChooseCity?.(option);
                  }}
                  selected={props.selectedCity ?? null}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem disabled={busy} onSelect={props.onExploreWorldwide}>
              <Globe2Icon aria-hidden="true" />
              <span>{copy.exploreWorldwide}</span>
              {props.selection === "worldwide" ? (
                <CheckIcon aria-hidden="true" className="ml-auto" />
              ) : null}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {props.locating ? (
        <output className="text-sm font-bold text-muted">{copy.locatingNote}</output>
      ) : null}
      {!props.locating && props.preciseDenied ? (
        <output className="block text-sm text-muted">{copy.deniedNote}</output>
      ) : null}
    </div>
  );
}
