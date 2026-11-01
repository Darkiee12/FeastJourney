import { createServerFn } from "@tanstack/react-start";

import {
  favoriteLinkSchema,
  favoriteStatusSchema,
  favoritesQuerySchema,
  foodPreferencesUpdateSchema,
  profileUpdateSchema,
} from "@/modules/user/user.schema";

/**
 * Profile and favorites server functions.
 *
 * Server-only dependencies stay behind the dynamic loader below so
 * browser bundles never execute server modules; each handler
 * destructures only the namespaces it uses. Service results already
 * carry client-safe shapes (string IDs, no credentials), so handlers
 * pass them through without mapping.
 */
const loadServer = async () => {
  const [effects, server, services, audit, session, actor, currentActor, runtime] =
    await Promise.all([
      import("effect"),
      import("@tanstack/react-start/server"),
      import("@/modules/user/server/operations/user-services"),
      import("@/modules/user/server/operations/audit"),
      import("@/server/auth/session"),
      import("@/server/auth/actor"),
      import("@/server/auth/current-actor"),
      import("@/server/runtime"),
    ]);

  return {
    effects,
    server,
    services,
    audit,
    session,
    actor,
    currentActor,
    runtime,
  };
};

export const getProfileFn = createServerFn({ method: "GET" }).handler(async () => {
  const {
    effects,
    server,
    services: { ProfileService },
    session,
    actor,
    currentActor,
    runtime,
  } = await loadServer();

  const headers = server.getRequestHeaders();
  const requestId = crypto.randomUUID();

  const trusted = await runtime.runApp(
    session.requireAuthenticatedActor(headers),
    "fn/user/profile",
    15000,
    requestId,
  );

  return runtime.runApp(
    currentActor.withActor(
      actor.Actor.Member({ userId: trusted.userId }),
      effects.Effect.flatMap(ProfileService, (service) => service.getProfile(trusted.userId)),
    ),
    "fn/user/profile",
    15000,
    requestId,
  );
});

export const updateProfileFn = createServerFn({ method: "POST" })
  .validator(profileUpdateSchema)
  .handler(async ({ data }) => {
    const {
      effects,
      server,
      services: { ProfileService },
      audit,
      session,
      actor,
      currentActor,
      runtime,
    } = await loadServer();

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    const trusted = await runtime.runApp(
      session.requireAuthenticatedActor(headers),
      "fn/user/profile-update",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(ProfileService, (service) =>
          service.updateProfile({
            userId: trusted.userId,
            displayName: data.display_name,
            locale: data.locale,
          }),
        ).pipe(
          effects.Effect.tap(() =>
            audit.recordAuditEvent({
              actorUserId: trusted.userId,
              sessionId: trusted.sessionId,
              requestId,
              event: "betterAuth.auth.profile.updated",
              outcome: "succeeded",
              resource: `user:${trusted.userId}`,
            }),
          ),
        ),
      ),
      "fn/user/profile-update",
      15000,
      requestId,
    );
  });

/**
 * Member ingredient exclusions shared by the quiz and account settings.
 * Reads return null when the member never saved any; user_id always comes
 * from the verified session, never from client input.
 */
export const getFoodPreferencesFn = createServerFn({ method: "GET" }).handler(async () => {
  const {
    effects,
    server,
    services: { ProfileService },
    session,
    actor,
    currentActor,
    runtime,
  } = await loadServer();

  const headers = server.getRequestHeaders();
  const requestId = crypto.randomUUID();

  const trusted = await runtime.runApp(
    session.requirePermission(headers, { resource: "profile", actions: ["read"] }),
    "fn/user/food-preferences",
    15000,
    requestId,
  );

  const row = await runtime.runApp(
    currentActor.withActor(
      actor.Actor.Member({ userId: trusted.userId }),
      effects.Effect.flatMap(ProfileService, (service) =>
        service.getFoodPreferences(trusted.userId),
      ),
    ),
    "fn/user/food-preferences",
    15000,
    requestId,
  );

  return row === null
    ? null
    : // SAFETY: the database is a trust boundary; text[] can physically hold
      // NULLs, so only non-null terms cross into the client-safe shape.
      { excludedIngredients: row.excluded_ingredients.filter((term) => term !== null) };
});

