import { Data } from "effect";

import type { RestaurantSearch } from "@/modules/restaurant-discovery/restaurant.schema";
import { isAmount, isCurrency } from "@/shared/money";

/**
 * Explicit presentation classifier for restaurant search results.
 *
 * Pure: no Effect, no I/O, no new fetches. Every signal comes from already-
 * available data (loader rows, validated search params, router/UI flags).
 * An empty array never implies an outage — `DataError` fires only when the
 * loader actually threw (`failed: true` with a client-safe message).
 *
 * Relationship to `resolveResultsState` (components/results-sheet.tsx):
 * that resolver stays the sheet/drawer contract. This module is the richer
 * superset the search page uses for next-step decisions (search wider,
 * browse-all-nearby, sort/currency gating, location prompts, data-error UI).
 * `toSheetState` maps back so the page never runs two diverging resolvers.
 *
 * Dish-claim honesty (enforced server-side in search-dish.sql): dish-scoped
 * rows all satisfy `restaurant_eligible_evidence` with non-null observed_at
 * and match_kind over published menus/items/variants, so every `dishItems`
 * row is a confirmed serving claim. Plain `items` (browse) carry no dish
 * claim. The two lists must never mix under one "serving" heading;
 * `withoutDishConstraint` removes the dish constraint explicitly for the
 * browse-all-nearby next step.
 */

/** Map-tile delivery is a map concern, reported alongside — never merged into — data state. */
export type MapTilesStatus = "ready" | "failed" | "unconfigured";

export type RestaurantResultsPresentation = Data.TaggedEnum<{
  Loading: {};
  Ready: {
    readonly count: number;
    readonly capped: boolean;
    readonly dishId: string | null;
  };
  NoVenues: { readonly datasetEmpty: boolean };
  NoDishEvidence: {
    readonly dishId: string;
    readonly dishName: string | null;
    readonly dishSlug: string | null;
    readonly radius: number;
  };
  FiltersTooRestrictive: { readonly activeFilterCount: number };
  LocationRequired: { readonly reason: "choose-region" | "origin-required" };
  DataError: { readonly message: string };
}>;

export const RestaurantResultsPresentation = Data.taggedEnum<RestaurantResultsPresentation>();

export interface ResultsClassificationInput {
  readonly rows: number;
  readonly limit: number;
  readonly failed: boolean;
  readonly failureMessage: string | null;
  readonly isLoading: boolean;
  readonly dishId: string | null;
  readonly dishName: string | null;
  readonly dishSlug: string | null;
  readonly datasetEmpty: boolean;
  readonly hasScope: boolean;
  readonly hasOrigin: boolean;
  readonly sort: RestaurantSearch["sort"];
  readonly radius: number;
  readonly activeFilterCount: number;
  readonly mapTiles: MapTilesStatus;
}

export interface ClassifiedResults {
  readonly presentation: RestaurantResultsPresentation;
  readonly mapTiles: MapTilesStatus;
}

const FALLBACK_ERROR_MESSAGE = "Discovery is unavailable. Retry.";

/**
 * Precedence: DataError (thrown failure, even over stale rows) > Ready >
 * Loading > NoVenues-when-catalog-empty (empty catalog beats the dish
 * filter, mirroring resolveResultsState) > NoDishEvidence > nearest-without-
 * origin > LocationRequired > FiltersTooRestrictive > NoVenues.
 */
export const resolveRestaurantResults = (input: ResultsClassificationInput): ClassifiedResults => {
  const mapTiles = input.mapTiles;

  if (input.failed) {
    return {
      presentation: RestaurantResultsPresentation.DataError({
        message: input.failureMessage ?? FALLBACK_ERROR_MESSAGE,
      }),
      mapTiles,
    };
  }

  if (input.rows > 0) {
    return {
      presentation: RestaurantResultsPresentation.Ready({
        count: input.rows,
        capped: input.rows >= input.limit,
        dishId: input.dishId,
      }),
      mapTiles,
    };
  }

  if (input.isLoading) {
    return { presentation: RestaurantResultsPresentation.Loading(), mapTiles };
  }

  if (input.datasetEmpty) {
    return {
      presentation: RestaurantResultsPresentation.NoVenues({ datasetEmpty: true }),
      mapTiles,
    };
  }

  if (input.dishId !== null) {
    return {
      presentation: RestaurantResultsPresentation.NoDishEvidence({
        dishId: input.dishId,
        dishName: input.dishName,
        dishSlug: input.dishSlug,
        radius: input.radius,
      }),
      mapTiles,
    };
  }

  if (input.sort === "nearest" && !input.hasOrigin) {
    return {
      presentation: RestaurantResultsPresentation.LocationRequired({
        reason: "origin-required",
      }),
      mapTiles,
    };
  }

  if (!input.hasScope) {
    return {
      presentation: RestaurantResultsPresentation.LocationRequired({
        reason: "choose-region",
      }),
      mapTiles,
    };
  }

  if (input.activeFilterCount > 0) {
    return {
      presentation: RestaurantResultsPresentation.FiltersTooRestrictive({
        activeFilterCount: input.activeFilterCount,
      }),
      mapTiles,
    };
  }

  return {
    presentation: RestaurantResultsPresentation.NoVenues({ datasetEmpty: false }),
    mapTiles,
  };
};

