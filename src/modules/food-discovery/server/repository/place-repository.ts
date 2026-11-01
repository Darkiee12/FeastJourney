import { Context, Effect, Layer } from "effect";

import placeChildrenByParent from "@/modules/food-discovery/server/repository/sql/place-children-by-parent.sql";
import placeCoordsAll from "@/modules/food-discovery/server/repository/sql/place-coords-all.sql";
import placeCountriesWithNames from "@/modules/food-discovery/server/repository/sql/place-countries-with-names.sql";
import placeDelete from "@/modules/food-discovery/server/repository/sql/place-delete.sql";
import placeDishLinkCounts from "@/modules/food-discovery/server/repository/sql/place-dish-link-counts.sql";
import placeFindAncestors from "@/modules/food-discovery/server/repository/sql/place-find-ancestors.sql";
import placeFindById from "@/modules/food-discovery/server/repository/sql/place-find-by-id.sql";
import placeFindByIso from "@/modules/food-discovery/server/repository/sql/place-find-by-iso.sql";
import placeFindByNameKeys from "@/modules/food-discovery/server/repository/sql/place-find-by-name-keys.sql";
import placeFindDescendants from "@/modules/food-discovery/server/repository/sql/place-find-descendants.sql";
import placeFindDishIds from "@/modules/food-discovery/server/repository/sql/place-find-dish-ids.sql";
import placeInsert from "@/modules/food-discovery/server/repository/sql/place-insert.sql";
import placeListAdmin from "@/modules/food-discovery/server/repository/sql/place-list-admin.sql";
import placeListWithNames from "@/modules/food-discovery/server/repository/sql/place-list-with-names.sql";
import placeNameDelete from "@/modules/food-discovery/server/repository/sql/place-name-delete.sql";
import placeNameInsert from "@/modules/food-discovery/server/repository/sql/place-name-insert.sql";
import placeNamePromote from "@/modules/food-discovery/server/repository/sql/place-name-promote.sql";
import placeNameUpdate from "@/modules/food-discovery/server/repository/sql/place-name-update.sql";
import placeNamesByPlaceIds from "@/modules/food-discovery/server/repository/sql/place-names-by-place-ids.sql";
import placeNamesDemote from "@/modules/food-discovery/server/repository/sql/place-names-demote.sql";
import placeNamesWithIdsByPlaceIds from "@/modules/food-discovery/server/repository/sql/place-names-with-ids-by-place-ids.sql";
import placeNearestCity from "@/modules/food-discovery/server/repository/sql/place-nearest-city.sql";
import placeParentDelete from "@/modules/food-discovery/server/repository/sql/place-parent-delete.sql";
import placeParentInsert from "@/modules/food-discovery/server/repository/sql/place-parent-insert.sql";
import placeParentsAll from "@/modules/food-discovery/server/repository/sql/place-parents-all.sql";
import placeParentsByPlaceIds from "@/modules/food-discovery/server/repository/sql/place-parents-by-place-ids.sql";
import placeRevisionInsert from "@/modules/food-discovery/server/repository/sql/place-revision-insert.sql";
import placeSearch from "@/modules/food-discovery/server/repository/sql/place-search.sql";
import placeUpdate from "@/modules/food-discovery/server/repository/sql/place-update.sql";
import type { Database, DbClient } from "@/server/database/client";
import {
  PersistenceConflict,
  PersistenceError,
  classifyDatabaseError,
} from "@/server/database/errors";
import { type DatabaseError, runQuery } from "@/server/database/query";

export type PlaceRow = (typeof placeFindById)["~reylo"]["element"];

export type PlaceAncestorRow = (typeof placeFindAncestors)["~reylo"]["element"];

export type PlaceNameRow = (typeof placeNamesByPlaceIds)["~reylo"]["element"];

export type PlaceListRow = (typeof placeListWithNames)["~reylo"]["element"];

export type PlaceCoordsRow = (typeof placeCoordsAll)["~reylo"]["element"];

export type PlaceAdminListRow = (typeof placeListAdmin)["~reylo"]["element"];

export type PlaceDishLinkCountRow = (typeof placeDishLinkCounts)["~reylo"]["element"];

export type PlaceEdgeRow = (typeof placeParentsByPlaceIds)["~reylo"]["element"];

export type PlaceNameInsertRow = (typeof placeNameInsert)["~reylo"]["element"];

