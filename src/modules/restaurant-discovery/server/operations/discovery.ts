import { Data, Effect } from "effect";

import { DishService, getPublishedDishIdentities } from "@/modules/food-discovery/server/index";
import {
  type PhotoRef,
  RESTAURANT_PHOTO_WIDTHS,
  restaurantPhotoUrl,
} from "@/modules/restaurant-discovery/components/restaurant-photos";
import {
  type NearbyDishPrice,
  type NearbyDishPriceLookup,
  type NearbyPriceChannel,
  NEARBY_PRICE_RADII_KM,
  type NearbyPriceRadiusKm,
  type NearbyPriceScope,
} from "@/modules/restaurant-discovery/nearby-price";
import {
  restaurantSearchSchema,
  venuePhotoPreviewSchema,
} from "@/modules/restaurant-discovery/restaurant.schema";
import type {
  RestaurantSearch,
  VenuePhotoPreviewRequest,
} from "@/modules/restaurant-discovery/restaurant.schema";
import { FxRates, FxUnavailable } from "@/modules/restaurant-discovery/server/operations/fx";
import areas from "@/modules/restaurant-discovery/server/repository/sql/areas.sql";
import comparisons from "@/modules/restaurant-discovery/server/repository/sql/comparisons.sql";
import currencies from "@/modules/restaurant-discovery/server/repository/sql/dish-price-currencies.sql";
import localRanges from "@/modules/restaurant-discovery/server/repository/sql/local-price-ranges.sql";
import menuDishCandidates from "@/modules/restaurant-discovery/server/repository/sql/menu-dish-candidates.sql";
import sectionsQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-sections.sql";
import localizationsQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-localizations-by-venue.sql";
import menu from "@/modules/restaurant-discovery/server/repository/sql/menu.sql";
import nearbyDishPrices from "@/modules/restaurant-discovery/server/repository/sql/nearby-dish-prices.sql";
import photoPublishedByVenueIds from "@/modules/restaurant-discovery/server/repository/sql/photo-published-by-venue-ids.sql";
import searchArea from "@/modules/restaurant-discovery/server/repository/sql/search-area.sql";
import searchDish from "@/modules/restaurant-discovery/server/repository/sql/search-dish.sql";
import searchName from "@/modules/restaurant-discovery/server/repository/sql/search-name.sql";
import venue from "@/modules/restaurant-discovery/server/repository/sql/venue-detail.sql";
import { describeCause } from "@/server/database/errors";
import { runQuery } from "@/server/database/query";
import type { ExchangeRate } from "@/shared/money";

export class RestaurantNotFound extends Data.TaggedError("RestaurantNotFound")<{}> {}

export class RestaurantInputError extends Data.TaggedError("RestaurantInputError")<{
  readonly reason: string;
}> {}

export type Venue = (typeof venue)["~reylo"]["element"];

export type MenuOffering = (typeof menu)["~reylo"]["element"];

export type RestaurantResult = (typeof searchArea)["~reylo"]["element"];

export type DishRestaurantResult = (typeof searchDish)["~reylo"]["element"];

/** One published-photo row, inferred from the shared published-photos query. */
export type PhotoPublishedRow = (typeof photoPublishedByVenueIds)["~reylo"]["element"];

/** One menu arrangement row, inferred from the shared sections query. */
export type RestaurantMenuSectionRow = (typeof sectionsQuery)["~reylo"]["element"];

/** One stored localization row, inferred from the shared venue query. */
export type MenuLocalization = (typeof localizationsQuery)["~reylo"]["element"];

const locationParameters = (input: RestaurantSearch) => ({
  area: input.area,
  cuisine: input.cuisine,
  longitude: input.longitude ?? null,
  latitude: input.latitude ?? null,
  radius: input.radius,
  west: input.west ?? null,
  south: input.south ?? null,
  east: input.east ?? null,
  north: input.north ?? null,
});

export const listRestaurantAreas = runQuery("restaurants/areas", (sql) => areas.run(sql));

/**
 * Project one published-photo row into the shared PhotoRef contract.
 * Mirrors the photo service publish gate: rows without reserved dimensions
 * or alt text never reach the public contract, since the gallery would
 * shift layout and the image is not publishable. Such rows indicate a
 * bypassed publish gate, so they are excluded rather than rendered with
 * invented values. PhotoRef is the versioned external contract shared by
 * result cards and the detail gallery, so this projection is a contract
 * boundary, not a mirror DTO.
 */
