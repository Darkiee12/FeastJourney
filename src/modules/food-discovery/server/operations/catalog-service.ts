import { Context, Effect, Layer } from "effect";

import {
  IngredientNotFound,
  InvalidLocale,
  InvalidSearchFilter,
  PlaceNotFound,
} from "@/modules/food-discovery/server/domain/errors";
import {
  encodeDbId,
  isDbIdString,
  isLanguageTag,
} from "@/modules/food-discovery/server/domain/ids";
import {
  asLocalizedName,
  isSearchableQuery,
  normalizeSearchKey,
  pickDisplayName,
  toContainsKey,
  toPrefixKey,
} from "@/modules/food-discovery/server/domain/search";
import { IngredientRepository } from "@/modules/food-discovery/server/repository/ingredient-repository";
import { PlaceRepository } from "@/modules/food-discovery/server/repository/place-repository";
import type { PlaceRow } from "@/modules/food-discovery/server/repository/place-repository";
import { TaxonomyRepository } from "@/modules/food-discovery/server/repository/taxonomy-repository";
import type { Database } from "@/server/database/client";
import type {
  DatabaseUnavailable,
  PersistenceConflict,
  PersistenceError,
  TransactionConflict,
} from "@/server/database/errors";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_COUNTRY_LIMIT = 300;

const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || Number.isNaN(limit)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
};

const clampCountryLimit = (limit: number | undefined): number => {
  if (limit === undefined || Number.isNaN(limit)) {
    return MAX_COUNTRY_LIMIT;
  }

  return Math.min(Math.max(Math.floor(limit), 1), MAX_COUNTRY_LIMIT);
};

const checkLocale = (locale: string): Effect.Effect<string, InvalidLocale> =>
  isLanguageTag(locale) ? Effect.succeed(locale) : Effect.fail(new InvalidLocale({ locale }));

export type CatalogServiceError =
  | IngredientNotFound
  | InvalidLocale
  | InvalidSearchFilter
  | PlaceNotFound
  | DatabaseUnavailable
  | PersistenceError
  | PersistenceConflict
  | TransactionConflict;

export interface IngredientSummary {
  readonly id: string;
  readonly displayName: string | undefined;
  readonly displayLanguage: string | undefined;
}

export interface IngredientDetail extends IngredientSummary {
  readonly names: ReadonlyArray<{
    readonly languageTag: string;
    readonly name: string;
    readonly nameKind: string;
    readonly isPreferred: boolean;
  }>;
}

export interface PlaceSummary {
  readonly id: string;
  readonly kind: string;
  readonly iso3166: string | null;
  readonly displayName: string | undefined;
  readonly displayLatitude: number | null;
  readonly displayLongitude: number | null;
}

export interface CategorySummary {
  readonly id: string;
  readonly kind: string;
  readonly slug: string;
  readonly displayName: string | undefined;
}

export interface CuisineSummary {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string | undefined;
}

export interface PlaceDetail extends PlaceSummary {
  readonly names: ReadonlyArray<{
    readonly languageTag: string;
    readonly name: string;
    readonly isPreferred: boolean;
  }>;
  readonly ancestors: ReadonlyArray<PlaceSummary>;
}

/**
 * Beyond this distance a fix is honest only as "Near you": naming a city
 * hundreds of kilometers away would pose as precision the catalog cannot
 * prove. Metro areas read well inside it; ocean fixes resolve to null.
 */
const NEAREST_CITY_MAX_M = 50_000;

/**
 * One city-chooser entry: a canonical sub-country place with the
 * administrative context needed to disambiguate identical names
 * ("Bengaluru, Karnataka, India") plus the nearest country ISO used as
 * the honest wider-pool fallback. Never a free-text name: the id is the
 * canonical registry identity.
 */
export interface CitySummary {
  readonly id: string;
  readonly kind: string;
  readonly name: string | undefined;
  readonly context: string | null;
  readonly country: string | null;
}