export type PlaceNameWithIdRow = (typeof placeNamesWithIdsByPlaceIds)["~reylo"]["element"];

export type PlaceNamePromoteRow = (typeof placeNamePromote)["~reylo"]["element"];

export type PlaceNameUpdateRow = (typeof placeNameUpdate)["~reylo"]["element"];

export type PlaceNearestCityRow = (typeof placeNearestCity)["~reylo"]["element"];

export type PlaceDeletedRow = (typeof placeDelete)["~reylo"]["element"];

export type PlaceNameDeletedRow = (typeof placeNameDelete)["~reylo"]["element"];

export type PlaceParentDeletedRow = (typeof placeParentDelete)["~reylo"]["element"];

export type PlaceNameKeyRow = (typeof placeFindByNameKeys)["~reylo"]["element"];

export interface PlaceInsertInput {
  readonly kind: string;
  readonly iso3166: string | null;
  readonly displayLatitude: number | null;
  readonly displayLongitude: number | null;
  readonly displayNote: string | null;
}

export interface PlaceUpdateInput extends PlaceInsertInput {
  readonly id: bigint;
}

export interface PlaceListAdminInput {
  readonly tokens: ReadonlyArray<string>;
  readonly kind: string | null;
  readonly parentId: bigint | null;
  readonly limit: number;
  readonly offset: number;
}

export interface PlaceNameInsertInput {
  readonly placeId: bigint;
  readonly languageTag: string;
  readonly name: string;
  readonly isPreferred: boolean;
  readonly searchKey: string;
}

export interface PlaceNameUpdateInput {
  readonly id: bigint;
  readonly placeId: bigint;
  readonly languageTag: string;
  readonly name: string;
  readonly isPreferred: boolean;
  readonly searchKey: string;
}

export interface PlaceRevisionInsertInput {
  readonly placeId: bigint | null;
  readonly actor: string;
  readonly operation: string;
  readonly summary: string;
}

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
    /**
     * Same rows as namesByPlaceIds plus the name row id, for admin
     * name management (promote/remove need the row identity). Reads go
     * through the id-less projection; writes use this one.
     */
    readonly namesWithIdsByPlaceIds: (
      ids: ReadonlyArray<bigint>,
    ) => Effect.Effect<ReadonlyArray<PlaceNameWithIdRow>, DatabaseError, Database>;
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
    /**
     * Nearest city-scale place id to a coordinate pair within the caller's
     * max distance, or null when no city-scale place is close enough. Only
     * locality/province/subnational rows with coordinates count — country,
     * region, and continent centroids never pose as the visitor's city.
     */
    readonly nearestCityId: (input: {
      readonly latitude: number;
      readonly longitude: number;
      readonly maxDistanceM: number;
    }) => Effect.Effect<{ readonly id: bigint } | null, DatabaseError, Database>;
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
    /**
     * Admin registry writes. Every mutation runs inside the caller's
     * transaction (see PlaceAdminService); this repository owns only the
     * statements, the conflict mapping, and the audit row — never policy.
     */
    readonly insert: (input: PlaceInsertInput) => Effect.Effect<PlaceRow, DatabaseError, Database>;
    readonly update: (
      input: PlaceUpdateInput,
    ) => Effect.Effect<PlaceRow | null, DatabaseError, Database>;
    readonly deletePlace: (
      id: bigint,
    ) => Effect.Effect<PlaceDeletedRow | null, DatabaseError, Database>;
    readonly listAdmin: (
      input: PlaceListAdminInput,
    ) => Effect.Effect<ReadonlyArray<PlaceAdminListRow>, DatabaseError, Database>;
    readonly childrenOf: (
      parentId: bigint,
    ) => Effect.Effect<ReadonlyArray<PlaceRow>, DatabaseError, Database>;
    readonly dishLinkCounts: (
      placeId: bigint,
    ) => Effect.Effect<ReadonlyArray<PlaceDishLinkCountRow>, DatabaseError, Database>;
    readonly parentsByPlaceIds: (
      ids: ReadonlyArray<bigint>,
    ) => Effect.Effect<ReadonlyArray<PlaceEdgeRow>, DatabaseError, Database>;
    readonly findByNameKeys: (
      keys: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<PlaceNameKeyRow>, DatabaseError, Database>;
    readonly insertName: (
      input: PlaceNameInsertInput,
    ) => Effect.Effect<PlaceNameInsertRow, DatabaseError, Database>;
    readonly demoteNames: (input: {
      readonly placeId: bigint;
      readonly languageTag: string;
    }) => Effect.Effect<void, DatabaseError, Database>;
    readonly promoteName: (input: {
      readonly id: bigint;
      readonly placeId: bigint;
    }) => Effect.Effect<PlaceNamePromoteRow | null, DatabaseError, Database>;
    /**
     * ID-preserving rename: updates language tag, text, preferred flag,
     * and derived search key for one name row scoped to its place.
     * Returns null when the row moved places or vanished mid-transaction.
     */
    readonly updateName: (
      input: PlaceNameUpdateInput,
    ) => Effect.Effect<PlaceNameUpdateRow | null, DatabaseError, Database>;
    readonly deleteName: (input: {
      readonly id: bigint;
      readonly placeId: bigint;
    }) => Effect.Effect<PlaceNameDeletedRow | null, DatabaseError, Database>;
    readonly insertParent: (input: {
      readonly placeId: bigint;
      readonly parentPlaceId: bigint;
    }) => Effect.Effect<void, DatabaseError, Database>;
    readonly deleteParent: (input: {
      readonly placeId: bigint;
      readonly parentPlaceId: bigint;
    }) => Effect.Effect<PlaceParentDeletedRow | null, DatabaseError, Database>;
    readonly insertRevision: (
      input: PlaceRevisionInsertInput,
    ) => Effect.Effect<void, DatabaseError, Database>;
  }
