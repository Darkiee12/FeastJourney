import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Data } from "effect";
import { useId, useState, type ReactNode } from "react";

import { ResearchFallback } from "@/modules/muse-copilot/flows/conversation-feedback";
import { geographyFor } from "@/modules/muse-copilot/flows/find-location";
import {
  RestaurantCard,
  RestaurantCardSkeleton,
  type RestaurantCardModel,
} from "@/modules/restaurant-discovery/components/restaurant-card";
import {
  restaurantCopy,
  type RestaurantCopy,
} from "@/modules/restaurant-discovery/components/restaurant-copy";
import { RestaurantEmptyState } from "@/modules/restaurant-discovery/components/restaurant-empty-state";
import { searchRestaurantsFn } from "@/modules/restaurant-discovery/restaurant.functions";
import type {
  DishRestaurantResult,
  RestaurantResult,
} from "@/modules/restaurant-discovery/server/index";
import { researchRestaurantsFn } from "@/server/web-research/research-functions";
import type { Locale } from "@/shared/i18n";

const DISH_ID_PATTERN = /^[1-9][0-9]{0,18}$/;

const MAX_RESULTS = 10;

const copy = {
  en: {
    dishHeading: "Places serving this dish in {city}",
    askInstead: "Ask Muse about this dish",
  },
  vi: {
    dishHeading: "Quán có món này ở {city}",
    askInstead: "Hỏi Muse về món này",
  },
} as const;

/**
 * Panel-local venue search state. Ready with zero rows renders the honest
 * empty states (never invented venues); failure keeps the failed scope for
 * a real retry. One tag, matched exhaustively at the render site.
 */
type FindSearchState = Data.TaggedEnum<{
  FindLoading: {};
  FindReady: { readonly rows: ReadonlyArray<RestaurantResult | DishRestaurantResult> };
  FindFailed: {};
}>;

const FindSearchState = Data.taggedEnum<FindSearchState>();

type VenueSearchPayload = {
  readonly dish: { readonly name?: string | undefined; readonly slug?: string | undefined } | null;
  readonly items: VenueSearchRows;
  readonly dishItems: VenueSearchRows;
};

const selectRows = (payload: VenueSearchPayload | null): VenueSearchRows | undefined => {
  if (payload === null) {
    return undefined;
  }

  if (payload.dish === null) {
    return [...payload.items];
  }

  return [...payload.dishItems];
};

const toSearchState = (
  isPending: boolean,
  isError: boolean,
  rows: VenueSearchRows | undefined,
): FindSearchState => {
  if (isPending) {
    return FindSearchState.FindLoading();
  }

  if (isError) {
    return FindSearchState.FindFailed();
  }

  return FindSearchState.FindReady({ rows: rows ?? [] });
};

const isDishRow = (row: RestaurantResult | DishRestaurantResult): row is DishRestaurantResult =>
  "variant_id" in row;

type VenueSearchRows = ReadonlyArray<RestaurantResult | DishRestaurantResult>;

const toCardModel = (
  row: RestaurantResult | DishRestaurantResult,
  lang: Locale,
  channelLabel: string,
  dishId: string | undefined,
): RestaurantCardModel => {
  const dish = isDishRow(row) ? row : null;

  return {
    id: row.id,
    name: row.name,
    area: row.area,
    address: row.address,
    distanceKm: row.distance_meters === null ? null : (row.distance_meters / 1000).toFixed(1),
    dish:
      dish === null
        ? null
        : {
            itemName: dish.item_name,
            variantName: dish.variant_name,
            amount: dish.amount,
            currency: dish.currency,
            matchKind: dish.match_kind,
            evidenceDate: dish.evidence_observed_at.slice(0, 10),
            stale: dish.current_enough === false,
            channelLabel,
            sourceCategory: dish.source_category,
            rate: undefined,
          },
    detailSearch: {
      lang,
      channel: "dine_in",
      variant: dish?.variant_id,
      dish: dishId,
      fromDish: undefined,
    },
  };
};

function renderLoading(resCopy: RestaurantCopy): ReactNode {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
      <p className="text-xs font-semibold text-muted">{resCopy.emptySearching}</p>

      <ul className="flex flex-col gap-3" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <li key={index}>
            <RestaurantCardSkeleton />
          </li>
        ))}
      </ul>
    </div>
  );
}

