import { Context, Data, Effect, Layer } from "effect";

import type { DishProfile, DishSummary } from "@/modules/food-discovery/server/domain/dish";
import {
  DishNotFound,
  InvalidLocale,
  InvalidSearchFilter,
  PlaceNotFound,
} from "@/modules/food-discovery/server/domain/errors";
import {
  encodeDbId,
  isDbIdString,
  isLanguageTag,
  isSlug,
} from "@/modules/food-discovery/server/domain/ids";
import {
  isSearchableQuery,
  normalizeSearchKey,
  pickDisplayName,
  toContainsKey,
  toPrefixKey,
  asLocalizedName,
} from "@/modules/food-discovery/server/domain/search";
import {
  decodeBrowseCursor,
  decodeFilterCursor,
  decodeSearchCursor,
  encodeCursor,
} from "@/modules/food-discovery/server/operations/cursor";
import {
  toPublishedImage,
  type PublishedDishImage,
} from "@/modules/food-discovery/server/operations/dish-media-service";
import {
  DishRelationsRepository,
  type DishNameRow,
  type DishPlaceRow,
  type DishPublishedMediaRow,
} from "@/modules/food-discovery/server/repository/dish-relations-repository";
import type { DishRecord } from "@/modules/food-discovery/server/repository/dish-repository";
import { DishRepository } from "@/modules/food-discovery/server/repository/dish-repository";
import { IngredientRepository } from "@/modules/food-discovery/server/repository/ingredient-repository";
import type { PlaceNameRow } from "@/modules/food-discovery/server/repository/place-repository";
import { PlaceRepository } from "@/modules/food-discovery/server/repository/place-repository";
import dishCarouselCountry from "@/modules/food-discovery/server/repository/sql/dish-carousel-country.sql";
import dishCarouselNearby from "@/modules/food-discovery/server/repository/sql/dish-carousel-nearby.sql";
import dishCarouselWorldwide from "@/modules/food-discovery/server/repository/sql/dish-carousel-worldwide.sql";
import dishRecommendationCandidatesNearby from "@/modules/food-discovery/server/repository/sql/dish-recommendation-candidates-nearby.sql";
import { TaxonomyRepository } from "@/modules/food-discovery/server/repository/taxonomy-repository";
import type { Database } from "@/server/database/client";
import type {
  DatabaseUnavailable,
  PersistenceConflict,
  PersistenceError,
  TransactionConflict,
} from "@/server/database/errors";
import type { DatabaseError } from "@/server/database/query";
import { runQuery } from "@/server/database/query";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const FAR_FUTURE = "9999-12-31T23:59:59.999Z";

const clampLimit = (limit: number | undefined, fallback: number): number => {
  if (limit === undefined || Number.isNaN(limit)) {
    return fallback;
  }

  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
};

const checkLocale = (locale: string): Effect.Effect<string, InvalidLocale> =>
  isLanguageTag(locale) ? Effect.succeed(locale) : Effect.fail(new InvalidLocale({ locale }));

const unixSeconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const groupByDish = <Row>(
  rows: ReadonlyArray<Row>,
  key: (row: Row) => bigint,
): ReadonlyMap<string, Array<Row>> => {
  const groups = new Map<string, Array<Row>>();

  for (const row of rows) {
    const groupKey = key(row).toString();
    const existing = groups.get(groupKey);

    if (existing === undefined) {
      groups.set(groupKey, [row]);
    } else {
      existing.push(row);
    }
  }

  return groups;
};

const englishNameOf = (names: ReadonlyArray<DishNameRow>): string | undefined => {
  const preferred = names.find((entry) => entry.language_tag === "en" && entry.is_preferred);

  return (preferred ?? names.find((entry) => entry.language_tag === "en"))?.name;
};

const displayNameOf = (names: ReadonlyArray<DishNameRow>, locale: string) => {
  const picked = pickDisplayName(names.map(asLocalizedName), locale);

  if (picked === undefined) {
    return { name: undefined, language: undefined };
  }

  return { name: picked.name, language: picked.languageTag };
};

export type DishServiceError =
  | DishNotFound
  | InvalidLocale
  | InvalidSearchFilter
  | PlaceNotFound
  | DatabaseUnavailable
  | PersistenceError
  | PersistenceConflict
  | TransactionConflict;