const toPublicPhotoRef = (row: PhotoPublishedRow, index: number): PhotoRef | null => {
  if (row.alt_text === null || row.original_width === null || row.original_height === null) {
    return null;
  }

  const version = Number(row.variant_version);

  return {
    assetId: row.id,
    alt: row.alt_text,
    primary: index === 0,
    width: Number(row.original_width),
    height: Number(row.original_height),
    variants: RESTAURANT_PHOTO_WIDTHS.map((width) => ({
      width,
      url: restaurantPhotoUrl(row.id, version, width),
    })),
  };
};

export const getRestaurant = Effect.fn("restaurants.getRestaurant")(function* (
  venueId: string,
  channel: RestaurantSearch["channel"],
) {
  const detail = yield* runQuery("restaurants/detail", (sql) => venue.run(sql, { id: venueId }));

  if (detail === null) return yield* new RestaurantNotFound();

  const candidates = yield* runQuery("restaurants/menu-dish-candidates", (sql) =>
    menuDishCandidates.run(sql, { id: venueId }),
  );

  const published = yield* getPublishedDishIdentities(
    candidates.flatMap((row) => (row.dish_id === null ? [] : [row.dish_id])),
  );

  const offerings = yield* runQuery("restaurants/menu", (sql) =>
    menu.run(sql, {
      id: venueId,
      channel,
      published_dish_ids: published.map((dish) => BigInt(dish.id)),
    }),
  );

  const photoRows = yield* runQuery("restaurants/detail-photos", (sql) =>
    photoPublishedByVenueIds.run(sql, { venue_ids: [venueId] }),
  );

  const photos: Array<PhotoRef> = [];

  for (const row of photoRows) {
    const ref = toPublicPhotoRef(row, photos.length);

    if (ref !== null) photos.push(ref);
  }

  // Arrangement metadata for the venue menus, restricted to published
  // offering items so draft arrangement never leaks through the public
  // read. presentReviewed callers build
  // new Map(sections.flatMap(...)) from these rows; unsectioned items keep
  // their legacy order downstream.
  const menuIds = [...new Set(offerings.map((offering) => offering.menu_id))];

  const sectionGroups = yield* Effect.forEach(
    menuIds,
    (menuId) =>
      runQuery("restaurants/menu-sections", (sql) =>
        sectionsQuery.run(sql, { menu: menuId, venue: venueId }),
      ),
    { concurrency: 2 },
  );

  const publishedItems = new Set(offerings.map((offering) => offering.item_id));
  const sections = sectionGroups.flat().filter((row) => publishedItems.has(row.id));

  // Additive machine-translation tier: stored servable rows for this venue.
  // The panel overlays matching-hash rows below the approved tier (see
  // presentReviewedWithLocalizations); nothing here changes the offerings.
  const localizations = yield* runQuery("restaurants/menu-localizations", (sql) =>
    localizationsQuery.run(sql, { venue: venueId }),
  );

  return {
    venue: detail,
    offerings,
    photos,
    sections,
    localizations,
  };
});

