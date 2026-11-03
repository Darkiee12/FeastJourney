import { describe, expect, test } from "bun:test";

import {
  availableSortModes,
  countRestrictiveFilters,
  isComparablePrice,
  mapTilesNeedsNotice,
  nextWiderRadius,
  resolveRestaurantResults,
  RADIUS_LADDER,
  RestaurantResultsPresentation,
  toSheetState,
  widerRadii,
  withoutDishConstraint,
  type ResultsClassificationInput,
} from "@/modules/restaurant-discovery/restaurant-results-state";
import type { RestaurantSearch } from "@/modules/restaurant-discovery/restaurant.schema";

const base: ResultsClassificationInput = {
  rows: 0,
  limit: 30,
  failed: false,
  failureMessage: null,
  isLoading: false,
  dishId: null,
  dishName: null,
  dishSlug: null,
  datasetEmpty: false,
  hasScope: true,
  hasOrigin: false,
  sort: "recommended",
  radius: 5000,
  activeFilterCount: 0,
  mapTiles: "ready",
};

const kindOf = (input: ResultsClassificationInput): string =>
  RestaurantResultsPresentation.$match(resolveRestaurantResults(input).presentation, {
    Loading: () => "loading",
    Ready: () => "ready",
    NoVenues: () => "no-venues",
    NoDishEvidence: () => "no-dish-evidence",
    FiltersTooRestrictive: () => "filters-too-restrictive",
    LocationRequired: () => "location-required",
    DataError: () => "error",
  });