function renderFailed(resCopy: RestaurantCopy, onRetry: () => void): ReactNode {
  return <RestaurantEmptyState copy={resCopy} kind="error" onRetry={onRetry} />;
}

function renderReady({
  rows,
  city,
  dishActive,
  dishId,
  dishName,
  language,
  resCopy,
  askInsteadLabel,
  onBroaden,
  onBrowseAll,
  onChooseLocation,
  onOpenVenue,
  onAskInstead,
}: {
  readonly rows: VenueSearchRows;
  readonly city: string;
  readonly dishActive: boolean;
  readonly dishId: string | undefined;
  /** Canonical dish name resolved server-side; null in browse mode. */
  readonly dishName: string | null;
  readonly language: Locale;
  readonly resCopy: RestaurantCopy;
  readonly askInsteadLabel: string;
  readonly onBroaden: () => void;
  readonly onBrowseAll: () => void;
  readonly onChooseLocation: () => void;
  readonly onOpenVenue: (venueId: string, view: "overview" | "menu") => void;
  readonly onAskInstead: () => void;
}): ReactNode {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {dishActive ? (
          <RestaurantEmptyState
            copy={resCopy}
            kind="no-dish-evidence"
            dishName={dishName}
            cityName={city}
            onSearchWider={onBroaden}
            onBrowseAll={onBrowseAll}
          />
        ) : (
          <RestaurantEmptyState
            copy={resCopy}
            kind="no-venues"
            cityName={city}
            onChooseLocation={onChooseLocation}
            onSearchWider={onBrowseAll}
          />
        )}

        <div className="flex flex-wrap gap-2">
          <Link
            to="/dishes"
            search={{ lang: language }}
            className="inline-flex min-h-11 items-center rounded-full border border-border-soft bg-white px-4 text-sm font-bold text-ink transition hover:border-food-orange-strong"
          >
            {resCopy.emptyExplore}
          </Link>

          <button
            type="button"
            onClick={onAskInstead}
            className="inline-flex min-h-11 cursor-pointer items-center rounded-full border border-border-soft bg-white px-4 text-sm font-bold text-ink transition hover:border-food-orange-strong"
          >
            {askInsteadLabel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          const model = toCardModel(row, language, resCopy.dineIn, dishActive ? dishId : undefined);

          return (
            <li key={model.id}>
              <RestaurantCard
                copy={resCopy}
                model={model}
                selected={false}
                onShowOnMap={() => {
                  onOpenVenue(model.id, "overview");
                }}
                onOpenVenue={() => {
                  onOpenVenue(model.id, "overview");
                }}
                onViewMenu={() => {
                  onOpenVenue(model.id, "menu");
                }}
              />
            </li>
          );
        })}
      </ul>

      {dishActive ? (
        <button
          type="button"
          onClick={onBroaden}
          className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full border border-border-soft bg-white px-5 text-sm font-bold text-ink transition hover:border-food-orange-strong"
        >
          {resCopy.emptyBrowseAll}
        </button>
      ) : null}
    </div>
  );
}

/**
 * First-party venue search for the Find panel (plan §32). Canonical dish id
 * plus preset geography drive `searchRestaurantsFn` through TanStack Query —
 * no model call, no coordinates, no invented hours/prices/ratings. Dish
 * matches never skip the venue pass: a recognized dish constrains the
 * search, it does not replace it. Results render through the shared
 * `RestaurantCard` (name, area, address, reviewed dish evidence, known
 * price or an explicit unknown-price note) with View-on-map / Open / Menu
 * actions into the canonical `/restaurants?venue=&view=` route, which
 * preserves list context by design. Empty scopes offer change-location,
 * broaden-area, and alternatives plus an explicit web-research opt-in whose
 * findings stay separated from first-party records. The parent remounts
 * this section per city/country/dish scope, so scope changes restart the
 * search without effect-driven state resets.
 */