export interface SearchDishesInput {
  readonly q?: string | undefined;
  readonly locale?: string | undefined;
  readonly ingredientIds?: ReadonlyArray<string> | undefined;
  readonly ingredientMode?: string | undefined;
  readonly categorySlugs?: ReadonlyArray<string> | undefined;
  readonly categoryMode?: string | undefined;
  readonly cuisine?: string | undefined;
  readonly country?: string | undefined;
  readonly region?: string | undefined;
  readonly placeId?: string | undefined;
  readonly association?: string | undefined;
  readonly sort?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface SearchDishesOutput {
  readonly items: ReadonlyArray<DishSummary>;
  readonly nextCursor: string | null;
}

export interface LocalCarouselInput {
  readonly latitude?: number | undefined;
  readonly longitude?: number | undefined;
  readonly country?: string | undefined;
  /** Canonical city scope: a decimal place id; serves the place subtree. */
  readonly place?: string | undefined;
  readonly worldwide?: boolean | undefined;
  readonly locale?: string | undefined;
  readonly limit?: number | undefined;
  /**
   * Rotation seed. Same seed + same scope -> same dish order (stable within
   * a session, deterministic in tests); a new seed ("another set") -> a new
   * order. Defaults to 0 so an omitted seed is stable per scope.
   */
  readonly seed?: number | undefined;
}

/**
 * Discriminated carousel scope: exactly one variant per call. The flat
 * {@link LocalCarouselInput} wire shape can hold every field at once, so
 * {@link resolveCarouselScope} normalizes it here — ambiguous combinations
 * (worldwide with coordinates, partial coordinates) fail closed with
 * {@link InvalidSearchFilter} instead of silently running the precise
 * search. Coordinates never leave the Nearby variant: logs, cache keys, and
 * the response only ever see the coarse scope names below.
 */
export type CarouselScope = Data.TaggedEnum<{
  Nearby: {
    readonly latitude: number;
    readonly longitude: number;
    /** Country fallback pool when the precise bands are empty; null when absent. */
    readonly country: string | null;
  };
  Country: { readonly country: string };
  /** Canonical city scope: serves the place subtree, then ancestor pools. */
  City: { readonly placeId: string };
  Worldwide: {};
}>;

export const CarouselScope = Data.taggedEnum<CarouselScope>();

/** Coarse scope names for logs, cache keys, and the requested/served labels. */
export type CarouselScopeName = "nearby" | "country" | "city" | "worldwide";

/** Which exhausted scopes a fallback skipped; absent when nothing was skipped. */
export type CarouselFallbackReason =
  | "nearby-empty"
  | "country-empty"
  | "city-empty"
  | "city-empty-country-empty"
  | "nearby-empty-country-empty";

export const carouselScopeName = (scope: CarouselScope): CarouselScopeName =>
  CarouselScope.$match(scope, {
    Country: (): CarouselScopeName => "country",
    City: (): CarouselScopeName => "city",
    Nearby: (): CarouselScopeName => "nearby",
    Worldwide: (): CarouselScopeName => "worldwide",
  });

const COUNTRY_PATTERN = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

/**
 * Normalize the flat carousel input to exactly one scope. Returns null for
 * the legacy no-scope call, which the operation serves as an honest empty
 * outcome labeled worldwide (no query runs). Every other shape resolves to
 * one variant; ambiguous or malformed shapes fail closed so no query ever
 * runs with a scope the caller did not actually request.
 */
export const resolveCarouselScope = (
  input: Pick<LocalCarouselInput, "country" | "latitude" | "longitude" | "place" | "worldwide">,
): Effect.Effect<CarouselScope | null, InvalidSearchFilter> => {
  const latitude = input.latitude;
  const longitude = input.longitude;
  const country = input.country;
  const place = input.place;

  if (input.worldwide === true) {
    if (
      latitude !== undefined ||
      longitude !== undefined ||
      country !== undefined ||
      place !== undefined
    ) {
      return Effect.fail(
        new InvalidSearchFilter({
          reason: "worldwide must not carry coordinates, country, or city; send one scope only",
        }),
      );
    }

    return Effect.succeed(CarouselScope.Worldwide());
  }

  if (place !== undefined) {
    if (latitude !== undefined || longitude !== undefined || country !== undefined) {
      return Effect.fail(
        new InvalidSearchFilter({
          reason: "city place must not carry coordinates or country; send one scope only",
        }),
      );
    }

    if (!isDbIdString(place)) {
      return Effect.fail(
        new InvalidSearchFilter({ reason: "city place must be a decimal id string" }),
      );
    }

    return Effect.succeed(CarouselScope.City({ placeId: place }));
  }

  if (latitude !== undefined || longitude !== undefined) {
    if (latitude === undefined || longitude === undefined) {
      return Effect.fail(
        new InvalidSearchFilter({ reason: "latitude and longitude must be sent together" }),
      );
    }

    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      return Effect.fail(
        new InvalidSearchFilter({
          reason: "latitude must be between -90 and 90 and longitude between -180 and 180",
        }),
      );
    }

    if (country !== undefined && !COUNTRY_PATTERN.test(country)) {
      return Effect.fail(new InvalidSearchFilter({ reason: "country must be an ISO 3166 code" }));
    }

    return Effect.succeed(CarouselScope.Nearby({ country: country ?? null, latitude, longitude }));
  }

  if (country !== undefined) {
    if (!COUNTRY_PATTERN.test(country)) {
      return Effect.fail(new InvalidSearchFilter({ reason: "country must be an ISO 3166 code" }));
    }

    return Effect.succeed(CarouselScope.Country({ country }));
  }

  return Effect.succeed(null);
};

/** One scope attempt: the dish ids found plus which scope actually served them. */
interface CarouselSelection {
  readonly ids: ReadonlyArray<bigint>;
  readonly servedScope: CarouselScopeName;
  readonly fallbackReason: CarouselFallbackReason | null;
  /**
   * True when a sparse nearby pool was topped up with distinct
   * country-associated dishes (nearby dishes first). The client labels this
   * regional — never "near you" — while keeping the nearby cards up front.
   */
  readonly supplemented: boolean;
}

export interface CarouselIngredient {
  readonly name: string | undefined;
  readonly role: string;
}

/**
 * Homepage carousel image. Structurally identical to PublishedDishImage
 * (dish-media-service): generated same-origin delivery URL + responsive
 * srcSet, alt/attribution/focal preserved, primary = first by sort_order.
 * No license field — publication licensing is enforced at the publish
 * boundary, not re-exposed on the public projection.
 */
export type CarouselImage = PublishedDishImage;

export interface CarouselCard {
  readonly id: string;
  readonly slug: string;
  readonly name: string | undefined;
  readonly englishName: string | undefined;
  readonly nativeName: string | undefined;
  readonly nativeLanguageTag: string | undefined;
  readonly description: string | null;
  readonly descriptionLanguage: string | null;
  readonly ingredients: ReadonlyArray<CarouselIngredient>;
  readonly regionNames: ReadonlyArray<string>;
  readonly image: CarouselImage | null;
}

export interface LocalCarouselOutput {
  readonly items: ReadonlyArray<CarouselCard>;
  /**
   * Scope actually served — the honest label for the cards. A precise
   * request with no dishes in range falls back to the country pool when a
   * hint is known, then to an honest empty; a known-but-empty country pool
   * is an honest empty; an empty city pool falls back to the ancestor
   * country pool, then to an honest empty. Scoped requests never widen to
   * the worldwide pool — worldwide cards only ever serve an explicit
   * worldwide request. The client words the scope line from this, never
   * from what it asked for.
   */
  readonly scope: CarouselScopeName;
  /**
   * Scope the caller actually requested. Differs from {@link scope} only
   * when {@link fallback} is true, so the UI never mislabels fallback cards
   * as local coverage.
   */
  readonly requestedScope: CarouselScopeName;
  /** True when the served scope differs from the requested scope. */
  readonly fallback: boolean;
  /**
   * Which exhausted scopes the fallback skipped. Absent when no fallback
   * occurred. Never carries restaurant or venue claims.
   */
  readonly fallbackReason?: CarouselFallbackReason | undefined;
  /**
   * True when a sparse nearby pool was topped up with distinct
   * country-associated dishes (nearby dishes first). The UI labels this
   * regional — never "near you" — while keeping the nearby cards up front.
   */
  readonly supplemented: boolean;
}

