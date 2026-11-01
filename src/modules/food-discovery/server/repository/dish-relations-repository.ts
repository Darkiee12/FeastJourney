import { Context, Effect, Layer } from "effect";

import dishCategoriesByDishIds from "@/modules/food-discovery/server/repository/sql/dish-categories-by-dish-ids.sql";
import dishCategoryLink from "@/modules/food-discovery/server/repository/sql/dish-category-link.sql";
import dishCategoryUnlink from "@/modules/food-discovery/server/repository/sql/dish-category-unlink.sql";
import dishCuisineLink from "@/modules/food-discovery/server/repository/sql/dish-cuisine-link.sql";
import dishCuisineUnlink from "@/modules/food-discovery/server/repository/sql/dish-cuisine-unlink.sql";
import dishCuisinesByDishIds from "@/modules/food-discovery/server/repository/sql/dish-cuisines-by-dish-ids.sql";
import dishDescriptionDelete from "@/modules/food-discovery/server/repository/sql/dish-description-delete.sql";
import dishDescriptionUpsert from "@/modules/food-discovery/server/repository/sql/dish-description-upsert.sql";
import dishDescriptionsByDishIds from "@/modules/food-discovery/server/repository/sql/dish-descriptions-by-dish-ids.sql";
import dishFilter from "@/modules/food-discovery/server/repository/sql/dish-filter.sql";
import dishIngredientDelete from "@/modules/food-discovery/server/repository/sql/dish-ingredient-delete.sql";
import dishIngredientLink from "@/modules/food-discovery/server/repository/sql/dish-ingredient-link.sql";
import dishIngredientUpdateRole from "@/modules/food-discovery/server/repository/sql/dish-ingredient-update-role.sql";
import dishIngredientsByDishIds from "@/modules/food-discovery/server/repository/sql/dish-ingredients-by-dish-ids.sql";
import dishMediaByDishIds from "@/modules/food-discovery/server/repository/sql/dish-media-by-dish-ids.sql";
import dishMediaPublishedByDishIds from "@/modules/food-discovery/server/repository/sql/dish-media-published-by-dish-ids.sql";
import dishNameClearPreferred from "@/modules/food-discovery/server/repository/sql/dish-name-clear-preferred.sql";
import dishNameDelete from "@/modules/food-discovery/server/repository/sql/dish-name-delete.sql";
import dishNameInsert from "@/modules/food-discovery/server/repository/sql/dish-name-insert.sql";
import dishNameUpdate from "@/modules/food-discovery/server/repository/sql/dish-name-update.sql";
import dishNamesAdminByDishIds from "@/modules/food-discovery/server/repository/sql/dish-names-admin-by-dish.sql";
import dishNamesByDishIds from "@/modules/food-discovery/server/repository/sql/dish-names-by-dish-ids.sql";
import dishPlaceDelete from "@/modules/food-discovery/server/repository/sql/dish-place-delete.sql";
import dishPlaceLink from "@/modules/food-discovery/server/repository/sql/dish-place-link.sql";
import dishPlaceUpdate from "@/modules/food-discovery/server/repository/sql/dish-place-update.sql";
import dishPlacesByDishIds from "@/modules/food-discovery/server/repository/sql/dish-places-by-dish-ids.sql";
import dishSourceLink from "@/modules/food-discovery/server/repository/sql/dish-source-link.sql";
import dishSourcesByDishIds from "@/modules/food-discovery/server/repository/sql/dish-sources-by-dish-ids.sql";
import ingredientNameInsert from "@/modules/food-discovery/server/repository/sql/ingredient-name-insert.sql";
import type { Database, DbClient } from "@/server/database/client";
import { PersistenceConflict, classifyDatabaseError } from "@/server/database/errors";
import { type DatabaseError, runQuery } from "@/server/database/query";

export type DishNameRow = (typeof dishNamesByDishIds)["~reylo"]["element"];

export type DishNameAdminRow = (typeof dishNamesAdminByDishIds)["~reylo"]["element"];

export type DishNameMutationRow = (typeof dishNameUpdate)["~reylo"]["element"];

export type DishNameDeleteRow = (typeof dishNameDelete)["~reylo"]["element"];

export type DishNameClearRow = (typeof dishNameClearPreferred)["~reylo"]["element"];

export type DishDescriptionDeleteRow = (typeof dishDescriptionDelete)["~reylo"]["element"];

export type DishDescriptionRow = (typeof dishDescriptionsByDishIds)["~reylo"]["element"];

