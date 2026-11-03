import { Data, Effect } from "effect";

import { DishService, getPublishedDishIdentities } from "@/modules/food-discovery/server/index";
import {
  type PhotoRef,
  RESTAURANT_PHOTO_WIDTHS,
  restaurantPhotoUrl,
} from "@/modules/restaurant-discovery/components/restaurant-photos";
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
import photoPublishedByVenueIds from "@/modules/restaurant-discovery/server/repository/sql/photo-published-by-venue-ids.sql";
import searchArea from "@/modules/restaurant-discovery/server/repository/sql/search-area.sql";
import searchDish from "@/modules/restaurant-discovery/server/repository/sql/search-dish.sql";
import searchName from "@/modules/restaurant-discovery/server/repository/sql/search-name.sql";
import venue from "@/modules/restaurant-discovery/server/repository/sql/venue-detail.sql";
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