export const searchRestaurants = Effect.fn("restaurants.searchRestaurants")(function* (
  request: RestaurantSearch,
) {
  const parsed = restaurantSearchSchema.safeParse(request);

  if (!parsed.success)
    return yield* new RestaurantInputError({
      reason: parsed.error.issues.map((issue) => issue.message).join("; "),
    });
  const input = parsed.data;
  const location = locationParameters(input);

  if (input.dish === undefined) {
    const items =
      input.q.length === 0
        ? yield* runQuery("restaurants/area-search", (sql) =>
            searchArea.run(sql, { ...location, limit: input.limit }),
          )
        : yield* runQuery("restaurants/name-search", (sql) =>
            searchName.run(sql, {
              ...location,
              q: input.q,
              sort: input.sort,
              limit: input.limit,
            }),
          );

    return { items, dishItems: [], dish: null, portions: [], ranges: [], comparisonRates: [] };
  }

  const dishes = yield* DishService;
  const dish = yield* dishes.getDish(input.dish, "en");

  const portionRows = yield* runQuery("restaurants/portions", (sql) =>
    comparisons.run(sql, { dish: BigInt(dish.id) }),
  );

  const offeringParams = {
    q: input.q,
    ...location,
    dish: BigInt(dish.id),
    channel: input.channel,
    portion: input.portion ?? null,
  };

  // Area price summaries cover the same geographic scope as the dish
  // search itself: a named area, a center+radius circle, or a bounded
  // viewport. The underlying SQL already scopes all three; only this gate
  // used to exclude radius and bounds. Minimum three venues per currency:
  // one or two observations are shown honestly in the compare list, but a
  // "range" needs a market, not a anecdote.
  const ranges =
    input.portion !== undefined &&
    (input.area !== "" || input.longitude !== undefined || input.west !== undefined)
      ? yield* runQuery("restaurants/local-price-range", (sql) =>
          localRanges.run(sql, { ...offeringParams, minimum_venues: 3 }),
        )
      : [];

  const comparisonRates: Array<ExchangeRate> = [];
  const rateCurrencies: Array<string> = [];
  const rateValues: Array<string> = [];

  if (input.sort.startsWith("price_") || input.budget !== undefined) {
    const quote = input.currency;

    if (quote === undefined)
      return yield* new RestaurantInputError({ reason: "Comparison currency is required" });

    const originals = yield* runQuery("restaurants/price-currencies", (sql) =>
      currencies.run(sql, offeringParams),
    );

    if (originals.length > 12)
      return yield* new RestaurantInputError({
        reason: "Choose a smaller area for currency comparison",
      });
    const fx = yield* FxRates;

    // One fixed rate per pair for all qualifying offerings, before the price query executes.
    // The quote currency converts at exactly one; every other pair resolves concurrently.
    const bases = [
      ...new Set(
        originals.flatMap((original) => (original.currency === null ? [] : [original.currency])),
      ),
    ];

    for (const base of bases) {
      if (base === quote) {
        rateCurrencies.push(base);
        rateValues.push("1");
      }
    }

    const rates = yield* Effect.forEach(
      bases.filter((base) => base !== quote),
      (base) =>
        fx.rate(base, quote).pipe(
          Effect.mapError((error) => {
            if (error instanceof FxUnavailable)
              return new FxUnavailable({
                reason:
                  "Budget or price sorting needs a current exchange rate. Retry or select the menu currency.",
              });

            return error;
          }),
          Effect.map((rate) => ({ base, value: rate.rate, rate })),
        ),
      { concurrency: 4 },
    );

    for (const entry of rates) {
      rateCurrencies.push(entry.base);
      rateValues.push(entry.value);
      comparisonRates.push(entry.rate);
    }
  }

  const dishItems = yield* runQuery("restaurants/dish-search", (sql) =>
    searchDish.run(sql, {
      ...offeringParams,
      q: input.q,
      sort: input.sort,
      budget: input.budget ?? null,
      currencies: rateCurrencies,
      rates: rateValues,
      limit: input.limit,
    }),
  );

  return {
    items: [],
    dishItems,
    dish: { id: dish.id, slug: dish.slug, name: dish.name },
    portions: portionRows,
    ranges,
    comparisonRates,
  };
});

/** Search-result photo preview: at most this many photos per venue. */
const MAX_PREVIEW_PHOTOS_PER_VENUE = 3;

/** One venue entry in the batched photo preview read. */
export interface VenuePhotoPreview {
  readonly venueId: string;
  readonly photos: ReadonlyArray<PhotoRef>;
}

/**
 * Batched published-photo attach for venue id lists. Search rows carry no
 * photos, so cards resolve previews through this single IN-clause query;
 * per-venue queries would be N+1. Inputs are Zod-bounded (1..50 uuids, the
 * search page size); every requested venue gets an entry, with an empty
 * list where nothing publishable exists. Photos are capped per venue so one
 * venue cannot dominate the payload.
 */