describe("resolveRestaurantResults precedence", () => {
  test("thrown failure beats stale rows — never masks an outage", () => {
    const classified = resolveRestaurantResults({
      ...base,
      rows: 5,
      failed: true,
      failureMessage: "Search unavailable",
    });

    expect(kindOf({ ...base, rows: 5, failed: true, failureMessage: "x" })).toBe("error");
    expect(classified.mapTiles).toBe("ready");

    const errorMessage = RestaurantResultsPresentation.$match(classified.presentation, {
      Loading: () => "",
      Ready: () => "",
      NoVenues: () => "",
      NoDishEvidence: () => "",
      FiltersTooRestrictive: () => "",
      LocationRequired: () => "",
      DataError: ({ message }) => message,
    });

    expect(errorMessage).toBe("Search unavailable");
  });

  test("empty array never implies an outage", () => {
    expect(kindOf(base)).toBe("no-venues");
    expect(kindOf({ ...base, dishId: "42" })).toBe("no-dish-evidence");
  });

  test("rows beat loading — results render, never a fake count", () => {
    const classified = resolveRestaurantResults({ ...base, rows: 3, isLoading: true });

    expect(kindOf({ ...base, rows: 3, isLoading: true })).toBe("ready");
    expect(toSheetState(classified.presentation)).toBeNull();

    const detail = RestaurantResultsPresentation.$match(classified.presentation, {
      Loading: () => ({ count: -1, capped: false, dishId: null }),
      Ready: ({ count, capped, dishId }) => ({ count, capped, dishId }),
      NoVenues: () => ({ count: -1, capped: false, dishId: null }),
      NoDishEvidence: () => ({ count: -1, capped: false, dishId: null }),
      FiltersTooRestrictive: () => ({ count: -1, capped: false, dishId: null }),
      LocationRequired: () => ({ count: -1, capped: false, dishId: null }),
      DataError: () => ({ count: -1, capped: false, dishId: null }),
    });

    expect(detail).toEqual({ count: 3, capped: false, dishId: null });
  });

  test("capped flag follows the page limit heuristic", () => {
    expect(kindOf({ ...base, rows: 30, limit: 30 })).toBe("ready");
  });

  test("empty catalog beats the dish filter", () => {
    const classified = resolveRestaurantResults({
      ...base,
      dishId: "42",
      datasetEmpty: true,
      hasScope: false,
    });

    expect(kindOf({ ...base, dishId: "42", datasetEmpty: true, hasScope: false })).toBe(
      "no-venues",
    );
    expect(toSheetState(classified.presentation)).toBe("empty-catalog");
  });

  test("dish mode with catalog elsewhere is no-dish-evidence with next-step context", () => {
    const classified = resolveRestaurantResults({
      ...base,
      dishId: "42",
      dishName: "Pho",
      dishSlug: "pho",
      radius: 5000,
    });

    expect(kindOf({ ...base, dishId: "42" })).toBe("no-dish-evidence");
    expect(toSheetState(classified.presentation)).toBe("no-evidence");

    const context = RestaurantResultsPresentation.$match(classified.presentation, {
      Loading: () => null,
      Ready: () => null,
      NoVenues: () => null,
      NoDishEvidence: ({ dishId, dishSlug, radius }) => ({ dishId, dishSlug, radius }),
      FiltersTooRestrictive: () => null,
      LocationRequired: () => null,
      DataError: () => null,
    });

    expect(context).toEqual({ dishId: "42", dishSlug: "pho", radius: 5000 });
  });

  test("nearest without origin requires location, not an empty list", () => {
    expect(kindOf({ ...base, sort: "nearest", hasOrigin: false })).toBe("location-required");
    expect(kindOf({ ...base, sort: "nearest", hasOrigin: true })).toBe("no-venues");
  });

  test("no browsing scope requires location choice", () => {
    const classified = resolveRestaurantResults({ ...base, hasScope: false });

    expect(kindOf({ ...base, hasScope: false })).toBe("location-required");
    expect(toSheetState(classified.presentation)).toBe("no-scope");

    const locationReason = RestaurantResultsPresentation.$match(classified.presentation, {
      Loading: () => "",
      Ready: () => "",
      NoVenues: () => "",
      NoDishEvidence: () => "",
      FiltersTooRestrictive: () => "",
      LocationRequired: ({ reason }) => reason,
      DataError: () => "",
    });

    expect(locationReason).toBe("choose-region");
  });

  test("scoped region with narrowing filters is filters-too-restrictive", () => {
    const classified = resolveRestaurantResults({ ...base, activeFilterCount: 2 });

    expect(kindOf({ ...base, activeFilterCount: 2 })).toBe("filters-too-restrictive");
    expect(toSheetState(classified.presentation)).toBe("no-match");
  });

  test("scoped bare region with catalog is no-venues", () => {
    expect(toSheetState(resolveRestaurantResults(base).presentation)).toBe("no-area");
  });

  test("map tiles ride alongside, never merged into data state", () => {
    const failed = resolveRestaurantResults({ ...base, mapTiles: "failed" });

    expect(failed.mapTiles).toBe("failed");
    expect(kindOf({ ...base, mapTiles: "failed" })).toBe("no-venues");
    expect(mapTilesNeedsNotice("failed")).toBe(true);
    expect(mapTilesNeedsNotice("unconfigured")).toBe(true);
    expect(mapTilesNeedsNotice("ready")).toBe(false);
  });
});

describe("countRestrictiveFilters", () => {
  const bare = {
    q: "",
    cuisine: "",
    channel: "dine_in",
    portion: undefined,
    budget: undefined,
    sort: "recommended",
  } as const;

  test("bare region counts zero", () => {
    expect(countRestrictiveFilters(bare)).toBe(0);
  });

  test("every narrowing constraint counts, including text search", () => {
    expect(
      countRestrictiveFilters({
        ...bare,
        q: "pho",
        cuisine: "vietnamese",
        channel: "takeaway",
        portion: "regular",
        budget: "100000",
        sort: "price_low",
      }),
    ).toBe(6);
  });
});

describe("radius ladder", () => {
  test("ladder matches filters-sheet rungs and schema bounds", () => {
    expect([...RADIUS_LADDER]).toEqual([1000, 5000, 10000, 25000, 50000]);
  });

  test("next step up, null at the top rung", () => {
    expect(nextWiderRadius(100)).toBe(1000);
    expect(nextWiderRadius(5000)).toBe(10000);
    expect(nextWiderRadius(25000)).toBe(50000);
    expect(nextWiderRadius(50000)).toBeNull();
  });

  test("search-wider offers every rung above current", () => {
    expect([...widerRadii(5000)]).toEqual([10000, 25000, 50000]);
    expect([...widerRadii(50000)]).toEqual([]);
  });
});