export type DishIngredientRow = (typeof dishIngredientsByDishIds)["~reylo"]["element"];

export type DishIngredientRoleRow = (typeof dishIngredientUpdateRole)["~reylo"]["element"];

export type DishIngredientDeleteRow = (typeof dishIngredientDelete)["~reylo"]["element"];

export type DishMediaRow = (typeof dishMediaByDishIds)["~reylo"]["element"];

export type DishPublishedMediaRow = (typeof dishMediaPublishedByDishIds)["~reylo"]["element"];

export type DishPlaceRow = (typeof dishPlacesByDishIds)["~reylo"]["element"];

export type DishPlaceLinkRow = (typeof dishPlaceUpdate)["~reylo"]["element"];

export type DishCategoryRow = (typeof dishCategoriesByDishIds)["~reylo"]["element"];

export type DishCuisineRow = (typeof dishCuisinesByDishIds)["~reylo"]["element"];

export type DishSourceRow = (typeof dishSourcesByDishIds)["~reylo"]["element"];

export class DishRelationsRepository extends Context.Service<
  DishRelationsRepository,
  {
    readonly namesByDishIds: (
      ids: ReadonlyArray<bigint>,
    ) => Effect.Effect<ReadonlyArray<DishNameRow>, DatabaseError, Database>;
    readonly adminNamesByDishIds: (
      ids: ReadonlyArray<bigint>,
    ) => Effect.Effect<ReadonlyArray<DishNameAdminRow>, DatabaseError, Database>;
    readonly descriptionsByDishIds: (
      ids: ReadonlyArray<bigint>,
    ) => Effect.Effect<ReadonlyArray<DishDescriptionRow>, DatabaseError, Database>;
    readonly ingredientsByDishIds: (
      ids: ReadonlyArray<bigint>,
    ) => Effect.Effect<ReadonlyArray<DishIngredientRow>, DatabaseError, Database>;
    /**
     * Legacy status-filtered read. No public surface uses this anymore —
     * prefer publishedMediaByDishIds for catalog projections.
     * @deprecated Use publishedMediaByDishIds for public surfaces.
     */
    readonly mediaByDishIds: (
      ids: ReadonlyArray<bigint>,
    ) => Effect.Effect<ReadonlyArray<DishMediaRow>, DatabaseError, Database>;
    /**
     * Public catalog projection: published + ready rows only, ordered by
     * sort_order (primary first). Backed by
     * dish-media-published-by-dish-ids.sql — the same source as
     * DishMediaService.publishedImagesByDishIds. Prefer this over
     * mediaByDishIds for any public surface.
     */
    readonly publishedMediaByDishIds: (
      ids: ReadonlyArray<bigint>,
    ) => Effect.Effect<ReadonlyArray<DishPublishedMediaRow>, DatabaseError, Database>;
    readonly placesByDishIds: (
      ids: ReadonlyArray<bigint>,
    ) => Effect.Effect<ReadonlyArray<DishPlaceRow>, DatabaseError, Database>;
    readonly categoriesByDishIds: (
      ids: ReadonlyArray<bigint>,
    ) => Effect.Effect<ReadonlyArray<DishCategoryRow>, DatabaseError, Database>;
    readonly cuisinesByDishIds: (
      ids: ReadonlyArray<bigint>,
    ) => Effect.Effect<ReadonlyArray<DishCuisineRow>, DatabaseError, Database>;
    readonly sourcesByDishIds: (
      ids: ReadonlyArray<bigint>,
    ) => Effect.Effect<ReadonlyArray<DishSourceRow>, DatabaseError, Database>;
    readonly filterIds: (input: {
      readonly ingredientIds: ReadonlyArray<bigint>;
      readonly categoryIds: ReadonlyArray<bigint>;
      readonly placeIds: ReadonlyArray<bigint>;
      readonly ingredientMode: string;
      readonly categoryMode: string;
      readonly cuisine: string | null;
      readonly association: string | null;
      readonly status: string;
      readonly cursor: bigint;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<bigint>, DatabaseError, Database>;
    readonly insertName: (input: {
      readonly dishId: bigint;
      readonly languageTag: string;
      readonly name: string;
      readonly nameKind: string;
      readonly isPreferred: boolean;
      readonly searchKey: string;
    }) => Effect.Effect<DishNameAdminRow, DatabaseError, Database>;
    readonly upsertDescription: (input: {
      readonly dishId: bigint;
      readonly languageTag: string;
      readonly description: string;
      readonly summary: string | null;
    }) => Effect.Effect<DishDescriptionRow, DatabaseError, Database>;
    readonly deleteDescription: (
      dishId: bigint,
      languageTag: string,
    ) => Effect.Effect<DishDescriptionDeleteRow | null, DatabaseError, Database>;
    readonly updateName: (input: {
      readonly id: bigint;
      readonly dishId: bigint;
      readonly languageTag: string;
      readonly name: string;
      readonly nameKind: string;
      readonly isPreferred: boolean;
      readonly searchKey: string;
    }) => Effect.Effect<DishNameMutationRow | null, DatabaseError, Database>;
    readonly deleteName: (
      id: bigint,
      dishId: bigint,
    ) => Effect.Effect<DishNameDeleteRow | null, DatabaseError, Database>;
    readonly clearPreferredNames: (
      dishId: bigint,
      languageTag: string,
      excludedId: bigint,
    ) => Effect.Effect<ReadonlyArray<DishNameClearRow>, DatabaseError, Database>;
    readonly updateIngredientRole: (
      dishId: bigint,
      ingredientId: bigint,
      role: string,
    ) => Effect.Effect<DishIngredientRoleRow | null, DatabaseError, Database>;
    readonly deleteIngredient: (
      dishId: bigint,
      ingredientId: bigint,
    ) => Effect.Effect<DishIngredientDeleteRow | null, DatabaseError, Database>;
    readonly unlinkCategory: (
      dishId: bigint,
      categoryId: bigint,
    ) => Effect.Effect<number, DatabaseError, Database>;
    readonly unlinkCuisine: (
      dishId: bigint,
      cuisineId: bigint,
    ) => Effect.Effect<number, DatabaseError, Database>;
    readonly updatePlaceLink: (input: {
      readonly dishId: bigint;
      readonly placeId: bigint;
      readonly association: string;
      readonly isDisputed: boolean;
      readonly note: string | null;
    }) => Effect.Effect<ReadonlyArray<DishPlaceLinkRow>, DatabaseError, Database>;
    readonly deletePlaceLink: (
      dishId: bigint,
      placeId: bigint,
    ) => Effect.Effect<number, DatabaseError, Database>;
    readonly linkDishSource: (
      dishId: bigint,
      sourceRecordId: bigint,
    ) => Effect.Effect<void, DatabaseError, Database>;
    readonly linkIngredient: (
      dishId: bigint,
      ingredientId: bigint,
      role: string,
    ) => Effect.Effect<void, DatabaseError, Database>;
    readonly linkPlace: (input: {
      readonly dishId: bigint;
      readonly placeId: bigint;
      readonly association: string;
      readonly isDisputed: boolean;
      readonly note: string | null;
    }) => Effect.Effect<void, DatabaseError, Database>;
    readonly linkCategory: (
      dishId: bigint,
      categoryId: bigint,
    ) => Effect.Effect<void, DatabaseError, Database>;
    readonly linkCuisine: (
      dishId: bigint,
      cuisineId: bigint,
    ) => Effect.Effect<void, DatabaseError, Database>;
    readonly insertIngredientName: (input: {
      readonly ingredientId: bigint;
      readonly languageTag: string;
      readonly name: string;
      readonly nameKind: string;
      readonly isPreferred: boolean;
      readonly searchKey: string;
    }) => Effect.Effect<void, DatabaseError, Database>;
  }
>()("feastjourney/food-discovery/DishRelationsRepository") {}

const runVoid = <A>(
  operation: string,
  task: (sql: DbClient) => Promise<A>,
): Effect.Effect<void, DatabaseError, Database> => Effect.asVoid(runQuery(operation, task));

export const DishRelationsRepositoryLive = Layer.succeed(DishRelationsRepository, {
  namesByDishIds: (ids) =>
    Effect.gen(function* () {
      return yield* runQuery("dish/names-by-ids", (sql) =>
        dishNamesByDishIds.run(sql, { ids: [...ids] }),
      );
    }),
  adminNamesByDishIds: (ids) =>
    Effect.gen(function* () {
      return yield* runQuery("dish/names-admin-by-ids", (sql) =>
        dishNamesAdminByDishIds.run(sql, { ids: [...ids] }),
      );
    }),
  descriptionsByDishIds: (ids) =>
    Effect.gen(function* () {
      return yield* runQuery("dish/descriptions-by-ids", (sql) =>
        dishDescriptionsByDishIds.run(sql, { ids: [...ids] }),
      );
    }),
  ingredientsByDishIds: (ids) =>
    Effect.gen(function* () {
      return yield* runQuery("dish/ingredients-by-ids", (sql) =>
        dishIngredientsByDishIds.run(sql, { ids: [...ids] }),
      );
    }),
  mediaByDishIds: (ids) =>
    Effect.gen(function* () {
      return yield* runQuery("dish/media-by-ids", (sql) =>
        dishMediaByDishIds.run(sql, { ids: [...ids], status: "published" }),
      );
    }),
  publishedMediaByDishIds: (ids) =>
    Effect.gen(function* () {
      if (ids.length === 0) {
        return [];
      }

      return yield* runQuery("dish/media-published-by-ids", (sql) =>
        dishMediaPublishedByDishIds.run(sql, { ids: [...ids] }),
      );
    }),
  placesByDishIds: (ids) =>
    Effect.gen(function* () {
      return yield* runQuery("dish/places-by-ids", (sql) =>
        dishPlacesByDishIds.run(sql, { ids: [...ids] }),
      );
    }),
  categoriesByDishIds: (ids) =>
    Effect.gen(function* () {
      return yield* runQuery("dish/categories-by-ids", (sql) =>
        dishCategoriesByDishIds.run(sql, { ids: [...ids] }),
      );
    }),
  cuisinesByDishIds: (ids) =>
    Effect.gen(function* () {
      return yield* runQuery("dish/cuisines-by-ids", (sql) =>
        dishCuisinesByDishIds.run(sql, { ids: [...ids] }),
      );
    }),
  sourcesByDishIds: (ids) =>
    Effect.gen(function* () {
      return yield* runQuery("dish/sources-by-ids", (sql) =>
        dishSourcesByDishIds.run(sql, { ids: [...ids] }),
      );
    }),
  filterIds: (input) =>
    Effect.gen(function* () {
      const rows = yield* runQuery("dish/filter", (sql) =>
        dishFilter.run(sql, {
          ingredient_ids: [...input.ingredientIds],
          category_ids: [...input.categoryIds],
          place_ids: [...input.placeIds],
          ingredient_mode: input.ingredientMode,
          category_mode: input.categoryMode,
          cuisine: input.cuisine,
          association: input.association,
          status: input.status,
          cursor: input.cursor,
          limit: input.limit,
        }),
      );

      return rows.map((row) => row.id);
    }),
  insertName: (input) =>
    Effect.gen(function* () {
      const outcome = yield* runQuery("dish/name-insert", (sql) =>
        dishNameInsert.try(sql, {
          dish_id: input.dishId,
          language_tag: input.languageTag,
          name: input.name,
          name_kind: input.nameKind,
          is_preferred: input.isPreferred,
          search_key: input.searchKey,
        }),
      );

      if (outcome.error !== undefined) {
        if (outcome.error.condition === "unique_violation") {
          return yield* new PersistenceConflict({
            operation: "dish/name-insert",
            constraint: outcome.error.constraint ?? undefined,
          });
        }

        return yield* classifyDatabaseError("dish/name-insert", outcome.error.cause);
      }

      return outcome.value;
    }),
  upsertDescription: (input) =>
    Effect.gen(function* () {
      return yield* runQuery("dish/description-upsert", (sql) =>
        dishDescriptionUpsert.run(sql, {
          dish_id: input.dishId,
          language_tag: input.languageTag,
          description: input.description,
          summary: input.summary,
        }),
      );
    }),
  deleteDescription: (dishId, languageTag) =>
    Effect.gen(function* () {
      return yield* runQuery("dish/description-delete", (sql) =>
        dishDescriptionDelete.run(sql, { dish_id: dishId, language_tag: languageTag }),
      );
    }),
  updateName: (input) =>
    Effect.gen(function* () {
      const outcome = yield* runQuery("dish/name-update", (sql) =>
        dishNameUpdate.try(sql, {
          id: input.id,
          dish_id: input.dishId,
          language_tag: input.languageTag,
          name: input.name,
          name_kind: input.nameKind,
          is_preferred: input.isPreferred,
          search_key: input.searchKey,
        }),
      );

      if (outcome.error !== undefined) {
        if (outcome.error.condition === "unique_violation") {
          return yield* new PersistenceConflict({
            operation: "dish/name-update",
            constraint: outcome.error.constraint ?? undefined,
          });
        }

        return yield* classifyDatabaseError("dish/name-update", outcome.error.cause);
      }

      return outcome.value;
    }),
  deleteName: (id, dishId) =>
    Effect.gen(function* () {
      return yield* runQuery("dish/name-delete", (sql) =>
        dishNameDelete.run(sql, { id, dish_id: dishId }),
      );
    }),
  clearPreferredNames: (dishId, languageTag, excludedId) =>
    Effect.gen(function* () {
      return yield* runQuery("dish/name-clear-preferred", (sql) =>
        dishNameClearPreferred.run(sql, {
          dish_id: dishId,
          language_tag: languageTag,
          excluded_id: excludedId,
        }),
      );
    }),
  updateIngredientRole: (dishId, ingredientId, role) =>
    Effect.gen(function* () {
      return yield* runQuery("dish/ingredient-update-role", (sql) =>
        dishIngredientUpdateRole.run(sql, {
          dish_id: dishId,
          ingredient_id: ingredientId,
          role,
        }),
      );
    }),
  deleteIngredient: (dishId, ingredientId) =>
    Effect.gen(function* () {
      return yield* runQuery("dish/ingredient-delete", (sql) =>
        dishIngredientDelete.run(sql, { dish_id: dishId, ingredient_id: ingredientId }),
      );
    }),
  unlinkCategory: (dishId, categoryId) =>
    Effect.gen(function* () {
      const row = yield* runQuery("dish/category-unlink", (sql) =>
        dishCategoryUnlink.run(sql, { dish_id: dishId, category_id: categoryId }),
      );

      return row === null ? 0 : 1;
    }),
  unlinkCuisine: (dishId, cuisineId) =>
    Effect.gen(function* () {
      const row = yield* runQuery("dish/cuisine-unlink", (sql) =>
        dishCuisineUnlink.run(sql, { dish_id: dishId, cuisine_id: cuisineId }),
      );

      return row === null ? 0 : 1;
    }),
  updatePlaceLink: (input) =>
    Effect.gen(function* () {
      const row = yield* runQuery("dish/place-update", (sql) =>
        dishPlaceUpdate.run(sql, {
          dish_id: input.dishId,
          place_id: input.placeId,
          association: input.association,
          is_disputed: input.isDisputed,
          note: input.note,
        }),
      );

      // Reylo infers UPDATE...RETURNING on the pair key as a single row
      // (Row | null); the operation contract works in row lists, so an
      // empty update normalizes to [] (caller inserts) instead of null.
      return row === null ? [] : [row];
    }),
  deletePlaceLink: (dishId, placeId) =>
    Effect.gen(function* () {
      const row = yield* runQuery("dish/place-delete", (sql) =>
        dishPlaceDelete.run(sql, { dish_id: dishId, place_id: placeId }),
      );

      return row === null ? 0 : 1;
    }),
  linkDishSource: (dishId, sourceRecordId) =>
    runVoid("dish/source-link", (sql) =>
      dishSourceLink.run(sql, { dish_id: dishId, source_record_id: sourceRecordId }),
    ),
  linkIngredient: (dishId, ingredientId, role) =>
    runVoid("dish/ingredient-link", (sql) =>
      dishIngredientLink.run(sql, {
        dish_id: dishId,
        ingredient_id: ingredientId,
        role,
      }),
    ),
  linkPlace: (input) =>
    runVoid("dish/place-link", (sql) =>
      dishPlaceLink.run(sql, {
        dish_id: input.dishId,
        place_id: input.placeId,
        association: input.association,
        is_disputed: input.isDisputed,
        note: input.note,
      }),
    ),
  linkCategory: (dishId, categoryId) =>
    runVoid("dish/category-link", (sql) =>
      dishCategoryLink.run(sql, { dish_id: dishId, category_id: categoryId }),
    ),
  linkCuisine: (dishId, cuisineId) =>
    runVoid("dish/cuisine-link", (sql) =>
      dishCuisineLink.run(sql, { dish_id: dishId, cuisine_id: cuisineId }),
    ),
  insertIngredientName: (input) =>
    runVoid("ingredient/name-insert", (sql) =>
      ingredientNameInsert.run(sql, {
        ingredient_id: input.ingredientId,
        language_tag: input.languageTag,
        name: input.name,
        name_kind: input.nameKind,
        is_preferred: input.isPreferred,
        search_key: input.searchKey,
      }),
    ),
});