/** Sheet/drawer state for the legacy resolver. Ready renders rows (null);
 *  DataError renders through the presentation match, never as a fake state. */
export type SheetState =
  | "loading"
  | "no-scope"
  | "no-evidence"
  | "no-area"
  | "empty-catalog"
  | "no-match"
  | null;

export const toSheetState = (presentation: RestaurantResultsPresentation): SheetState =>
  RestaurantResultsPresentation.$match(presentation, {
    Loading: (): SheetState => "loading",
    Ready: (): SheetState => null,
    NoVenues: ({ datasetEmpty }): SheetState => (datasetEmpty ? "empty-catalog" : "no-area"),
    NoDishEvidence: (): SheetState => "no-evidence",
    FiltersTooRestrictive: (): SheetState => "no-match",
    LocationRequired: (): SheetState => "no-scope",
    DataError: (): SheetState => null,
  });

/** Map overlay/list notice: tiles failed or unconfigured — the list still works. */
export const mapTilesNeedsNotice = (status: MapTilesStatus): boolean => status !== "ready";

/**
 * Narrowing constraints beyond the region itself. Count every one the caller
 * applies (text, cuisine, non-default channel, portion, budget, non-default
 * sort): a scoped query with zero rows and a nonzero count is
 * filters-too-restrictive; zero means the region genuinely has no mapped venues.
 */
export const countRestrictiveFilters = (
  search: Pick<RestaurantSearch, "q" | "cuisine" | "channel" | "portion" | "budget" | "sort">,
): number => {
  let count = 0;

  if (search.q !== "") count += 1;

  if (search.cuisine !== "") count += 1;

  if (search.channel !== "dine_in") count += 1;

  if (search.portion !== undefined) count += 1;

  if (search.budget !== undefined) count += 1;

  if (search.sort !== "recommended") count += 1;

  return count;
};

/**
 * Supported radius ladder (meters). Mirrors the filters-sheet RADII and the
 * schema bounds (100..50000, default 5000): no schema change needed.
 * Search-wider offers `widerRadii(current)`; `nextWiderRadius` is the single
 * next step. Null at the top rung means "already widest — change region".
 */
export const RADIUS_LADDER = [1000, 5000, 10000, 25000, 50000] as const;

export type RadiusRung = (typeof RADIUS_LADDER)[number];

export const MIN_RADIUS = 100;

export const MAX_RADIUS = 50000;

export const DEFAULT_RADIUS = 5000;

export const nextWiderRadius = (current: number): RadiusRung | null => {
  for (const rung of RADIUS_LADDER) {
    if (rung > current) return rung;
  }

  return null;
};

export const widerRadii = (current: number): ReadonlyArray<RadiusRung> =>
  RADIUS_LADDER.filter((rung) => rung > current);

export type SortMode = RestaurantSearch["sort"];

export const SORT_MODES = ["recommended", "nearest", "price_low", "price_high"] as const;

export interface SortAvailabilityInput {
  readonly rowCount: number;
  readonly dishActive: boolean;
  readonly hasOrigin: boolean;
  readonly comparablePricedCount: number;
}

/**
 * Meaningful sort choices only: 0 rows → none, 1 row → none (no real
 * comparison). Otherwise recommended always; nearest needs an explicit
 * origin (schema: nearest requires coordinates); price sorts need the dish
 * constraint plus 2+ comparable reviewed prices — the same >= 2 gate the
 * price-compare rank badge uses.
 */
export const availableSortModes = (input: SortAvailabilityInput): ReadonlyArray<SortMode> => {
  if (input.rowCount <= 1) return [];

  const modes: Array<SortMode> = ["recommended"];

  if (input.hasOrigin) modes.push("nearest");

  if (input.dishActive && input.comparablePricedCount >= 2) {
    modes.push("price_low", "price_high");
  }

  return modes;
};

export interface ComparablePriceInput {
  readonly currentEnough: boolean | null;
  readonly priceKind: string | null;
  readonly taxTreatment: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
}

/**
 * Currency/price display gating: eligible price info only. Mirrors the
 * search-dish.sql qualified gate (current_enough, listed kind, included tax)
 * plus client-side amount/currency validity. Stale, receipt-paid, or
 * tax-unknown lines never render as comparable prices; conversions render
 * only from a supplied real FX rate (quote converts at exactly one).
 */
export const isComparablePrice = (input: ComparablePriceInput): boolean => {
  if (input.currentEnough !== true) return false;

  if (input.priceKind !== "listed") return false;

  if (input.taxTreatment !== "included") return false;

  if (input.amount === null || input.currency === null) return false;

  if (!isAmount(input.amount) || !isCurrency(input.currency)) return false;

  return true;
};

/**
 * Browse-all-nearby next step: removes the dish constraint explicitly.
 * Price sorts and budget/currency cannot survive without the dish (schema
 * requires dish+portion+currency for price comparison); nearest is kept
 * because the origin is independent of the dish. The resulting list makes
 * no serving claim.
 */
export const withoutDishConstraint = (search: RestaurantSearch): Partial<RestaurantSearch> => {
  if (search.sort === "price_low" || search.sort === "price_high") {
    return {
      dish: undefined,
      portion: undefined,
      budget: undefined,
      currency: undefined,
      sort: "recommended",
    };
  }

  return {
    dish: undefined,
    portion: undefined,
    budget: undefined,
    currency: undefined,
  };
};