export const listVenuePhotoPreviews = Effect.fn("restaurants.venuePhotoPreviews")(function* (
  request: VenuePhotoPreviewRequest,
) {
  const parsed = venuePhotoPreviewSchema.safeParse(request);

  if (!parsed.success)
    return yield* new RestaurantInputError({
      reason: parsed.error.issues.map((issue) => issue.message).join("; "),
    });

  const venueIds = [...new Set(parsed.data.venueIds)];

  if (venueIds.length === 0) return [];

  const rows = yield* runQuery("restaurants/venue-photo-previews", (sql) =>
    photoPublishedByVenueIds.run(sql, { venue_ids: venueIds }),
  );

  const photosByVenue = new Map<string, Array<PhotoRef>>(venueIds.map((venueId) => [venueId, []]));

  for (const row of rows) {
    const list = photosByVenue.get(row.venue_id);

    if (list === undefined || list.length >= MAX_PREVIEW_PHOTOS_PER_VENUE) continue;

    const ref = toPublicPhotoRef(row, list.length);

    if (ref !== null) list.push(ref);
  }

  return [...photosByVenue].map(([venueId, photos]) => ({ venueId, photos }));
});

/** Database failure while resolving nearby prices. Never escapes to the transport: the lookup maps it to per-dish `unavailable` outcomes. */
export class NearbyPriceUnavailable extends Data.TaggedError("NearbyPriceUnavailable")<{
  readonly operation: string;
  readonly cause: string;
}> {}

/** One candidate row from the batched nearby-price pool, inferred from the query. */
export type NearbyDishPriceRow = (typeof nearbyDishPrices)["~reylo"]["element"];

/** Decimal-string transport form of stored bigint dish/place identities. */
const DECIMAL_ID = /^[1-9][0-9]{0,18}$/;

/** Candidate radii in meters, narrowest first, derived from the shared contract. */
const NEARBY_PRICE_RADIUS_METERS: ReadonlyArray<{
  readonly radiusKm: NearbyPriceRadiusKm;
  readonly meters: number;
}> = NEARBY_PRICE_RADII_KM.map((radiusKm) => ({ radiusKm, meters: radiusKm * 1000 }));

const NEARBY_PRICE_OPERATION = "restaurants/nearby-dish-prices";

/** Channels with price eligibility. */
const NEARBY_PRICE_CHANNELS: ReadonlySet<NearbyPriceChannel> = new Set([
  "dine_in",
  "takeaway",
  "delivery",
]);

/** A priced candidate with every field the priced contract requires. */
type PricedNearbyRow = NearbyDishPriceRow & {
  readonly venue_id: string;
  readonly venue_name: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly distance_meters: number;
  readonly item_id: string;
  readonly variant_id: string;
  readonly variant_name: string;
  readonly amount: string;
  readonly currency: string;
  readonly tax_treatment: string;
  readonly price_observed_at: string | Date;
  readonly price_valid_until: string | Date;
};

const isSupportedFix = (
  value: number | null | undefined,
  min: number,
  max: number,
): value is number => {
  if (value === null || value === undefined) {
    return false;
  }

  return Number.isFinite(value) && value >= min && value <= max;
};

/** Reylo infers timestamps as string or Date depending on the driver; the contract needs ISO strings. */
const toIsoString = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : value;

const stripLeadingZeros = (value: string): string => {
  const stripped = value.replace(/^0+/, "");

  return stripped === "" ? "0" : stripped;
};

/** Exact decimal comparison for NUMERIC-inferred amount strings (no float rounding). */
const compareAmounts = (left: string, right: string): number => {
  const [leftInt = "", leftFrac = ""] = left.split(".");
  const [rightInt = "", rightFrac = ""] = right.split(".");

  const leftNorm = stripLeadingZeros(leftInt);
  const rightNorm = stripLeadingZeros(rightInt);

  if (leftNorm.length !== rightNorm.length) {
    return leftNorm.length < rightNorm.length ? -1 : 1;
  }

  if (leftNorm !== rightNorm) {
    return leftNorm < rightNorm ? -1 : 1;
  }

  if (leftFrac !== rightFrac) {
    return leftFrac < rightFrac ? -1 : 1;
  }

  return 0;
};

const isPricedCandidate = (row: NearbyDishPriceRow): row is PricedNearbyRow =>
  row.price_eligible === true &&
  row.venue_id !== null &&
  row.venue_name !== null &&
  row.longitude !== null &&
  row.latitude !== null &&
  row.distance_meters !== null &&
  row.item_id !== null &&
  row.variant_id !== null &&
  row.variant_name !== null &&
  row.amount !== null &&
  row.currency !== null &&
  row.tax_treatment !== null &&
  row.price_observed_at !== null &&
  row.price_valid_until !== null;