export class CatalogService extends Context.Service<
  CatalogService,
  {
    readonly searchIngredients: (
      q: string,
      locale: string,
      limit: number | undefined,
    ) => Effect.Effect<ReadonlyArray<IngredientSummary>, CatalogServiceError, Database>;
    readonly getIngredient: (
      id: string,
      locale: string,
    ) => Effect.Effect<IngredientDetail, CatalogServiceError, Database>;
    readonly searchPlaces: (
      q: string,
      locale: string,
      limit: number | undefined,
    ) => Effect.Effect<ReadonlyArray<PlaceSummary>, CatalogServiceError, Database>;
    /**
     * City chooser search: canonical sub-country places (localities,
     * subnational areas, provinces — never countries or continents) matching
     * a name or alias query ("Bangalore" finds Bengaluru through its alias),
     * each with administrative context for disambiguation and the nearest
     * country ISO for fallback. Bounded: the query caps matches and each
     * match costs one ancestor-chain read.
     */
    readonly searchCities: (
      q: string,
      locale: string,
      limit: number | undefined,
    ) => Effect.Effect<ReadonlyArray<CitySummary>, CatalogServiceError, Database>;
    /**
     * Nearest catalog city to a coordinate pair, for the honest near-you
     * status line ("Exploring Hanoi, Vietnam" instead of a bare "Near
     * you"). Returns null when no city-scale place is close enough, and
     * the client keeps the plain scope wording. Never a free-text name:
     * the result is a canonical CitySummary or nothing.
     */
    readonly nearestCity: (
      latitude: number,
      longitude: number,
      locale: string,
    ) => Effect.Effect<CitySummary | null, CatalogServiceError, Database>;
    readonly getPlace: (
      id: string,
      locale: string,
    ) => Effect.Effect<PlaceDetail, CatalogServiceError, Database>;
    readonly listPlaces: (
      locale: string,
      limit: number | undefined,
    ) => Effect.Effect<ReadonlyArray<PlaceSummary>, CatalogServiceError, Database>;
    /**
     * Country chooser for the recommendation region step: kind-filtered at
     * the database level with verified ISO identity, so no eligible country
     * can hide behind a generic place-list limit. Deterministic id order;
     * display sorting happens client-side on localized labels.
     */
    readonly listCountries: (
      locale: string,
      limit: number | undefined,
    ) => Effect.Effect<ReadonlyArray<PlaceSummary>, CatalogServiceError, Database>;
    readonly listCategories: (
      locale: string,
    ) => Effect.Effect<ReadonlyArray<CategorySummary>, CatalogServiceError, Database>;
    readonly listCuisines: (
      locale: string,
    ) => Effect.Effect<ReadonlyArray<CuisineSummary>, CatalogServiceError, Database>;
  }
>()("feastjourney/food-discovery/CatalogService") {}

const toPlaceSummary = (
  record: {
    readonly id: bigint;
    readonly kind: string;
    readonly iso3166: string | null;
    readonly displayLatitude: number | null;
    readonly displayLongitude: number | null;
  },
  names: ReadonlyArray<{
    readonly language_tag: string;
    readonly name: string;
    readonly is_preferred: boolean;
  }>,
  locale: string,
): PlaceSummary => ({
  id: encodeDbId(record.id),
  kind: record.kind,
  iso3166: record.iso3166,
  displayName: pickDisplayName(names.map(asLocalizedName), locale)?.name,
  displayLatitude: record.displayLatitude,
  displayLongitude: record.displayLongitude,
});