export function FindVenueResults({
  city,
  country,
  dishId,
  language,
  exploreLabel,
  onUpdateContext,
  onChooseLocation,
  onAskInstead,
}: {
  readonly city: string;
  readonly country: string;
  readonly dishId: string | undefined;
  readonly language: Locale;
  /** Filled `locationExplore` label for the browse-all heading. */
  readonly exploreLabel: string;
  readonly onUpdateContext: (patch: { readonly venueId: string }) => void;
  readonly onChooseLocation: () => void;
  readonly onAskInstead: () => void;
}): ReactNode {
  const strings = language === "vi" ? copy.vi : copy.en;
  const resCopy = restaurantCopy(language);
  const navigate = useNavigate();
  const searchId = useId();

  const [query, setQuery] = useState("");
  const [committed, setCommitted] = useState({ text: "", includeDish: true });

  const dishFilter = dishId !== undefined && DISH_ID_PATTERN.test(dishId) ? dishId : undefined;
  const dishActive = committed.includeDish && dishFilter !== undefined;

  const search = useQuery({
    queryKey: ["muse-venue-search", city, country, dishId, committed.text, committed.includeDish],
    queryFn: () => {
      const geo = geographyFor(city, country);

      return searchRestaurantsFn({
        data: {
          q: committed.text,
          area: geo.area,
          channel: "dine_in",
          limit: MAX_RESULTS,
          west: geo.west,
          south: geo.south,
          east: geo.east,
          north: geo.north,
          dish: committed.includeDish ? dishFilter : undefined,
        },
      });
    },
    staleTime: 60000,
    retry: false,
  });

  const searchState = toSearchState(
    search.isPending,
    search.isError,
    selectRows(search.isSuccess ? search.data : null),
  );

  /** Canonical dish name resolved server-side; null in browse mode. */
  const dishName =
    search.isSuccess && search.data.dish !== null
      ? (search.data.dish.name ?? search.data.dish.slug ?? null)
      : null;

  const isEmpty =
    search.isSuccess &&
    (search.data.dish === null ? search.data.items.length : search.data.dishItems.length) === 0;

  const submitSearch = (): void => {
    setCommitted({ text: query.trim().slice(0, 100), includeDish: committed.includeDish });
  };

  const broaden = (): void => {
    setCommitted({ text: committed.text, includeDish: false });
  };

  const retry = (): void => {
    void search.refetch();
  };

  const openVenue = (venueId: string, view: "overview" | "menu"): void => {
    onUpdateContext({ venueId });

    void navigate({
      to: "/restaurants",
      search: { lang: language, venue: venueId, view },
    });
  };

  const openFullMap = (): void => {
    const geo = geographyFor(city, country);

    if (
      geo.west !== undefined &&
      geo.south !== undefined &&
      geo.east !== undefined &&
      geo.north !== undefined
    ) {
      void navigate({
        to: "/restaurants",
        search: {
          lang: language,
          west: geo.west,
          south: geo.south,
          east: geo.east,
          north: geo.north,
        },
      });

      return;
    }

    void navigate({ to: "/restaurants", search: { lang: language, area: city } });
  };

  const heading = dishActive ? strings.dishHeading.replace("{city}", city) : exploreLabel;

  return (
    <section aria-label={heading} aria-busy={search.isFetching} className="flex flex-col gap-3">
      <h2 className="text-sm font-bold text-ink">{heading}</h2>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submitSearch();
        }}
      >
        <label htmlFor={searchId} className="sr-only">
          {resCopy.searchLabel}
        </label>

        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder={resCopy.searchPlaceholder}
          autoComplete="off"
          maxLength={100}
          className="min-h-11 min-w-0 flex-1 rounded-xl border border-border-soft bg-white px-4 text-sm text-ink outline-none placeholder:text-muted focus-visible:border-brand-blue focus-visible:ring-2 focus-visible:ring-brand-blue/40"
        />

        <button
          type="submit"
          disabled={search.isFetching}
          className="inline-flex min-h-11 flex-none cursor-pointer items-center rounded-full bg-food-orange-strong px-5 text-sm font-bold text-white transition hover:bg-food-orange-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {resCopy.searchSubmit}
        </button>
      </form>

      {FindSearchState.$match(searchState, {
        FindLoading: () => renderLoading(resCopy),
        FindFailed: () => renderFailed(resCopy, retry),
        FindReady: ({ rows }) =>
          renderReady({
            rows,
            city,
            dishActive,
            dishId: dishActive ? dishFilter : undefined,
            dishName,
            language,
            resCopy,
            askInsteadLabel: strings.askInstead,
            onBroaden: broaden,
            onBrowseAll: openFullMap,
            onChooseLocation,
            onOpenVenue: openVenue,
            onAskInstead,
          }),
      })}

      {isEmpty && dishName !== null ? (
        <ResearchFallback
          language={language}
          load={() =>
            researchRestaurantsFn({
              data: { city, country, dish: dishName, language },
            })
          }
        />
      ) : null}
    </section>
  );
}

export default FindVenueResults;