/**
 * Cheapest eligible row wins the "starting price" ("from X"); ties break by
 * distance, then variant identity, so repeated lookups are stable. Callers
 * pass a non-empty scope; an empty scope degrades to serving-without-price
 * instead of throwing.
 */
const toPricedOutcome = (
  dishId: string,
  scope: NearbyPriceScope,
  scopeServingVenues: number,
  candidates: ReadonlyArray<PricedNearbyRow>,
  channel: NearbyDishPriceLookup["channel"],
): NearbyDishPrice => {
  const first = candidates[0];

  if (first === undefined) {
    return {
      dishId,
      outcome: "serving-without-price",
      scope,
      venueCount: scopeServingVenues,
      reason: "Approved serving evidence exists here but no current listed price was found",
    };
  }

  let starting = first;

  for (const candidate of candidates.slice(1)) {
    const order = compareAmounts(candidate.amount, starting.amount);

    if (
      order < 0 ||
      (order === 0 &&
        (candidate.distance_meters < starting.distance_meters ||
          (candidate.distance_meters === starting.distance_meters &&
            candidate.variant_id < starting.variant_id)))
    ) {
      starting = candidate;
    }
  }

  const comparable = candidates.filter(
    (row) =>
      row.comparison_key !== null &&
      row.comparison_key === starting.comparison_key &&
      row.currency === starting.currency,
  );

  const best = comparable.reduce<PricedNearbyRow | null>(
    (max, row) => (max === null || compareAmounts(row.amount, max.amount) > 0 ? row : max),
    null,
  );

  return {
    dishId,
    outcome: "priced",
    scope,
    venueCount: scopeServingVenues,
    pricedVenueCount: candidates.length,
    price: {
      amount: starting.amount,
      currency: starting.currency,
      kind: "listed",
      channel,
      taxTreatment: starting.tax_treatment,
      observedAt: toIsoString(starting.price_observed_at),
      validUntil: toIsoString(starting.price_valid_until),
    },
    variant: {
      itemId: starting.item_id,
      variantId: starting.variant_id,
      name: starting.variant_name,
    },
    venue: {
      venueId: starting.venue_id,
      branchName: starting.venue_name,
      latitude: starting.latitude,
      longitude: starting.longitude,
    },
    range:
      comparable.length >= 3 && best !== null
        ? {
            min: { amount: starting.amount, currency: starting.currency },
            max: { amount: best.amount, currency: best.currency },
            venueCount: comparable.length,
          }
        : undefined,
  };
};

const toNearbyDishPrice = (
  dishId: string,
  dishRows: ReadonlyArray<NearbyDishPriceRow>,
  input: NearbyDishPriceLookup,
): NearbyDishPrice => {
  const priced: Array<PricedNearbyRow> = [];
  const serving: Array<NearbyDishPriceRow> = [];

  for (const row of dishRows) {
    if (row.venue_id === null || row.distance_meters === null) continue;
    serving.push(row);

    if (isPricedCandidate(row)) priced.push(row);
  }

  for (const { radiusKm, meters } of NEARBY_PRICE_RADIUS_METERS) {
    const inScope = priced.filter((row) => row.distance_meters <= meters);

    if (inScope.length > 0) {
      const servingVenues = serving.filter(
        (row) => row.distance_meters !== null && row.distance_meters <= meters,
      ).length;

      return toPricedOutcome(
        dishId,
        { kind: "radius", radiusKm },
        servingVenues,
        inScope,
        input.channel,
      );
    }
  }

  const cityRow = dishRows[0];
  const cityPlaceId = input.cityPlaceId ?? null;

  if (
    cityRow !== undefined &&
    cityRow.city_resolved &&
    cityPlaceId !== null &&
    cityRow.city_label !== null
  ) {
    const scope: NearbyPriceScope = {
      kind: "city",
      cityPlaceId,
      cityLabel: cityRow.city_label,
      classification: "verified-city-membership",
    };

    const inCity = priced.filter((row) => row.in_city === true);

    if (inCity.length > 0) {
      const servingVenues = serving.filter((row) => row.in_city === true).length;

      return toPricedOutcome(dishId, scope, servingVenues, inCity, input.channel);
    }

    const cityServing = serving.filter((row) => row.in_city === true).length;

    if (cityServing > 0) {
      return {
        dishId,
        outcome: "serving-without-price",
        scope,
        venueCount: cityServing,
        reason:
          "Approved serving evidence exists in this city but no current listed dine-in price was found",
      };
    }
  }

  for (const { radiusKm, meters } of NEARBY_PRICE_RADIUS_METERS) {
    const served = serving.filter(
      (row) => row.distance_meters !== null && row.distance_meters <= meters,
    ).length;

    if (served > 0) {
      return {
        dishId,
        outcome: "serving-without-price",
        scope: { kind: "radius", radiusKm },
        venueCount: served,
        reason:
          "Approved serving evidence exists nearby but no current listed dine-in price was found",
      };
    }
  }

  if (serving.length > 0) {
    return {
      dishId,
      outcome: "serving-without-price",
      venueCount: serving.length,
      reason: "Approved serving evidence exists outside the nearby radii",
    };
  }

  let reason = "No approved serving evidence within 40km";

  if (cityPlaceId !== null) {
    if (cityRow !== undefined && cityRow.city_resolved) {
      reason = "No approved serving evidence within 40km or the requested city";
    } else {
      reason = "No approved serving evidence within 40km; the requested city could not be verified";
    }
  }

  return { dishId, outcome: "no-serving", reason };
};