export const CatalogServiceLive = Layer.effect(
  CatalogService,
  Effect.gen(function* () {
    const ingredientRepository = yield* IngredientRepository;
    const placeRepository = yield* PlaceRepository;
    const taxonomy = yield* TaxonomyRepository;

    const searchIngredients = (
      q: string,
      locale: string,
      limit: number | undefined,
    ): Effect.Effect<ReadonlyArray<IngredientSummary>, CatalogServiceError, Database> =>
      Effect.gen(function* () {
        const checkedLocale = yield* checkLocale(locale);

        if (!isSearchableQuery(q)) {
          return yield* new InvalidSearchFilter({ reason: "q must be 1-200 characters" });
        }

        const key = normalizeSearchKey(q.trim());

        if (key.length === 0) {
          return yield* new InvalidSearchFilter({ reason: "q has no searchable text" });
        }

        const rows = yield* ingredientRepository.searchIds({
          q: key,
          prefix: toPrefixKey(key),
          contains: toContainsKey(key),
          limit: clampLimit(limit),
        });

        const ids = rows.map((row) => row.id);

        if (ids.length === 0) {
          return [];
        }

        const names = yield* ingredientRepository.namesByIngredientIds(ids);
        const byIngredient = new Map<string, Array<(typeof names)[number]>>();

        for (const entry of names) {
          const keyId = entry.ingredient_id.toString();
          const existing = byIngredient.get(keyId);

          if (existing === undefined) {
            byIngredient.set(keyId, [entry]);
          } else {
            existing.push(entry);
          }
        }

        const summaries: Array<IngredientSummary> = [];

        for (const row of rows) {
          const record = yield* ingredientRepository.findById(row.id);

          if (record === null) {
            continue;
          }

          const labels = byIngredient.get(row.id.toString()) ?? [];
          const picked = pickDisplayName(labels.map(asLocalizedName), checkedLocale);
          summaries.push({
            id: encodeDbId(record.id),
            displayName: picked?.name,
            displayLanguage: picked?.languageTag,
          });
        }

        return summaries;
      });

    const getIngredient = (
      id: string,
      locale: string,
    ): Effect.Effect<IngredientDetail, CatalogServiceError, Database> =>
      Effect.gen(function* () {
        const checkedLocale = yield* checkLocale(locale);

        if (!isDbIdString(id)) {
          return yield* new IngredientNotFound({ ingredientId: id });
        }

        const record = yield* ingredientRepository.findById(BigInt(id));

        if (record === null) {
          return yield* new IngredientNotFound({ ingredientId: id });
        }

        const names = yield* ingredientRepository.namesByIngredientIds([record.id]);
        const picked = pickDisplayName(names.map(asLocalizedName), checkedLocale);

        return {
          id: encodeDbId(record.id),
          displayName: picked?.name,
          displayLanguage: picked?.languageTag,
          names: names.map((entry) => ({
            languageTag: entry.language_tag,
            name: entry.name,
            nameKind: entry.name_kind,
            isPreferred: entry.is_preferred,
          })),
        };
      });

    const searchPlaces = (
      q: string,
      locale: string,
      limit: number | undefined,
    ): Effect.Effect<ReadonlyArray<PlaceSummary>, CatalogServiceError, Database> =>
      Effect.gen(function* () {
        const checkedLocale = yield* checkLocale(locale);

        if (!isSearchableQuery(q)) {
          return yield* new InvalidSearchFilter({ reason: "q must be 1-200 characters" });
        }

        const key = normalizeSearchKey(q.trim());

        if (key.length === 0) {
          return yield* new InvalidSearchFilter({ reason: "q has no searchable text" });
        }

        const rows = yield* placeRepository.searchIds({
          q: key,
          prefix: toPrefixKey(key),
          contains: toContainsKey(key),
          limit: clampLimit(limit),
        });

        const ids = rows.map((row) => row.id);

        if (ids.length === 0) {
          return [];
        }

        const names = yield* placeRepository.namesByPlaceIds(ids);
        const byPlace = new Map<string, Array<(typeof names)[number]>>();

        for (const entry of names) {
          const keyId = entry.place_id.toString();
          const existing = byPlace.get(keyId);

          if (existing === undefined) {
            byPlace.set(keyId, [entry]);
          } else {
            existing.push(entry);
          }
        }

        const summaries: Array<PlaceSummary> = [];

        for (const row of rows) {
          const record = yield* placeRepository.findById(row.id);

          if (record === null) {
            continue;
          }

          summaries.push(
            toPlaceSummary(record, byPlace.get(row.id.toString()) ?? [], checkedLocale),
          );
        }

        return summaries;
      });

    /**
     * City chooser search over canonical sub-country places. Name and alias
     * matching reuses the place registry search (aliases like "Bangalore"
     * resolve through place_names); administrative context comes from the
     * canonical ancestor chain, never from display-name parsing.
     */
    /**
     * Shared city-summary builder behind search and nearest resolution: one
     * record plus its ancestor chain becomes the canonical entry (name,
     * disambiguating context, country hint). Returns null for non-city
     * kinds so callers never label a country or region as a city.
     */
    const resolveCitySummary = (
      record: PlaceRow,
      checkedLocale: string,
    ): Effect.Effect<CitySummary | null, CatalogServiceError, Database> =>
      Effect.gen(function* () {
        if (
          record.kind !== "locality" &&
          record.kind !== "subnational" &&
          record.kind !== "province"
        ) {
          return null;
        }

        const chain = yield* placeRepository.ancestors(record.id);

        const ancestorIds = chain
          .filter((entry) => entry.id !== record.id)
          .map((entry) => entry.id);

        const ancestorNames =
          ancestorIds.length === 0 ? [] : yield* placeRepository.namesByPlaceIds(ancestorIds);

        const byAncestor = new Map<string, Array<(typeof ancestorNames)[number]>>();

        for (const entry of ancestorNames) {
          const ancestorKey = entry.place_id.toString();
          const existing = byAncestor.get(ancestorKey);

          if (existing === undefined) {
            byAncestor.set(ancestorKey, [entry]);
          } else {
            existing.push(entry);
          }
        }

        const contextParts: Array<string> = [];
        let country: string | null = null;
        let nearestIso: string | null = null;

        // Ancestors arrive nearest-first; context reads outward
        // ("Karnataka, India") so identical city names disambiguate.
        // Regions and continents stay out of the context line — the
        // province/state plus country is the traveler's frame. The country
        // hint is the country-kind ISO (India's "IN"), never a
        // subnational code like "IN-KA", so wider-pool fallbacks and
        // labels name the country honestly.
        for (const entry of chain) {
          if (entry.id === record.id) {
            continue;
          }

          if (entry.iso3166 !== null && /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(entry.iso3166)) {
            if (nearestIso === null) {
              nearestIso = entry.iso3166;
            }

            if (country === null && entry.kind === "country") {
              country = entry.iso3166;
            }
          }

          if (
            entry.kind !== "subnational" &&
            entry.kind !== "province" &&
            entry.kind !== "country"
          ) {
            continue;
          }

          const labels = byAncestor.get(entry.id.toString()) ?? [];
          const picked = pickDisplayName(labels.map(asLocalizedName), checkedLocale);

          if (picked !== undefined && !contextParts.includes(picked.name)) {
            contextParts.push(picked.name);
          }
        }

        if (country === null) {
          country = nearestIso;
        }

        const ownNames = yield* placeRepository.namesByPlaceIds([record.id]);
        const ownPicked = pickDisplayName(ownNames.map(asLocalizedName), checkedLocale);

        return {
          id: encodeDbId(record.id),
          kind: record.kind,
          name: ownPicked?.name,
          context: contextParts.length > 0 ? contextParts.join(", ") : null,
          country,
        };
      });

    const searchCities = (
      q: string,
      locale: string,
      limit: number | undefined,
    ): Effect.Effect<ReadonlyArray<CitySummary>, CatalogServiceError, Database> =>
      Effect.gen(function* () {
        const checkedLocale = yield* checkLocale(locale);

        if (!isSearchableQuery(q)) {
          return yield* new InvalidSearchFilter({ reason: "q must be 1-200 characters" });
        }

        const key = normalizeSearchKey(q.trim());

        if (key.length === 0) {
          return yield* new InvalidSearchFilter({ reason: "q has no searchable text" });
        }

        const rows = yield* placeRepository.searchIds({
          q: key,
          prefix: toPrefixKey(key),
          contains: toContainsKey(key),
          limit: clampLimit(limit),
        });

        const cities: Array<CitySummary> = [];

        for (const row of rows) {
          if (cities.length >= 8) {
            break;
          }

          const record = yield* placeRepository.findById(row.id);

          if (record === null) {
            continue;
          }

          const city = yield* resolveCitySummary(record, checkedLocale);

          if (city === null) {
            continue;
          }

          cities.push(city);
        }

        return cities;
      });

    const nearestCity = (
      latitude: number,
      longitude: number,
      locale: string,
    ): Effect.Effect<CitySummary | null, CatalogServiceError, Database> =>
      Effect.gen(function* () {
        const checkedLocale = yield* checkLocale(locale);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return null;
        }

        const hit = yield* placeRepository.nearestCityId({
          latitude,
          longitude,
          maxDistanceM: NEAREST_CITY_MAX_M,
        });

        if (hit === null) {
          return null;
        }

        const record = yield* placeRepository.findById(hit.id);

        if (record === null) {
          return null;
        }

        return yield* resolveCitySummary(record, checkedLocale);
      });

    const getPlace = (
      id: string,
      locale: string,
    ): Effect.Effect<PlaceDetail, CatalogServiceError, Database> =>
      Effect.gen(function* () {
        const checkedLocale = yield* checkLocale(locale);

        if (!isDbIdString(id)) {
          return yield* new PlaceNotFound({ placeId: id });
        }

        const record = yield* placeRepository.findById(BigInt(id));

        if (record === null) {
          return yield* new PlaceNotFound({ placeId: id });
        }

        const names = yield* placeRepository.namesByPlaceIds([record.id]);

        return {
          ...toPlaceSummary(record, names, checkedLocale),
          names: names.map((entry) => ({
            languageTag: entry.language_tag,
            name: entry.name,
            isPreferred: entry.is_preferred,
          })),
          ancestors: [],
        };
      });

    type PlaceNameLabel = {
      readonly languageTag: string;
      readonly name: string;
      readonly isPreferred: boolean;
    };

    type GroupedPlace = {
      readonly kind: string;
      readonly iso3166: string | null;
      readonly displayLatitude: number | null;
      readonly displayLongitude: number | null;
      readonly names: Array<PlaceNameLabel>;
    };

    const groupPlaceRows = (
      rows: ReadonlyArray<{
        readonly id: bigint;
        readonly kind: string;
        readonly iso3166: string | null;
        readonly display_latitude: number | null;
        readonly display_longitude: number | null;
        readonly language_tag: string;
        readonly name: string;
        readonly is_preferred: boolean;
      }>,
    ): ReadonlyMap<string, GroupedPlace> => {
      const byPlace = new Map<string, GroupedPlace>();

      for (const row of rows) {
        const key = row.id.toString();
        const existing = byPlace.get(key);

        const label: PlaceNameLabel = {
          languageTag: row.language_tag,
          name: row.name,
          isPreferred: row.is_preferred,
        };

        const current = existing ?? {
          kind: row.kind,
          iso3166: row.iso3166,
          displayLatitude: row.display_latitude,
          displayLongitude: row.display_longitude,
          names: [],
        };

        current.names.push(label);
        byPlace.set(key, current);
      }

      return byPlace;
    };

    const toPlaceSummaries = (
      grouped: ReadonlyMap<string, GroupedPlace>,
      checkedLocale: string,
    ): Array<PlaceSummary> =>
      [...grouped].map(([id, entry]) => ({
        id,
        kind: entry.kind,
        iso3166: entry.iso3166,
        displayName: pickDisplayName(entry.names, checkedLocale)?.name,
        displayLatitude: entry.displayLatitude,
        displayLongitude: entry.displayLongitude,
      }));

    const listPlaces = (
      locale: string,
      limit: number | undefined,
    ): Effect.Effect<ReadonlyArray<PlaceSummary>, CatalogServiceError, Database> =>
      Effect.gen(function* () {
        const checkedLocale = yield* checkLocale(locale);
        const rows = yield* placeRepository.listWithNames(clampLimit(limit));

        return toPlaceSummaries(groupPlaceRows(rows), checkedLocale);
      });

    const listCountries = (
      locale: string,
      limit: number | undefined,
    ): Effect.Effect<ReadonlyArray<PlaceSummary>, CatalogServiceError, Database> =>
      Effect.gen(function* () {
        const checkedLocale = yield* checkLocale(locale);
        const rows = yield* placeRepository.countriesWithNames(clampCountryLimit(limit));

        return toPlaceSummaries(groupPlaceRows(rows), checkedLocale);
      });

    const listCategories = (
      locale: string,
    ): Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly kind: string;
        readonly slug: string;
        readonly displayName: string | undefined;
      }>,
      CatalogServiceError,
      Database
    > =>
      Effect.gen(function* () {
        const checkedLocale = yield* checkLocale(locale);
        const rows = yield* taxonomy.categories();

        const byCategory = new Map<
          string,
          {
            readonly kind: string;
            readonly slug: string;
            readonly names: Array<{
              readonly languageTag: string;
              readonly name: string;
              readonly isPreferred: boolean;
            }>;
          }
        >();

        for (const row of rows) {
          const key = row.id.toString();
          const existing = byCategory.get(key);

          const label = {
            languageTag: row.language_tag,
            name: row.name,
            isPreferred: row.is_preferred,
          };

          if (existing === undefined) {
            byCategory.set(key, { kind: row.kind, slug: row.slug, names: [label] });
          } else {
            existing.names.push(label);
          }
        }

        return [...byCategory].map(([id, entry]) => ({
          id,
          kind: entry.kind,
          slug: entry.slug,
          displayName: pickDisplayName(entry.names, checkedLocale)?.name,
        }));
      });

    const listCuisines = (
      locale: string,
    ): Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly slug: string;
        readonly displayName: string | undefined;
      }>,
      CatalogServiceError,
      Database
    > =>
      Effect.gen(function* () {
        const checkedLocale = yield* checkLocale(locale);
        const rows = yield* taxonomy.cuisines();

        const byCuisine = new Map<
          string,
          {
            readonly slug: string;
            readonly names: Array<{
              readonly languageTag: string;
              readonly name: string;
              readonly isPreferred: boolean;
            }>;
          }
        >();

        for (const row of rows) {
          const key = row.id.toString();
          const existing = byCuisine.get(key);

          const label = {
            languageTag: row.language_tag,
            name: row.name,
            isPreferred: row.is_preferred,
          };

          if (existing === undefined) {
            byCuisine.set(key, { slug: row.slug, names: [label] });
          } else {
            existing.names.push(label);
          }
        }

        return [...byCuisine].map(([id, entry]) => ({
          id,
          slug: entry.slug,
          displayName: pickDisplayName(entry.names, checkedLocale)?.name,
        }));
      });

    return CatalogService.of({
      searchIngredients,
      getIngredient,
      searchPlaces,
      searchCities,
      nearestCity,
      getPlace,
      listPlaces,
      listCountries,
      listCategories,
      listCuisines,
    });
  }),
);