export const saveFoodPreferencesFn = createServerFn({ method: "POST" })
  .validator(foodPreferencesUpdateSchema)
  .handler(async ({ data }) => {
    const {
      effects,
      server,
      services: { ProfileService },
      audit,
      session,
      actor,
      currentActor,
      runtime,
    } = await loadServer();

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "profile", actions: ["update"] }),
      "fn/user/food-preferences-update",
      15000,
      requestId,
    );

    const saved = await runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(ProfileService, (service) =>
          service.saveFoodPreferences({
            userId: trusted.userId,
            excludedIngredients: data.excluded_ingredients,
          }),
        ).pipe(
          effects.Effect.tap(() =>
            audit.recordAuditEvent({
              actorUserId: trusted.userId,
              sessionId: trusted.sessionId,
              requestId,
              event: "betterAuth.auth.food-preferences.updated",
              outcome: "succeeded",
              resource: `user:${trusted.userId}`,
              // Counts only: ingredient terms never reach logs or analytics.
              metadata: { count: String(data.excluded_ingredients.length) },
            }),
          ),
        ),
      ),
      "fn/user/food-preferences-update",
      15000,
      requestId,
    );

    return {
      ok: true as const,
      // SAFETY: same trust-boundary mapping as the read path above.
      excludedIngredients: saved.excluded_ingredients.filter((term) => term !== null),
    };
  });

export const listFavoritesFn = createServerFn({ method: "GET" })
  .validator(favoritesQuerySchema)
  .handler(async ({ data }) => {
    const {
      effects,
      server,
      services: { FavoritesService },
      session,
      actor,
      currentActor,
      runtime,
    } = await loadServer();

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "favorite", actions: ["read"] }),
      "fn/user/favorites",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(FavoritesService, (service) =>
          service.listFavorites(trusted.userId, data.limit, data.offset),
        ),
      ),
      "fn/user/favorites",
      15000,
      requestId,
    );
  });

/**
 * Membership probe for visible dish ids: returns the subset that is saved,
 * so cards stay correct no matter how many favorites the account holds.
 */
export const favoriteStatusFn = createServerFn({ method: "GET" })
  .validator(favoriteStatusSchema)
  .handler(async ({ data }) => {
    const {
      effects,
      server,
      services: { FavoritesService },
      session,
      actor,
      currentActor,
      runtime,
    } = await loadServer();

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "favorite", actions: ["read"] }),
      "fn/user/favorites-status",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(FavoritesService, (service) =>
          service.favoriteStatus(trusted.userId, data.ids),
        ),
      ),
      "fn/user/favorites-status",
      15000,
      requestId,
    );
  });

export const addFavoriteFn = createServerFn({ method: "POST" })
  .validator(favoriteLinkSchema)
  .handler(async ({ data }) => {
    const {
      effects,
      server,
      services: { FavoritesService },
      audit,
      session,
      actor,
      currentActor,
      runtime,
    } = await loadServer();

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "favorite", actions: ["create"] }),
      "fn/user/favorites-add",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(FavoritesService, (service) =>
          service.addFavorite(trusted.userId, data.dish_id),
        ).pipe(
          effects.Effect.tap(() =>
            audit.recordAuditEvent({
              actorUserId: trusted.userId,
              sessionId: trusted.sessionId,
              requestId,
              event: "betterAuth.auth.favorite.created",
              outcome: "succeeded",
              resource: `dish:${data.dish_id}`,
            }),
          ),
        ),
      ),
      "fn/user/favorites-add",
      15000,
      requestId,
    );
  });

export const removeFavoriteFn = createServerFn({ method: "POST" })
  .validator(favoriteLinkSchema)
  .handler(async ({ data }) => {
    const {
      effects,
      server,
      services: { FavoritesService },
      audit,
      session,
      actor,
      currentActor,
      runtime,
    } = await loadServer();

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "favorite", actions: ["delete"] }),
      "fn/user/favorites-remove",
      15000,
      requestId,
    );

    return runtime
      .runApp(
        currentActor.withActor(
          actor.Actor.Member({ userId: trusted.userId }),
          effects.Effect.flatMap(FavoritesService, (service) =>
            service.removeFavorite(trusted.userId, data.dish_id),
          ).pipe(
            effects.Effect.tap(() =>
              audit.recordAuditEvent({
                actorUserId: trusted.userId,
                sessionId: trusted.sessionId,
                requestId,
                event: "betterAuth.auth.favorite.deleted",
                outcome: "succeeded",
                resource: `dish:${data.dish_id}`,
              }),
            ),
          ),
        ),
        "fn/user/favorites-remove",
        15000,
        requestId,
      )
      .then(() => ({ ok: true as const }));
  });