export class DishService extends Context.Service<
  DishService,
  {
    readonly getDish: (
      idOrSlug: string,
      locale: string,
    ) => Effect.Effect<DishProfile, DishServiceError, Database>;
    /**
     * Status-agnostic read for curation surfaces. Same profile assembly as
     * {@link getDish} but without the publication gate, so drafts and
     * review candidates are inspectable. Never use for public discovery.
     */
    readonly getDishForCuration: (
      idOrSlug: string,
      locale: string,
    ) => Effect.Effect<DishProfile, DishServiceError, Database>;
    readonly searchDishes: (
      input: SearchDishesInput,
    ) => Effect.Effect<SearchDishesOutput, DishServiceError, Database>;
    /**
     * Batch carousel projection for the homepage local discovery: one
     * round of batched reads per relation (no per-card fetch), resolving
     * dishes by exactly one scope — a canonical city subtree, visitor
     * coordinates (nearest real associations first, with the country hint
     * as fallback pool), a country filter, or the worldwide pool.
     * Coordinates never invent dishes — every card is a real published
     * catalog association. Fallback runs inside this one operation (city ->
     * ancestor country -> honest empty; nearby -> country -> honest empty;
     * country -> honest empty; worldwide serves direct); the response
     * carries the requested scope, the served scope, and whether a fallback
     * occurred so the client never mislabels cards.
     */
    readonly getLocalCarousel: (
      input: LocalCarouselInput,
    ) => Effect.Effect<LocalCarouselOutput, DishServiceError, Database>;
    readonly getRelated: (
      idOrSlug: string,
      locale: string,
      limit: number | undefined,
    ) => Effect.Effect<ReadonlyArray<DishSummary>, DishServiceError, Database>;
    /**
     * Batch card projection for member-owned lists (e.g. saved dishes): one
     * round of batched queries for up to 50 ids, published dishes only, in
     * request order. Unknown, malformed, or unpublished ids are skipped —
     * the caller renders an explicit unavailable row for them instead of
     * inventing content.
     */
    readonly getDishSummaries: (
      ids: ReadonlyArray<string>,
      locale: string,
    ) => Effect.Effect<ReadonlyArray<DishSummary>, DishServiceError, Database>;
  }
>()("feastjourney/food-discovery/DishService") {}

/**
 * Precise-location candidate selection for recommendations: dishes whose
 * curated place associations fall inside a bounded PostGIS geography radius
 * around the visitor. Progressive expansion starts metro-scale and stops at
 * the documented cap — sparse regions fall through to an honest empty
 * outcome instead of an unbounded worldwide scan.
 *
 * No spatial index backs this: places carry display latitude/longitude
 * columns (no geometry column, and adding one is a migration outside this
 * change), so each attempt is a sequential scan with an ST_DWithin
 * geography predicate. The places table holds hundreds of rows, which keeps
 * this cheaper than a second round-trip; revisit if it grows past easy
 * sequential-scan size.
 */
export const NEARBY_START_M = 50_000;

export const NEARBY_MAX_M = 500_000;

const NEARBY_GROWTH_FACTOR = 4;

/** Bounded expansion schedule: 50 km, 200 km, then the 500 km cap. */
export const nearbyRadiiM = (): ReadonlyArray<number> => {
  const radii: Array<number> = [NEARBY_START_M];
  let radius = NEARBY_START_M;

  while (radius < NEARBY_MAX_M) {
    radius = Math.min(radius * NEARBY_GROWTH_FACTOR, NEARBY_MAX_M);
    radii.push(radius);
  }

  return radii;
};

export type NearbyRecommendationCandidateRow =
  (typeof dishRecommendationCandidatesNearby)["~reylo"]["element"];

export interface NearbyCandidateInput {
  readonly latitude: number;
  readonly longitude: number;
  readonly cuisine: string | null;
  readonly excludedIds: ReadonlyArray<bigint>;
  readonly locale: string;
  readonly meal: string;
  readonly limit: number;
}

export interface NearbyCandidates {
  readonly rows: ReadonlyArray<NearbyRecommendationCandidateRow>;
  /** Largest radius attempted, meters — the documented bound actually searched. */
  readonly searchedM: number;
}

/**
 * Bounded progressive candidate selection for precise locations: dishes
 * whose curated place associations fall inside a PostGIS geography radius
 * around the visitor. Metro first, then regional, then the documented cap;
 * the first non-empty radius wins and an empty cap resolves to no rows, so
 * sparse regions fall through to an honest empty outcome instead of a silent
 * worldwide scan. Coordinates arrive validated (finite, range-checked) from
 * the request schema; this function only reads published dishes through
 * curated associations and never invents venues.
 */
export const findNearbyDishCandidates = (
  input: NearbyCandidateInput,
): Effect.Effect<NearbyCandidates, DatabaseError, Database> =>
  Effect.gen(function* () {
    let searchedM = NEARBY_MAX_M;

    for (const radiusM of nearbyRadiiM()) {
      searchedM = radiusM;

      const rows = yield* runQuery("dish/recommendation-candidates-nearby", (sql) =>
        dishRecommendationCandidatesNearby.run(sql, {
          cuisine: input.cuisine,
          excluded_ids: [...input.excludedIds],
          latitude: input.latitude,
          limit: input.limit,
          locale: input.locale,
          longitude: input.longitude,
          meal: input.meal,
          radius_m: radiusM,
        }),
      );

      if (rows.length > 0) {
        return { rows, searchedM };
      }
    }

    return { rows: [], searchedM };
  });

const toSummaries = (
  records: ReadonlyMap<string, DishRecord>,
  orderedIds: ReadonlyArray<bigint>,
  summaryRelations: {
    readonly namesByDish: ReadonlyMap<string, Array<DishNameRow>>;
    readonly placesByDish: ReadonlyMap<string, Array<DishPlaceRow>>;
    readonly placeNamesByPlace: ReadonlyMap<string, Array<PlaceNameRow>>;
    readonly categorySlugsByDish: ReadonlyMap<string, Array<string>>;
  },
  locale: string,
): Array<DishSummary> => {
  const items: Array<DishSummary> = [];

  for (const id of orderedIds) {
    const key = id.toString();
    const record = records.get(key);

    if (record === undefined) {
      continue;
    }

    const names = summaryRelations.namesByDish.get(key) ?? [];
    const display = displayNameOf(names, locale);
    const dishPlaces = summaryRelations.placesByDish.get(key) ?? [];
    const regionNames: Array<string> = [];

    for (const place of dishPlaces) {
      const labels = summaryRelations.placeNamesByPlace.get(place.place_id.toString()) ?? [];
      const picked = pickDisplayName(labels.map(asLocalizedName), locale);

      if (picked !== undefined && !regionNames.includes(picked.name)) {
        regionNames.push(picked.name);
      }
    }

    items.push({
      id: encodeDbId(record.id),
      slug: record.slug,
      name: display.name,
      englishName: englishNameOf(names),
      regionNames,
      categorySlugs: summaryRelations.categorySlugsByDish.get(key) ?? [],
      updatedAt: record.updatedAt,
      lastUpdate: unixSeconds(record.updatedAt),
    });
  }

  return items;
};

