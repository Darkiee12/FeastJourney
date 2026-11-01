import { Context, Effect, Layer } from "effect";

import auditInsert from "@/modules/user/server/repository/sql/audit-insert.sql";
import favoriteByUserDish from "@/modules/user/server/repository/sql/favorite-by-user-dish.sql";
import favoriteDelete from "@/modules/user/server/repository/sql/favorite-delete.sql";
import favoriteInsert from "@/modules/user/server/repository/sql/favorite-insert.sql";
import favoritesByUserId from "@/modules/user/server/repository/sql/favorites-by-user-id.sql";
import favoritesStatusByDishIds from "@/modules/user/server/repository/sql/favorites-status-by-dish-ids.sql";
import foodPreferencesByUserId from "@/modules/user/server/repository/sql/food-preferences-by-user-id.sql";
import foodPreferencesUpsert from "@/modules/user/server/repository/sql/food-preferences-upsert.sql";
import profileByUserId from "@/modules/user/server/repository/sql/profile-by-user-id.sql";
import profileUpsert from "@/modules/user/server/repository/sql/profile-upsert.sql";
import type { Database } from "@/server/database/client";
import {
  classifyDatabaseError,
  PersistenceConflict,
  PersistenceError,
} from "@/server/database/errors";
import { runQuery } from "@/server/database/query";
import type { DatabaseError } from "@/server/database/query";

export type ProfileRow = (typeof profileByUserId)["~reylo"]["element"];

export type FavoriteRow = (typeof favoritesByUserId)["~reylo"]["element"];

export type FavoriteKeyRow = (typeof favoriteByUserDish)["~reylo"]["element"];

export type FavoriteStatusRow = (typeof favoritesStatusByDishIds)["~reylo"]["element"];

export type FoodPreferencesRow = (typeof foodPreferencesByUserId)["~reylo"]["element"];

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

export class UserRepository extends Context.Service<
  UserRepository,
  {
    readonly profileByUserId: (
      userId: string,
    ) => Effect.Effect<ProfileRow | null, DatabaseError, Database>;
    readonly upsertProfile: (input: {
      readonly userId: string;
      readonly displayName: string | null;
      readonly locale: string;
    }) => Effect.Effect<ProfileRow, DatabaseError, Database>;
    readonly favoriteByUserDish: (
      userId: string,
      dishId: bigint,
    ) => Effect.Effect<FavoriteKeyRow | null, DatabaseError, Database>;
    readonly favoritesByUserId: (
      userId: string,
      limit: number,
      offset: number,
    ) => Effect.Effect<ReadonlyArray<FavoriteRow>, DatabaseError, Database>;
    readonly favoriteStatusByDishIds: (
      userId: string,
      ids: ReadonlyArray<bigint>,
    ) => Effect.Effect<ReadonlyArray<FavoriteStatusRow>, DatabaseError, Database>;
    readonly insertFavorite: (
      userId: string,
      dishId: bigint,
    ) => Effect.Effect<FavoriteRow, DatabaseError, Database>;
    readonly deleteFavorite: (
      userId: string,
      dishId: bigint,
    ) => Effect.Effect<void, DatabaseError, Database>;
    readonly foodPreferencesByUserId: (
      userId: string,
    ) => Effect.Effect<FoodPreferencesRow | null, DatabaseError, Database>;
    readonly upsertFoodPreferences: (input: {
      readonly userId: string;
      readonly excludedIngredients: ReadonlyArray<string>;
    }) => Effect.Effect<FoodPreferencesRow, DatabaseError, Database>;
    readonly insertAuditEvent: (input: {
      readonly actorUserId: string | null;
      readonly sessionId: string | null;
      readonly requestId: string;
      readonly event: string;
      readonly outcome: "succeeded" | "failed" | "denied";
      readonly reason: string | null;
      readonly resource: string | null;
      readonly metadata: string;
    }) => Effect.Effect<void, DatabaseError, Database>;
  }
>()("feastjourney/user/UserRepository") {}

export const UserRepositoryLive = Layer.succeed(UserRepository, {
  profileByUserId: (userId) =>
    runQuery("user/profile-by-user-id", (sql) => profileByUserId.run(sql, { user_id: userId })),
  upsertProfile: (input) =>
    runQuery("user/profile-upsert", (sql) =>
      profileUpsert.run(sql, {
        user_id: input.userId,
        display_name: input.displayName,
        locale: input.locale,
      }),
    ),
  favoriteByUserDish: (userId, dishId) =>
    runQuery("user/favorite-by-user-dish", (sql) =>
      favoriteByUserDish.run(sql, { user_id: userId, dish_id: dishId }),
    ),
  favoritesByUserId: (userId, limit, offset) =>
    runQuery("user/favorites-by-user-id", (sql) =>
      favoritesByUserId.run(sql, { user_id: userId, limit, offset }),
    ),
  favoriteStatusByDishIds: (userId, ids) =>
    runQuery("user/favorites-status-by-dish-ids", (sql) =>
      favoritesStatusByDishIds.run(sql, { user_id: userId, ids: [...ids] }),
    ),
  insertFavorite: (userId, dishId) =>
    Effect.gen(function* () {
      const outcome = yield* runQuery("user/favorite-insert", (sql) =>
        favoriteInsert.try(sql, { user_id: userId, dish_id: dishId }),
      );

      if (outcome.error !== undefined) {
        return yield* insertConflict("user/favorite-insert", outcome);
      }

      return outcome.value;
    }),
  deleteFavorite: (userId, dishId) =>
    runQuery("user/favorite-delete", (sql) =>
      favoriteDelete.run(sql, { user_id: userId, dish_id: dishId }),
    ),
  foodPreferencesByUserId: (userId) =>
    runQuery("user/food-preferences-by-user-id", (sql) =>
      foodPreferencesByUserId.run(sql, { user_id: userId }),
    ),
  upsertFoodPreferences: (input) =>
    runQuery("user/food-preferences-upsert", (sql) =>
      foodPreferencesUpsert.run(sql, {
        user_id: input.userId,
        excluded_ingredients: [...input.excludedIngredients],
      }),
    ),
  insertAuditEvent: (input) =>
    runQuery("user/audit-insert", (sql) =>
      auditInsert.run(sql, {
        actor_user_id: input.actorUserId,
        session_id: input.sessionId,
        request_id: input.requestId,
        event: input.event,
        outcome: input.outcome,
        reason: input.reason,
        resource: input.resource,
        metadata: input.metadata,
      }),
    ),
});