>()("feastjourney/food-discovery/PlaceRepository") {}

const insertConflict = (
  operation: string,
  outcome: {
    readonly error?: {
      readonly condition?: string;
      readonly constraint?: string;
      readonly cause: unknown;
    };
  },
): Effect.Effect<never, DatabaseError> =>
  Effect.gen(function* () {
    if (outcome.error !== undefined && outcome.error.condition === "unique_violation") {
      return yield* new PersistenceConflict({
        operation,
        constraint: outcome.error.constraint ?? undefined,
      });
    }

    if (outcome.error !== undefined) {
      return yield* classifyDatabaseError(operation, outcome.error.cause);
    }

    return yield* new PersistenceError({ operation, cause: "unexpected insert outcome" });
  });

const runVoid = <A>(
  operation: string,
  task: (sql: DbClient) => Promise<A>,
): Effect.Effect<void, DatabaseError, Database> => Effect.asVoid(runQuery(operation, task));

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
  namesWithIdsByPlaceIds: (ids) =>
    Effect.gen(function* () {
      return yield* runQuery("place/names-with-ids-by-ids", (sql) =>
        placeNamesWithIdsByPlaceIds.run(sql, { ids: [...ids] }),
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
  nearestCityId: (input) =>
    Effect.gen(function* () {
      const row = yield* runQuery("place/nearest-city", (sql) =>
        placeNearestCity.run(sql, {
          latitude: input.latitude,
          longitude: input.longitude,
          max_distance_m: input.maxDistanceM,
        }),
      );

      if (row === null) {
        return null;
      }

      return { id: row.id };
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
  insert: (input) =>
    Effect.gen(function* () {
      const outcome = yield* runQuery("place/insert", (sql) =>
        placeInsert.try(sql, {
          kind: input.kind,
          iso3166: input.iso3166,
          display_latitude: input.displayLatitude,
          display_longitude: input.displayLongitude,
          display_note: input.displayNote,
        }),
      );

      if (outcome.error !== undefined) {
        return yield* insertConflict("place/insert", outcome);
      }

      return outcome.value;
    }),
  update: (input) =>
    Effect.gen(function* () {
      const outcome = yield* runQuery("place/update", (sql) =>
        placeUpdate.try(sql, {
          id: input.id,
          kind: input.kind,
          iso3166: input.iso3166,
          display_latitude: input.displayLatitude,
          display_longitude: input.displayLongitude,
          display_note: input.displayNote,
        }),
      );

      if (outcome.error !== undefined) {
        return yield* insertConflict("place/update", outcome);
      }

      return outcome.value;
    }),
  deletePlace: (id) =>
    Effect.gen(function* () {
      return yield* runQuery("place/delete", (sql) => placeDelete.run(sql, { id }));
    }),
  listAdmin: (input) =>
    Effect.gen(function* () {
      return yield* runQuery("place/list-admin", (sql) =>
        placeListAdmin.run(sql, {
          tokens: [...input.tokens],
          kind: input.kind,
          parent_id: input.parentId,
          limit: input.limit,
          offset: input.offset,
        }),
      );
    }),
  childrenOf: (parentId) =>
    Effect.gen(function* () {
      return yield* runQuery("place/children", (sql) =>
        placeChildrenByParent.run(sql, { parent_id: parentId }),
      );
    }),
  dishLinkCounts: (placeId) =>
    Effect.gen(function* () {
      return yield* runQuery("place/dish-link-counts", (sql) =>
        placeDishLinkCounts.run(sql, { place_id: placeId }),
      );
    }),
  parentsByPlaceIds: (ids) =>
    Effect.gen(function* () {
      return yield* runQuery("place/parents-by-ids", (sql) =>
        placeParentsByPlaceIds.run(sql, { ids: [...ids] }),
      );
    }),
  findByNameKeys: (keys) =>
    Effect.gen(function* () {
      if (keys.length === 0) {
        return [];
      }

      return yield* runQuery("place/find-by-name-keys", (sql) =>
        placeFindByNameKeys.run(sql, { keys: [...keys] }),
      );
    }),
  insertName: (input) =>
    Effect.gen(function* () {
      const outcome = yield* runQuery("place/name-insert", (sql) =>
        placeNameInsert.try(sql, {
          place_id: input.placeId,
          language_tag: input.languageTag,
          name: input.name,
          is_preferred: input.isPreferred,
          search_key: input.searchKey,
        }),
      );

      if (outcome.error !== undefined) {
        return yield* insertConflict("place/name-insert", outcome);
      }

      return outcome.value;
    }),
  demoteNames: (input) =>
    runVoid("place/names-demote", (sql) =>
      placeNamesDemote.run(sql, { place_id: input.placeId, language_tag: input.languageTag }),
    ),
  promoteName: (input) =>
    Effect.gen(function* () {
      return yield* runQuery("place/name-promote", (sql) =>
        placeNamePromote.run(sql, { id: input.id, place_id: input.placeId }),
      );
    }),
  updateName: (input) =>
    Effect.gen(function* () {
      const outcome = yield* runQuery("place/name-update", (sql) =>
        placeNameUpdate.try(sql, {
          id: input.id,
          place_id: input.placeId,
          language_tag: input.languageTag,
          name: input.name,
          is_preferred: input.isPreferred,
          search_key: input.searchKey,
        }),
      );

      if (outcome.error !== undefined) {
        return yield* insertConflict("place/name-update", outcome);
      }

      return outcome.value;
    }),
  deleteName: (input) =>
    Effect.gen(function* () {
      return yield* runQuery("place/name-delete", (sql) =>
        placeNameDelete.run(sql, { id: input.id, place_id: input.placeId }),
      );
    }),
  insertParent: (input) =>
    Effect.gen(function* () {
      // Cycle and self-loop safety is enforced by the caller's ancestor
      // walk before this statement; the place_parents_no_cycle trigger
      // remains as defense-in-depth and surfaces as PersistenceError.
      // The only unique constraint is the (place_id, parent_place_id)
      // primary key, so a 23505 here means the edge already exists and the
      // insert is an idempotent success.
      const outcome = yield* runQuery("place/parent-insert", (sql) =>
        placeParentInsert.try(sql, {
          place_id: input.placeId,
          parent_place_id: input.parentPlaceId,
        }),
      );

      if (outcome.error !== undefined && outcome.error.condition !== "unique_violation") {
        yield* classifyDatabaseError("place/parent-insert", outcome.error.cause);
      }
    }),
  deleteParent: (input) =>
    Effect.gen(function* () {
      return yield* runQuery("place/parent-delete", (sql) =>
        placeParentDelete.run(sql, {
          place_id: input.placeId,
          parent_place_id: input.parentPlaceId,
        }),
      );
    }),
  insertRevision: (input) =>
    runVoid("place/revision-insert", (sql) =>
      placeRevisionInsert.run(sql, {
        place_id: input.placeId,
        actor: input.actor,
        operation: input.operation,
        summary: input.summary,
      }),
    ),
});