/**
 * Batched nearby price lookup: one candidate pool for every requested dish
 * at one origin, results in input order. Each dish independently resolves
 * its first eligible scope (10km, then 20km, then 40km, then the requested
 * city); a price needs a listed, current-enough observation backed by
 * approved serving evidence. A range needs three or more comparable venues
 * (same portion comparability key and currency), otherwise the outcome
 * carries the single starting price. Database failures become per-dish
 * `unavailable` outcomes through the typed NearbyPriceUnavailable channel;
 * a missing or invalid fix becomes `unsupported-location` without a read.
 */
export const lookupNearbyDishPrices = Effect.fn("restaurants.lookupNearbyDishPrices")(function* (
  input: NearbyDishPriceLookup,
) {
  const { dishIds, latitude, longitude, channel } = input;

  for (const dishId of dishIds) {
    if (!DECIMAL_ID.test(dishId)) {
      return yield* new RestaurantInputError({ reason: `Invalid dish id: ${dishId}` });
    }
  }

  if (!NEARBY_PRICE_CHANNELS.has(channel)) {
    return yield* new RestaurantInputError({ reason: `Unsupported channel: ${channel}` });
  }

  const cityPlaceId = input.cityPlaceId ?? null;

  if (cityPlaceId !== null && !DECIMAL_ID.test(cityPlaceId)) {
    return yield* new RestaurantInputError({ reason: `Invalid city place id: ${cityPlaceId}` });
  }

  if (!isSupportedFix(latitude, -90, 90) || !isSupportedFix(longitude, -180, 180)) {
    return dishIds.map((dishId): NearbyDishPrice => ({
      dishId,
      outcome: "unsupported-location",
      reason: "Nearby prices need a valid latitude/longitude fix",
    }));
  }

  if (dishIds.length === 0) return [];

  const rows = yield* Effect.catchTag(
    runQuery(NEARBY_PRICE_OPERATION, (sql) =>
      nearbyDishPrices.run(sql, {
        dish_ids: dishIds.map((dishId) => BigInt(dishId)),
        longitude,
        latitude,
        channel,
        city_place_id: cityPlaceId === null ? null : BigInt(cityPlaceId),
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new NearbyPriceUnavailable({
            operation: NEARBY_PRICE_OPERATION,
            cause: describeCause(cause),
          }),
      ),
    ),
    "NearbyPriceUnavailable",
    (failure) =>
      Effect.as(
        Effect.logWarning("Nearby dish prices unavailable", {
          operation: failure.operation,
          cause: failure.cause,
        }),
        null,
      ),
  );

  if (rows === null) {
    return input.dishIds.map((dishId): NearbyDishPrice => ({
      dishId,
      outcome: "unavailable",
      reason: "Dish prices are temporarily unavailable",
    }));
  }

  const rowsByDish = new Map<string, Array<NearbyDishPriceRow>>();

  for (const row of rows) {
    if (row.dish_id === null) continue;
    const list = rowsByDish.get(row.dish_id) ?? [];
    list.push(row);
    rowsByDish.set(row.dish_id, list);
  }

  return input.dishIds.map((dishId) =>
    toNearbyDishPrice(dishId, rowsByDish.get(dishId) ?? [], input),
  );
});
