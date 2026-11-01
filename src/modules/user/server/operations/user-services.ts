import { Context, Effect, Layer } from "effect";

import type { DishServiceError } from "@/modules/food-discovery/server/operations/dish-service";
import { DishService } from "@/modules/food-discovery/server/operations/dish-service";
import { FavoriteExists, FavoriteNotFound } from "@/modules/user/server/domain/errors";
import type {
  FavoriteRow,
  FoodPreferencesRow,
  ProfileRow,
} from "@/modules/user/server/repository/user-repository";
import { UserRepository } from "@/modules/user/server/repository/user-repository";
import type { Database } from "@/server/database/client";
import type { DatabaseError } from "@/server/database/query";

export class ProfileService extends Context.Service<
  ProfileService,
  {
    readonly getProfile: (
      userId: string,
    ) => Effect.Effect<ProfileRow | null, DatabaseError, Database>;
    readonly updateProfile: (input: {
      readonly userId: string;
      readonly displayName: string | null;
      readonly locale: string;
    }) => Effect.Effect<ProfileRow, DatabaseError, Database>;
    /**
     * Member ingredient exclusions shared by the quiz and account settings.
     * Reads return null when absent; saves never touch display_name/locale
     * (separate relation, profile row ensured with defaults only).
     */
    readonly getFoodPreferences: (
      userId: string,
    ) => Effect.Effect<FoodPreferencesRow | null, DatabaseError, Database>;
    readonly saveFoodPreferences: (input: {
      readonly userId: string;
      readonly excludedIngredients: ReadonlyArray<string>;
    }) => Effect.Effect<FoodPreferencesRow, DatabaseError, Database>;
  }
>()("feastjourney/user/ProfileService") {}

export const ProfileServiceLive = Layer.effect(
  ProfileService,
  Effect.gen(function* () {
    const repository = yield* UserRepository;

    return ProfileService.of({
      getProfile: (userId) => repository.profileByUserId(userId),
      updateProfile: (input) =>
        repository.upsertProfile({
          userId: input.userId,
          displayName: input.displayName,
          locale: input.locale,
        }),
      getFoodPreferences: (userId) => repository.foodPreferencesByUserId(userId),
      saveFoodPreferences: (input) =>
        repository.upsertFoodPreferences({
          userId: input.userId,
          excludedIngredients: input.excludedIngredients,
        }),
    });
  }),
);

export class FavoritesService extends Context.Service<
  FavoritesService,
  {
    readonly listFavorites: (
      userId: string,
      limit: number,
      offset: number,
    ) => Effect.Effect<ReadonlyArray<FavoriteRow>, DatabaseError, Database>;
    /**
     * Membership probe for visible dish ids: returns the subset that is
     * actually saved, so cards stay correct no matter how many favorites
     * the account holds in total. Malformed ids are skipped, never fatal.
     */
    readonly favoriteStatus: (
      userId: string,
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<Array<string>, DatabaseError, Database>;
    readonly addFavorite: (
      userId: string,
      dishId: string,
    ) => Effect.Effect<
      FavoriteRow,
      DishServiceError | DatabaseError | FavoriteExists,
      Database | DishService
    >;
    readonly removeFavorite: (
      userId: string,
      dishId: string,
    ) => Effect.Effect<void, DatabaseError | FavoriteNotFound, Database>;
  }
>()("feastjourney/user/FavoritesService") {}

export const FavoritesServiceLive = Layer.effect(
  FavoritesService,
  Effect.gen(function* () {
    const dishes = yield* DishService;
    const repository = yield* UserRepository;

    return FavoritesService.of({
      listFavorites: (userId, limit, offset) => repository.favoritesByUserId(userId, limit, offset),
      favoriteStatus: (userId, ids) =>
        Effect.gen(function* () {
          const numericIds: Array<bigint> = [];

          for (const id of ids.slice(0, 50)) {
            if (/^[0-9]+$/.test(id)) {
              numericIds.push(BigInt(id));
            }
          }

          if (numericIds.length === 0) {
            return [];
          }

          const rows = yield* repository.favoriteStatusByDishIds(userId, numericIds);

          return rows.map((row) => row.dish_id);
        }),
      addFavorite: (userId, dishId) =>
        Effect.gen(function* () {
          yield* dishes.getDish(dishId, "en");

          const numericId = BigInt(dishId);
          const existing = yield* repository.favoriteByUserDish(userId, numericId);

          if (existing !== null) {
            return yield* new FavoriteExists({ dishId });
          }

          return yield* Effect.catchTag(
            repository.insertFavorite(userId, numericId),
            "PersistenceConflict",
            () => new FavoriteExists({ dishId }),
          );
        }),
      removeFavorite: (userId, dishId) =>
        Effect.gen(function* () {
          const numericId = BigInt(dishId);
          const existing = yield* repository.favoriteByUserDish(userId, numericId);

          if (existing === null) {
            return yield* new FavoriteNotFound({ dishId });
          }

          return yield* repository.deleteFavorite(userId, numericId);
        }),
    });
  }),
);
