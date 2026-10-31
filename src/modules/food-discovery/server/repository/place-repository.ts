import { Context, Effect, Layer } from "effect";

import placeCoordsAll from "@/modules/food-discovery/server/repository/sql/place-coords-all.sql";
import placeCountriesWithNames from "@/modules/food-discovery/server/repository/sql/place-countries-with-names.sql";
import placeFindAncestors from "@/modules/food-discovery/server/repository/sql/place-find-ancestors.sql";
import placeFindById from "@/modules/food-discovery/server/repository/sql/place-find-by-id.sql";
import placeFindByIso from "@/modules/food-discovery/server/repository/sql/place-find-by-iso.sql";
import placeFindDescendants from "@/modules/food-discovery/server/repository/sql/place-find-descendants.sql";
import placeFindDishIds from "@/modules/food-discovery/server/repository/sql/place-find-dish-ids.sql";
import placeListWithNames from "@/modules/food-discovery/server/repository/sql/place-list-with-names.sql";
import placeNamesByPlaceIds from "@/modules/food-discovery/server/repository/sql/place-names-by-place-ids.sql";
import placeParentsAll from "@/modules/food-discovery/server/repository/sql/place-parents-all.sql";
import placeSearch from "@/modules/food-discovery/server/repository/sql/place-search.sql";
import type { Database } from "@/server/database/client";
import { type DatabaseError, runQuery } from "@/server/database/query";

export type PlaceRow = (typeof placeFindById)["~reylo"]["element"];

export type PlaceAncestorRow = (typeof placeFindAncestors)["~reylo"]["element"];

export type PlaceNameRow = (typeof placeNamesByPlaceIds)["~reylo"]["element"];

export type PlaceListRow = (typeof placeListWithNames)["~reylo"]["element"];

export type PlaceCoordsRow = (typeof placeCoordsAll)["~reylo"]["element"];

export class PlaceRepository extends Context.Service<
  PlaceRepository,
  {
    readonly searchIds: (input: {
      readonly q: string;
      readonly prefix: string;
      readonly contains: string;
      readonly limit: number;
    }) => Effect.Effect<
      ReadonlyArray<{ readonly id: bigint; readonly tier: number }>,
      DatabaseError,
      Database
    >;
    readonly findById: (id: bigint) => Effect.Effect<PlaceRow | null, DatabaseError, Database>;
    readonly findByIso: (iso: string) => Effect.Effect<PlaceRow | null, DatabaseError, Database>;
    readonly namesByPlaceIds: (
      ids: ReadonlyArray<bigint>,
    ) => Effect.Effect<ReadonlyArray<PlaceNameRow>, DatabaseError, Database>;
    readonly descendants: (
      id: bigint,
    ) => Effect.Effect<ReadonlyArray<PlaceRow>, DatabaseError, Database>;
    readonly descendantIds: (
      id: bigint,
    ) => Effect.Effect<ReadonlyArray<bigint>, DatabaseError, Database>;
    /**
     * Ancestor chain of one place: the place itself plus every parent up to
     * the root, nearest first. Powers city fallback (city -> state ->
     * country) and honest scope labels. Empty when the place is unknown.
     */
    readonly ancestors: (
      id: bigint,
    ) => Effect.Effect<ReadonlyArray<PlaceAncestorRow>, DatabaseError, Database>;
    readonly coordsAll: () => Effect.Effect<ReadonlyArray<PlaceCoordsRow>, DatabaseError, Database>;
    readonly dishIdsByPlace: (input: {
      readonly placeId: bigint;
      readonly status: string;
      readonly association: string | null;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<bigint>, DatabaseError, Database>;
    readonly listWithNames: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<PlaceListRow>, DatabaseError, Database>;
    readonly countriesWithNames: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<PlaceListRow>, DatabaseError, Database>;
    readonly parentEdges: () => Effect.Effect<
      ReadonlyArray<{ readonly placeId: bigint; readonly parentPlaceId: bigint }>,
      DatabaseError,
      Database
    >;
  }
>()("feastjourney/food-discovery/PlaceRepository") {}

export const PlaceRepositoryLive = Layer.succeed(PlaceRepository, {
  searchIds: (input) =>
    Effect.gen(function* () {
      return yield* runQuery("place/search", (sql) =>
        placeSearch.run(sql, {
          q: input.q,
          prefix: input.prefix,
          contains: input.contains,
          limit: input.limit,
        }),
      );
    }),
  findById: (id) =>
    Effect.gen(function* () {
      const row = yield* runQuery("place/find-by-id", (sql) => placeFindById.run(sql, { id }));

      return row;
    }),
  findByIso: (iso) =>
    Effect.gen(function* () {
      const row = yield* runQuery("place/find-by-iso", (sql) => placeFindByIso.run(sql, { iso }));

      return row;
    }),
  namesByPlaceIds: (ids) =>
    Effect.gen(function* () {
      return yield* runQuery("place/names-by-ids", (sql) =>
        placeNamesByPlaceIds.run(sql, { ids: [...ids] }),
      );
    }),
  descendants: (id) =>
    Effect.gen(function* () {
      const rows = yield* runQuery("place/descendants", (sql) =>
        placeFindDescendants.run(sql, { id }),
      );

      return rows;
    }),
  descendantIds: (id) =>
    Effect.gen(function* () {
      const rows = yield* runQuery("place/descendants", (sql) =>
        placeFindDescendants.run(sql, { id }),
      );

      return rows.map((row) => row.id);
    }),
  ancestors: (id) =>
    Effect.gen(function* () {
      return yield* runQuery("place/ancestors", (sql) => placeFindAncestors.run(sql, { id }));
    }),
  coordsAll: () =>
    Effect.gen(function* () {
      return yield* runQuery("place/coords-all", (sql) => placeCoordsAll.run(sql, {}));
    }),
  dishIdsByPlace: (input) =>
    Effect.gen(function* () {
      const rows = yield* runQuery("place/dish-ids", (sql) =>
        placeFindDishIds.run(sql, {
          place_id: input.placeId,
          status: input.status,
          association: input.association,
          limit: input.limit,
        }),
      );

      return rows.map((row) => row.dish_id);
    }),
  listWithNames: (limit) =>
    Effect.gen(function* () {
      return yield* runQuery("place/list", (sql) => placeListWithNames.run(sql, { limit }));
    }),
  countriesWithNames: (limit) =>
    Effect.gen(function* () {
      return yield* runQuery("place/countries", (sql) =>
        placeCountriesWithNames.run(sql, { limit }),
      );
    }),
  parentEdges: () =>
    Effect.gen(function* () {
      const rows = yield* runQuery("place/parents", (sql) => placeParentsAll.run(sql));

      return rows.map((row) => ({
        placeId: row.place_id,
        parentPlaceId: row.parent_place_id,
      }));
    }),
});