export const DishServiceLive = Layer.effect(
  DishService,
  Effect.gen(function* () {
    const dishes = yield* DishRepository;
    const relations = yield* DishRelationsRepository;
    const ingredients = yield* IngredientRepository;
    const places = yield* PlaceRepository;
    const taxonomy = yield* TaxonomyRepository;

    const fetchSummaryRelations = (
      ids: ReadonlyArray<bigint>,
    ): Effect.Effect<
      {
        readonly namesByDish: ReadonlyMap<string, Array<DishNameRow>>;
        readonly placesByDish: ReadonlyMap<string, Array<DishPlaceRow>>;
        readonly placeNamesByPlace: ReadonlyMap<string, Array<PlaceNameRow>>;
        readonly categorySlugsByDish: ReadonlyMap<string, Array<string>>;
      },
      DatabaseError,
      Database
    > =>
      Effect.gen(function* () {
        if (ids.length === 0) {
          const empty = new Map<string, Array<never>>();

          return {
            namesByDish: empty,
            placesByDish: empty,
            placeNamesByPlace: empty,
            categorySlugsByDish: new Map<string, Array<string>>(),
          };
        }

        const [names, dishPlaces, categories] = yield* Effect.all(
          [
            relations.namesByDishIds(ids),
            relations.placesByDishIds(ids),
            relations.categoriesByDishIds(ids),
          ],
          { concurrency: 3 },
        );

        const placeIds = [...new Set(dishPlaces.map((entry) => entry.place_id))];

        const placeNames = placeIds.length === 0 ? [] : yield* places.namesByPlaceIds(placeIds);

        const slugsByDish = new Map<string, Array<string>>();

        for (const entry of categories) {
          const key = entry.dish_id.toString();
          const existing = slugsByDish.get(key);

          if (existing === undefined) {
            slugsByDish.set(key, [entry.slug]);
          } else if (!existing.includes(entry.slug)) {
            existing.push(entry.slug);
          }
        }

        return {
          namesByDish: groupByDish(names, (row) => row.dish_id),
          placesByDish: groupByDish(dishPlaces, (row) => row.dish_id),
          placeNamesByPlace: groupByDish(placeNames, (row) => row.place_id),
          categorySlugsByDish: slugsByDish,
        };
      });

    const recordsByIds = (
      ids: ReadonlyArray<bigint>,
    ): Effect.Effect<ReadonlyMap<string, DishRecord>, DatabaseError, Database> =>
      Effect.gen(function* () {
        const records = new Map<string, DishRecord>();

        if (ids.length === 0) {
          return records;
        }

        const rows = yield* dishes.recordsByIds(ids);

        for (const row of rows) {
          records.set(row.id.toString(), row);
        }

        return records;
      });

    const resolveRecord = (idOrSlug: string) =>
      Effect.gen(function* () {
        if (isDbIdString(idOrSlug)) {
          const record = yield* dishes.findById(BigInt(idOrSlug));

          if (record === null || record.status !== "published") {
            return yield* new DishNotFound({ dishId: idOrSlug });
          }

          return record;
        }

        if (!isSlug(idOrSlug)) {
          return yield* new DishNotFound({ dishId: idOrSlug });
        }

        const record = yield* dishes.findBySlug(idOrSlug);

        if (record === null || record.status !== "published") {
          return yield* new DishNotFound({ dishId: idOrSlug });
        }

        return record;
      });

    const resolveAnyRecord = (idOrSlug: string) =>
      Effect.gen(function* () {
        if (isDbIdString(idOrSlug)) {
          const record = yield* dishes.findById(BigInt(idOrSlug));

          if (record === null) {
            return yield* new DishNotFound({ dishId: idOrSlug });
          }

          return record;
        }

        if (!isSlug(idOrSlug)) {
          return yield* new DishNotFound({ dishId: idOrSlug });
        }

        const record = yield* dishes.findBySlug(idOrSlug);

        if (record === null) {
          return yield* new DishNotFound({ dishId: idOrSlug });
        }

        return record;
      });

    const getDish = (
      idOrSlug: string,
      locale: string,
    ): Effect.Effect<DishProfile, DishServiceError, Database> =>
      Effect.gen(function* () {
        const checkedLocale = yield* checkLocale(locale);
        const record = yield* resolveRecord(idOrSlug);

        return yield* assembleProfile(record, checkedLocale, true);
      });

    const getDishForCuration = (
      idOrSlug: string,
      locale: string,
    ): Effect.Effect<DishProfile, DishServiceError, Database> =>
      Effect.gen(function* () {
        const checkedLocale = yield* checkLocale(locale);
        const record = yield* resolveAnyRecord(idOrSlug);

        return yield* assembleProfile(record, checkedLocale, false);
      });

    const assembleProfile = (
      record: DishRecord,
      checkedLocale: string,
      parentPublishedOnly: boolean,
    ): Effect.Effect<DishProfile, DishServiceError, Database> =>
      Effect.gen(function* () {
        const dishId = record.id;

        const [names, descriptions, dishIngredients, dishPlaces, categories, cuisines, sources] =
          yield* Effect.all(
            [
              relations.namesByDishIds([dishId]),
              relations.descriptionsByDishIds([dishId]),
              relations.ingredientsByDishIds([dishId]),
              relations.placesByDishIds([dishId]),
              relations.categoriesByDishIds([dishId]),
              relations.cuisinesByDishIds([dishId]),
              relations.sourcesByDishIds([dishId]),
            ],
            { concurrency: 4 },
          );

        const ingredientIds = [...new Set(dishIngredients.map((entry) => entry.ingredient_id))];
        const placeIds = [...new Set(dishPlaces.map((entry) => entry.place_id))];

        const [ingredientNames, placeNames, allCategories, allCuisines] = yield* Effect.all(
          [
            ingredients.namesByIngredientIds(ingredientIds),
            places.namesByPlaceIds(placeIds),
            taxonomy.categories(),
            taxonomy.cuisines(),
          ],
          { concurrency: 4 },
        );

        const categoryNameById = new Map<string, string>();

        for (const row of allCategories) {
          if (row.language_tag === checkedLocale) {
            categoryNameById.set(row.id.toString(), row.name);
          }
        }

        for (const row of allCategories) {
          const key = row.id.toString();

          if (row.language_tag === "en" && !categoryNameById.has(key)) {
            categoryNameById.set(key, row.name);
          }
        }

        const cuisineNameById = new Map<string, string>();

        for (const row of allCuisines) {
          if (row.language_tag === checkedLocale) {
            cuisineNameById.set(row.id.toString(), row.name);
          }
        }

        for (const row of allCuisines) {
          const key = row.id.toString();

          if (row.language_tag === "en" && !cuisineNameById.has(key)) {
            cuisineNameById.set(key, row.name);
          }
        }

        const namesByIngredient = groupByDish(ingredientNames, (row) => row.ingredient_id);
        const namesByPlace = new Map<string, Array<PlaceNameRow>>();

        for (const name of placeNames) {
          const key = name.place_id.toString();
          const existing = namesByPlace.get(key);

          if (existing === undefined) {
            namesByPlace.set(key, [name]);
          } else {
            existing.push(name);
          }
        }

        const display = displayNameOf(names, checkedLocale);

        const description =
          descriptions.find((entry) => entry.language_tag === checkedLocale) ??
          descriptions.find((entry) => entry.language_tag === "en") ??
          descriptions[0];

        let parent: DishProfile["parent"] = null;

        if (record.parentDishId !== null) {
          const parentRecord = yield* dishes.findById(record.parentDishId);

          if (
            parentRecord !== null &&
            (!parentPublishedOnly || parentRecord.status === "published")
          ) {
            parent = { id: encodeDbId(parentRecord.id), slug: parentRecord.slug };
          }
        }

        const profile: DishProfile = {
          id: encodeDbId(record.id),
          slug: record.slug,
          name: display.name,
          englishName: englishNameOf(names),
          nativeNames: names
            .filter((entry) => entry.name_kind === "native")
            .map((entry) => ({ languageTag: entry.language_tag, name: entry.name })),
          description: description?.description ?? description?.summary ?? null,
          descriptionLanguage: description?.language_tag ?? null,
          status: record.status,
          parent,
          ingredients: dishIngredients.map((entry) => {
            const labels = namesByIngredient.get(entry.ingredient_id.toString()) ?? [];

            return {
              id: encodeDbId(entry.ingredient_id),
              name: pickDisplayName(labels.map(asLocalizedName), checkedLocale)?.name,
              role: entry.role,
            };
          }),
          places: dishPlaces.map((entry) => {
            const labels = namesByPlace.get(entry.place_id.toString()) ?? [];

            return {
              id: encodeDbId(entry.place_id),
              name: pickDisplayName(labels.map(asLocalizedName), checkedLocale)?.name,
              association: entry.association,
              isDisputed: entry.is_disputed,
              kind: entry.kind,
              iso3166: entry.iso3166,
              displayLatitude: entry.display_latitude,
              displayLongitude: entry.display_longitude,
            };
          }),
          cuisines: cuisines.map((entry) => ({
            id: encodeDbId(entry.cuisine_id),
            slug: entry.slug,
            name: cuisineNameById.get(entry.cuisine_id.toString()),
          })),
          categories: categories.map((entry) => ({
            id: encodeDbId(entry.category_id),
            kind: entry.kind,
            slug: entry.slug,
            name: categoryNameById.get(entry.category_id.toString()),
          })),
          sources: sources.map((entry) => ({
            recordId: encodeDbId(entry.record_id),
            provider: entry.provider,
            externalId: entry.external_id,
            canonicalUrl: entry.canonical_url,
            license: entry.license,
            attribution: entry.attribution,
          })),
          lastUpdate: unixSeconds(record.updatedAt),
        };

        return profile;
      });

    const resolvePlaceFilter = (
      country: string | undefined,
      region: string | undefined,
      placeId: string | undefined,
    ): Effect.Effect<ReadonlyArray<bigint> | null, DishServiceError, Database> =>
      Effect.gen(function* () {
        if (country !== undefined) {
          if (!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(country)) {
            return yield* new InvalidSearchFilter({ reason: "country must be an ISO 3166 code" });
          }

          const place = yield* places.findByIso(country);

          if (place === null) {
            return yield* new PlaceNotFound({ placeId: country });
          }

          return yield* places.descendantIds(place.id);
        }

        if (region !== undefined) {
          if (!isDbIdString(region)) {
            return yield* new InvalidSearchFilter({ reason: "region must be a decimal id" });
          }

          const place = yield* places.findById(BigInt(region));

          if (place === null) {
            return yield* new PlaceNotFound({ placeId: region });
          }

          return yield* places.descendantIds(place.id);
        }

        if (placeId !== undefined) {
          if (!isDbIdString(placeId)) {
            return yield* new InvalidSearchFilter({ reason: "place must be a decimal id" });
          }

          const place = yield* places.findById(BigInt(placeId));

          if (place === null) {
            return yield* new PlaceNotFound({ placeId });
          }

          return yield* places.descendantIds(place.id);
        }

        return null;
      });

    const searchDishes = (
      input: SearchDishesInput,
    ): Effect.Effect<SearchDishesOutput, DishServiceError, Database> =>
      Effect.gen(function* () {
        const locale = yield* checkLocale(input.locale ?? "en");
        const limit = clampLimit(input.limit, DEFAULT_LIMIT);

        const ingredientIds = (input.ingredientIds ?? []).filter((value) => isDbIdString(value));

        if (
          input.ingredientIds !== undefined &&
          ingredientIds.length !== input.ingredientIds.length
        ) {
          return yield* new InvalidSearchFilter({
            reason: "ingredient ids must be decimal id strings",
          });
        }

        if (
          input.ingredientMode !== undefined &&
          input.ingredientMode !== "any" &&
          input.ingredientMode !== "all"
        ) {
          return yield* new InvalidSearchFilter({
            reason: "ingredient_mode must be any or all",
          });
        }

        if (
          input.categoryMode !== undefined &&
          input.categoryMode !== "any" &&
          input.categoryMode !== "all"
        ) {
          return yield* new InvalidSearchFilter({
            reason: "category_mode must be any or all",
          });
        }

        if (
          input.association !== undefined &&
          input.association !== "origin" &&
          input.association !== "associated" &&
          input.association !== "popular"
        ) {
          return yield* new InvalidSearchFilter({
            reason: "association must be origin, associated or popular",
          });
        }

        if (input.sort !== undefined && input.sort !== "relevance" && input.sort !== "recent") {
          return yield* new InvalidSearchFilter({ reason: "sort must be relevance or recent" });
        }

        const trimmedQuery = input.q?.trim() ?? "";

        if (trimmedQuery.length > 0) {
          if (!isSearchableQuery(trimmedQuery)) {
            return yield* new InvalidSearchFilter({ reason: "q is too long" });
          }

          const key = normalizeSearchKey(trimmedQuery);

          if (key.length === 0) {
            return yield* new InvalidSearchFilter({ reason: "q has no searchable text" });
          }

          if (input.sort === "recent") {
            const cursor = decodeBrowseCursor(input.cursor);

            if (input.cursor !== undefined && cursor === null) {
              return yield* new InvalidSearchFilter({ reason: "cursor is invalid" });
            }

            const ids = yield* dishes.searchRecentIds({
              q: key,
              prefix: toPrefixKey(key),
              contains: toContainsKey(key),
              status: "published",
              updated: cursor?.updated ?? FAR_FUTURE,
              cursor: BigInt(cursor?.id ?? "0"),
              limit: limit + 1,
            });

            const page = ids.slice(0, limit);
            const records = yield* recordsByIds(page);
            const summaryRelations = yield* fetchSummaryRelations(page);
            const items = toSummaries(records, page, summaryRelations, locale);

            const lastId = page.length > 0 ? page[page.length - 1] : undefined;
            const lastRecord = lastId === undefined ? undefined : records.get(lastId.toString());

            const nextCursor =
              ids.length > limit && lastRecord !== undefined
                ? encodeCursor({ updated: lastRecord.updatedAt, id: lastRecord.id.toString() })
                : null;

            return { items, nextCursor };
          }

          const cursor = decodeSearchCursor(input.cursor);

          if (input.cursor !== undefined && cursor === null) {
            return yield* new InvalidSearchFilter({ reason: "cursor is invalid" });
          }

          const rows = yield* dishes.searchIds({
            q: key,
            prefix: toPrefixKey(key),
            contains: toContainsKey(key),
            status: "published",
            tier: cursor?.tier ?? -1,
            cursor: BigInt(cursor?.id ?? "0"),
            limit: limit + 1,
          });

          const page = rows.slice(0, limit);
          const ids = page.map((row) => row.id);
          const records = yield* recordsByIds(ids);
          const summaryRelations = yield* fetchSummaryRelations(ids);
          const items = toSummaries(records, ids, summaryRelations, locale);
          const last = page[page.length - 1];

          const nextCursor =
            rows.length > limit && last !== undefined
              ? encodeCursor({ tier: last.tier, id: last.id.toString() })
              : null;

          return { items, nextCursor };
        }

        const categorySlugs = input.categorySlugs ?? [];

        const categoryRows =
          categorySlugs.length === 0 ? [] : yield* taxonomy.categoriesBySlugs(categorySlugs);

        if (categoryRows.length !== categorySlugs.length) {
          return yield* new InvalidSearchFilter({ reason: "unknown category slug" });
        }

        const placeIds = yield* resolvePlaceFilter(input.country, input.region, input.placeId);

        const hasFilters =
          ingredientIds.length > 0 ||
          categoryRows.length > 0 ||
          (placeIds !== null && placeIds.length > 0) ||
          input.cuisine !== undefined;

        if (input.cuisine !== undefined) {
          const cuisine = yield* taxonomy.cuisineBySlug(input.cuisine);

          if (cuisine === null) {
            return yield* new InvalidSearchFilter({ reason: "unknown cuisine slug" });
          }
        }

        if (hasFilters) {
          const cursor = decodeFilterCursor(input.cursor);

          if (input.cursor !== undefined && cursor === null) {
            return yield* new InvalidSearchFilter({ reason: "cursor is invalid" });
          }

          const ids = yield* relations.filterIds({
            ingredientIds: ingredientIds.map((value) => BigInt(value)),
            categoryIds: categoryRows.map((row) => row.id),
            placeIds: placeIds ?? [],
            ingredientMode: input.ingredientMode ?? "any",
            categoryMode: input.categoryMode ?? "any",
            cuisine: input.cuisine ?? null,
            association: input.association ?? null,
            status: "published",
            cursor: BigInt(cursor?.id ?? "0"),
            limit: limit + 1,
          });

          const page = ids.slice(0, limit);
          const records = yield* recordsByIds(page);
          const summaryRelations = yield* fetchSummaryRelations(page);
          const items = toSummaries(records, page, summaryRelations, locale);
          const last = page[page.length - 1];

          const nextCursor =
            ids.length > limit && last !== undefined ? encodeCursor({ id: last.toString() }) : null;

          return { items, nextCursor };
        }

        const cursor = decodeBrowseCursor(input.cursor);

        if (input.cursor !== undefined && cursor === null) {
          return yield* new InvalidSearchFilter({ reason: "cursor is invalid" });
        }

        const ids = yield* dishes.browseIds({
          status: "published",
          updated: cursor?.updated ?? FAR_FUTURE,
          cursor: BigInt(cursor?.id ?? "0"),
          limit: limit + 1,
        });

        const page = ids.slice(0, limit);
        const records = yield* recordsByIds(page);
        const summaryRelations = yield* fetchSummaryRelations(page);
        const items = toSummaries(records, page, summaryRelations, locale);

        const lastId = page.length > 0 ? page[page.length - 1] : undefined;
        const lastRecord = lastId === undefined ? undefined : records.get(lastId.toString());

        const nextCursor =
          ids.length > limit && lastRecord !== undefined
            ? encodeCursor({ updated: lastRecord.updatedAt, id: lastRecord.id.toString() })
            : null;

        return { items, nextCursor };
      });

    const getLocalCarousel = (
      input: LocalCarouselInput,
    ): Effect.Effect<LocalCarouselOutput, DishServiceError, Database> =>
      Effect.gen(function* () {
        const locale = yield* checkLocale(input.locale ?? "en");
        const limit = clampLimit(input.limit, 5);
        const seed = input.seed ?? 0;
        const scope = yield* resolveCarouselScope(input);

        if (scope === null) {
          // Legacy no-scope call: honest empty labeled worldwide, no query
          // runs. The wire schema requires exactly one scope; this path stays
          // for existing service-level callers.
          return {
            fallback: false,
            items: [],
            requestedScope: "worldwide",
            scope: "worldwide",
            supplemented: false,
          };
        }

        const requestedScope = carouselScopeName(scope);

        const selectCountry = (
          country: string,
          fetchLimit: number = limit,
        ): Effect.Effect<ReadonlyArray<bigint>, DishServiceError, Database> =>
          Effect.gen(function* () {
            if (!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(country)) {
              return yield* new InvalidSearchFilter({
                reason: "country must be an ISO 3166 code",
              });
            }

            const place = yield* places.findByIso(country);

            if (place === null) {
              return yield* new PlaceNotFound({ placeId: country });
            }

            const rows = yield* runQuery("dish/carousel-country", (sql) =>
              dishCarouselCountry.run(sql, {
                limit: fetchLimit,
                place_id: place.id,
                seed,
              }),
            );

            return rows.map((row) => row.id);
          });

        // Canonical city selection: the place subtree through the same
        // seeded rotation as countries. An unknown place id is not a request
        // failure (the city was the requested scope), so it resolves to an
        // empty pool and the chain continues to the ancestor country, then
        // worldwide. Real database failures still propagate as typed failures.
        const runCityIds = (
          placeId: string,
          fetchLimit: number = limit,
        ): Effect.Effect<ReadonlyArray<bigint>, DishServiceError, Database> =>
          Effect.gen(function* () {
            const found = yield* places.findById(BigInt(placeId));

            if (found === null) {
              return [];
            }

            const rows = yield* runQuery("dish/carousel-city", (sql) =>
              dishCarouselCountry.run(sql, {
                limit: fetchLimit,
                place_id: found.id,
                seed,
              }),
            );

            return rows.map((row) => row.id);
          });

        const runWorldwideIds = (): Effect.Effect<Array<bigint>, DatabaseError, Database> =>
          Effect.gen(function* () {
            const rows = yield* runQuery("dish/carousel-worldwide", (sql) =>
              dishCarouselWorldwide.run(sql, { limit, seed }),
            );

            return rows.map((row) => row.id);
          });

        const runNearbyIds = (
          latitude: number,
          longitude: number,
        ): Effect.Effect<Array<bigint>, DatabaseError, Database> =>
          Effect.gen(function* () {
            // Bounded progressive selection over locality-kind places only:
            // metro first, then regional, then the documented cap. The first
            // non-empty band wins at any size — sparse nearby dishes (one or
            // two) are served, never hidden — and an empty cap resolves to no
            // rows for the fallback below, never a silent worldwide scan or a
            // full-table pass over every catalog coordinate.
            for (const radiusM of nearbyRadiiM()) {
              const rows = yield* runQuery("dish/carousel-nearby", (sql) =>
                dishCarouselNearby.run(sql, {
                  latitude,
                  limit,
                  longitude,
                  radius_m: radiusM,
                  seed,
                }),
              );

              if (rows.length > 0) {
                return rows.map((row) => row.id);
              }
            }

            const empty: Array<bigint> = [];

            return empty;
          });

        // Country-hint resolution for the nearby fallback: an unknown hint is
        // not a request failure (coordinates were the requested scope), so it
        // resolves to an empty pool and the chain continues to worldwide.
        // Real database failures still propagate as typed failures.
        const runCountryHintIds = (
          country: string,
          fetchLimit: number = limit,
        ): Effect.Effect<ReadonlyArray<bigint>, DishServiceError, Database> =>
          Effect.catchTag(selectCountry(country, fetchLimit), "PlaceNotFound", () =>
            Effect.succeed<ReadonlyArray<bigint>>([]),
          );

        // One coherent fallback chain: city (+ ancestor country top-up when
        // sparse) -> ancestor country -> honest empty; nearby (+ country
        // top-up when sparse) -> country -> honest empty; country -> honest
        // empty; worldwide runs direct with zero constraints. Scoped requests
        // never widen to the worldwide pool: an empty city/country pool is an
        // honest empty with an explicit worldwide escape hatch in the client,
        // never silent unrelated dishes. Empty pools fall through; only real
        // database failures reject.
        const selection: CarouselSelection = yield* CarouselScope.$match(scope, {
          Country: ({ country }) =>
            Effect.gen(function* () {
              const countryIds = yield* selectCountry(country);

              if (countryIds.length > 0) {
                const served: CarouselSelection = {
                  fallbackReason: null,
                  ids: countryIds,
                  servedScope: "country",
                  supplemented: false,
                };

                return served;
              }

              const countryEmpty: CarouselSelection = {
                fallbackReason: "country-empty",
                ids: [],
                servedScope: "country",
                supplemented: false,
              };

              return countryEmpty;
            }),
          City: ({ placeId }) =>
            Effect.gen(function* () {
              const cityIds = yield* runCityIds(placeId);

              // Nearest country-kind ancestor carrying a verified ISO code:
              // the honest wider pool when the city subtree is sparse or
              // empty. Walks the canonical parent chain, never invents
              // geography. Prefers the country ("IN") over subnational
              // codes ("IN-KA") so fallbacks and labels name the country.
              const chain = yield* places.ancestors(BigInt(placeId));

              let ancestorCountry: string | null = null;
              let nearestIso: string | null = null;

              for (const entry of chain) {
                if (entry.iso3166 !== null && /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(entry.iso3166)) {
                  if (nearestIso === null) {
                    nearestIso = entry.iso3166;
                  }

                  if (entry.kind === "country") {
                    ancestorCountry = entry.iso3166;
                    break;
                  }
                }
              }

              if (ancestorCountry === null) {
                ancestorCountry = nearestIso;
              }

              if (cityIds.length > 0) {
                // Sparse city pool: keep the eligible city dishes first, then
                // top up with distinct dishes from the ancestor country. The
                // client labels this regional with the ancestor country named
                // (supplemented pools read as regional), never as broader
                // coverage than it is.
                if (cityIds.length < limit) {
                  const seen = new Set(cityIds.map((id) => id.toString()));

                  const extra =
                    ancestorCountry === null
                      ? []
                      : (yield* runCountryHintIds(ancestorCountry, limit + cityIds.length)).filter(
                          (id) => !seen.has(id.toString()),
                        );

                  if (extra.length > 0) {
                    const supplemented: CarouselSelection = {
                      fallbackReason: null,
                      ids: [...cityIds, ...extra.slice(0, limit - cityIds.length)],
                      servedScope: "city",
                      supplemented: true,
                    };

                    return supplemented;
                  }
                }

                const served: CarouselSelection = {
                  fallbackReason: null,
                  ids: cityIds,
                  servedScope: "city",
                  supplemented: false,
                };

                return served;
              }

              if (ancestorCountry !== null) {
                const countryIds = yield* runCountryHintIds(ancestorCountry);

                if (countryIds.length > 0) {
                  const countryFallback: CarouselSelection = {
                    fallbackReason: "city-empty",
                    ids: countryIds,
                    servedScope: "country",
                    supplemented: false,
                  };

                  return countryFallback;
                }

                const countryEmpty: CarouselSelection = {
                  fallbackReason: "city-empty-country-empty",
                  ids: [],
                  servedScope: "country",
                  supplemented: false,
                };

                return countryEmpty;
              }

              const noAncestorEmpty: CarouselSelection = {
                fallbackReason: "city-empty",
                ids: [],
                servedScope: "city",
                supplemented: false,
              };

              return noAncestorEmpty;
            }),
          Nearby: ({ country, latitude, longitude }) =>
            Effect.gen(function* () {
              const nearbyIds = yield* runNearbyIds(latitude, longitude);

              if (nearbyIds.length > 0) {
                // Sparse locality pool: keep the eligible nearby dishes
                // first, then top up with distinct country-associated
                // dishes to the requested limit. No duplicates; geographic
                // relevance keeps its order (never a bare "no dishes"
                // panel just because the radius held few matches).
                if (nearbyIds.length < limit && country !== null) {
                  const countryIds = yield* runCountryHintIds(country, limit + nearbyIds.length);

                  const seen = new Set(nearbyIds.map((id) => id.toString()));

                  const extra = countryIds
                    .filter((id) => !seen.has(id.toString()))
                    .slice(0, limit - nearbyIds.length);

                  if (extra.length > 0) {
                    const supplemented: CarouselSelection = {
                      fallbackReason: null,
                      ids: [...nearbyIds, ...extra],
                      servedScope: "nearby",
                      supplemented: true,
                    };

                    return supplemented;
                  }
                }

                const served: CarouselSelection = {
                  fallbackReason: null,
                  ids: nearbyIds,
                  servedScope: "nearby",
                  supplemented: false,
                };

                return served;
              }

              if (country !== null) {
                const countryIds = yield* runCountryHintIds(country);

                if (countryIds.length > 0) {
                  const countryFallback: CarouselSelection = {
                    fallbackReason: "nearby-empty",
                    ids: countryIds,
                    servedScope: "country",
                    supplemented: false,
                  };

                  return countryFallback;
                }

                const countryEmpty: CarouselSelection = {
                  fallbackReason: "nearby-empty-country-empty",
                  ids: [],
                  servedScope: "country",
                  supplemented: false,
                };

                return countryEmpty;
              }

              const nearbyEmpty: CarouselSelection = {
                fallbackReason: "nearby-empty",
                ids: [],
                servedScope: "nearby",
                supplemented: false,
              };

              return nearbyEmpty;
            }),
          Worldwide: () =>
            Effect.gen(function* () {
              const worldwideIds = yield* runWorldwideIds();

              const served: CarouselSelection = {
                fallbackReason: null,
                ids: worldwideIds,
                servedScope: "worldwide",
                supplemented: false,
              };

              return served;
            }),
        });

        const ordered: Array<bigint> = [...selection.ids];

        if (ordered.length === 0) {
          if (selection.fallbackReason === null) {
            return {
              fallback: false,
              items: [],
              requestedScope,
              scope: selection.servedScope,
              supplemented: false,
            };
          }

          return {
            fallback: true,
            fallbackReason: selection.fallbackReason,
            items: [],
            requestedScope,
            scope: selection.servedScope,
            supplemented: false,
          };
        }

        const records = yield* recordsByIds(ordered);
        const summaryRelations = yield* fetchSummaryRelations(ordered);

        const namesById = groupByDish(
          yield* relations.namesByDishIds(ordered),
          (row) => row.dish_id,
        );

        const dishDescriptions = groupByDish(
          yield* relations.descriptionsByDishIds(ordered),
          (row) => row.dish_id,
        );

        const dishIngredients = groupByDish(
          yield* relations.ingredientsByDishIds(ordered),
          (row) => row.dish_id,
        );

        const mediaById = groupByDish<DishPublishedMediaRow>(
          yield* relations.publishedMediaByDishIds(ordered),
          (row) => BigInt(row.dish_id),
        );

        const ingredientIds = [
          ...new Set(
            [...dishIngredients.values()].flatMap((rows) => rows.map((row) => row.ingredient_id)),
          ),
        ];

        const namesByIngredient = groupByDish(
          yield* ingredients.namesByIngredientIds(ingredientIds),
          (row) => row.ingredient_id,
        );

        const items: Array<CarouselCard> = [];

        for (const id of ordered) {
          const key = id.toString();
          const record = records.get(key);

          if (record === undefined) {
            continue;
          }

          const names = namesById.get(key) ?? [];
          const display = displayNameOf(names, locale);

          const native = names.find((entry) => entry.name_kind === "native");

          const descriptionRows = dishDescriptions.get(key) ?? [];

          const description =
            descriptionRows.find((entry) => entry.language_tag === locale) ??
            descriptionRows.find((entry) => entry.language_tag === "en") ??
            descriptionRows[0];

          const ingredientRows = (dishIngredients.get(key) ?? []).slice(0, 6);
          const dishPlaces = summaryRelations.placesByDish.get(key) ?? [];
          const regionNames: Array<string> = [];

          for (const place of dishPlaces) {
            const labels = summaryRelations.placeNamesByPlace.get(place.place_id.toString()) ?? [];
            const picked = pickDisplayName(labels.map(asLocalizedName), locale);

            if (picked !== undefined && !regionNames.includes(picked.name)) {
              regionNames.push(picked.name);
            }
          }

          // Primary = first by sort_order (repository ORDER BY). Only
          // published + ready rows with generated delivery URLs or legacy
          // external files project; anything else renders the card
          // placeholder instead of an invented photo.
          const mediaRow = (mediaById.get(key) ?? [])[0];
          const projected = mediaRow === undefined ? null : toPublishedImage(mediaRow);

          const image =
            projected === null
              ? null
              : { ...projected, alt: projected.alt ?? display.name ?? record.slug };

          items.push({
            description: description?.description ?? description?.summary ?? null,
            descriptionLanguage: description?.language_tag ?? null,
            englishName: englishNameOf(names),
            id: record.id.toString(),
            image,
            ingredients: ingredientRows.map((entry) => {
              const labels = namesByIngredient.get(entry.ingredient_id.toString()) ?? [];

              return {
                name: pickDisplayName(labels.map(asLocalizedName), locale)?.name,
                role: entry.role,
              };
            }),
            name: display.name,
            nativeLanguageTag:
              native !== undefined && native.name !== display.name
                ? native.language_tag
                : undefined,
            nativeName:
              native !== undefined && native.name !== display.name ? native.name : undefined,
            regionNames,
            slug: record.slug,
          });
        }

        if (selection.fallbackReason === null) {
          return {
            fallback: false,
            items,
            requestedScope,
            scope: selection.servedScope,
            supplemented: selection.supplemented,
          };
        }

        return {
          fallback: true,
          fallbackReason: selection.fallbackReason,
          items,
          requestedScope,
          scope: selection.servedScope,
          supplemented: selection.supplemented,
        };
      });

    const getRelated = (
      idOrSlug: string,
      locale: string,
      limit: number | undefined,
    ): Effect.Effect<ReadonlyArray<DishSummary>, DishServiceError, Database> =>
      Effect.gen(function* () {
        const checkedLocale = yield* checkLocale(locale);
        const record = yield* resolveRecord(idOrSlug);
        const rows = yield* dishes.relatedIds(record.id, "published", clampLimit(limit, 8));
        const ids = rows.map((row) => row.id);
        const records = yield* recordsByIds(ids);
        const summaryRelations = yield* fetchSummaryRelations(ids);

        return toSummaries(records, ids, summaryRelations, checkedLocale);
      });

    const getDishSummaries = (
      ids: ReadonlyArray<string>,
      locale: string,
    ): Effect.Effect<ReadonlyArray<DishSummary>, DishServiceError, Database> =>
      Effect.gen(function* () {
        const checkedLocale = yield* checkLocale(locale);

        const numericIds: Array<bigint> = [];

        for (const id of ids.slice(0, 50)) {
          if (isDbIdString(id)) {
            numericIds.push(BigInt(id));
          }
        }

        const records = yield* recordsByIds(numericIds);

        const orderedIds: Array<bigint> = [];

        for (const id of numericIds) {
          const record = records.get(id.toString());

          if (record !== undefined && record.status === "published" && !orderedIds.includes(id)) {
            orderedIds.push(id);
          }
        }

        const summaryRelations = yield* fetchSummaryRelations(orderedIds);

        return toSummaries(records, orderedIds, summaryRelations, checkedLocale);
      });

    return DishService.of({
      getDish,
      getDishForCuration,
      searchDishes,
      getLocalCarousel,
      getRelated,
      getDishSummaries,
    });
  }),
);