describe("sort availability", () => {
  test("0 rows offer no sort choice", () => {
    expect([
      ...availableSortModes({
        rowCount: 0,
        dishActive: true,
        hasOrigin: true,
        comparablePricedCount: 5,
      }),
    ]).toEqual([]);
  });

  test("1 row offers no sort choice", () => {
    expect([
      ...availableSortModes({
        rowCount: 1,
        dishActive: true,
        hasOrigin: true,
        comparablePricedCount: 1,
      }),
    ]).toEqual([]);
  });

  test("browse rows offer recommended, plus nearest with an origin", () => {
    expect([
      ...availableSortModes({
        rowCount: 4,
        dishActive: false,
        hasOrigin: false,
        comparablePricedCount: 0,
      }),
    ]).toEqual(["recommended"]);
    expect([
      ...availableSortModes({
        rowCount: 4,
        dishActive: false,
        hasOrigin: true,
        comparablePricedCount: 0,
      }),
    ]).toEqual(["recommended", "nearest"]);
  });

  test("price sorts need the dish plus 2+ comparable reviewed prices", () => {
    expect([
      ...availableSortModes({
        rowCount: 4,
        dishActive: true,
        hasOrigin: false,
        comparablePricedCount: 1,
      }),
    ]).toEqual(["recommended"]);
    expect([
      ...availableSortModes({
        rowCount: 4,
        dishActive: true,
        hasOrigin: true,
        comparablePricedCount: 2,
      }),
    ]).toEqual(["recommended", "nearest", "price_low", "price_high"]);
  });
});

describe("currency gating", () => {
  test("eligible listed current price passes", () => {
    expect(
      isComparablePrice({
        currentEnough: true,
        priceKind: "listed",
        taxTreatment: "included",
        amount: "65000",
        currency: "VND",
      }),
    ).toBe(true);
  });

  test("stale, receipt-paid, or tax-unknown prices never qualify", () => {
    expect(
      isComparablePrice({
        currentEnough: false,
        priceKind: "listed",
        taxTreatment: "included",
        amount: "65000",
        currency: "VND",
      }),
    ).toBe(false);
    expect(
      isComparablePrice({
        currentEnough: true,
        priceKind: "paid_unit",
        taxTreatment: "included",
        amount: "65000",
        currency: "VND",
      }),
    ).toBe(false);
    expect(
      isComparablePrice({
        currentEnough: true,
        priceKind: "listed",
        taxTreatment: "unknown",
        amount: "65000",
        currency: "VND",
      }),
    ).toBe(false);
  });

  test("missing or invalid amount/currency never qualifies", () => {
    expect(
      isComparablePrice({
        currentEnough: true,
        priceKind: "listed",
        taxTreatment: "included",
        amount: null,
        currency: "VND",
      }),
    ).toBe(false);
    expect(
      isComparablePrice({
        currentEnough: true,
        priceKind: "listed",
        taxTreatment: "included",
        amount: "free",
        currency: "VND",
      }),
    ).toBe(false);
    expect(
      isComparablePrice({
        currentEnough: true,
        priceKind: "listed",
        taxTreatment: "included",
        amount: "65000",
        currency: "XX",
      }),
    ).toBe(false);
  });
});

describe("withoutDishConstraint", () => {
  const search: RestaurantSearch = {
    q: "",
    area: "Ho Chi Minh City",
    cuisine: "",
    dish: "42",
    radius: 5000,
    channel: "dine_in",
    sort: "price_low",
    limit: 30,
  };

  test("removes the dish and everything that depends on it", () => {
    expect(withoutDishConstraint(search)).toEqual({
      dish: undefined,
      portion: undefined,
      budget: undefined,
      currency: undefined,
      sort: "recommended",
    });
  });

  test("keeps non-price sorts — origin is independent of the dish", () => {
    expect(withoutDishConstraint({ ...search, sort: "nearest" })).toEqual({
      dish: undefined,
      portion: undefined,
      budget: undefined,
      currency: undefined,
    });
  });
});
