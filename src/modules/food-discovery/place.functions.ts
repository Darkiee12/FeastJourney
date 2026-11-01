import { createServerFn } from "@tanstack/react-start";
import type { Effect } from "effect";
import type * as EffectModule from "effect";

import {
  adminDeletePlaceSchema,
  adminPlaceDetailSchema,
  adminPlaceNamesSchema,
  adminPlaceParentSchema,
  adminPlacesListSchema,
  adminUpdatePlaceSchema,
  adminCreatePlaceSchema,
} from "@/modules/food-discovery/place.schema";
import type {
  PlaceAdminApi,
  PlaceMutationError,
  PlaceNameView,
} from "@/modules/food-discovery/server/operations/place-admin-service";
import type * as AuthorizationModule from "@/modules/user/server/operations/authorization";
import type { Authorization } from "@/modules/user/server/operations/authorization";
import type { RoleRepository } from "@/modules/user/server/repository/role-repository";
import type * as ActorModule from "@/server/auth/actor";
import type { CurrentActor } from "@/server/auth/current-actor";
import { InsufficientPermissions } from "@/server/auth/errors";
import type { PermissionRequest } from "@/server/auth/permissions";
import type * as SessionModule from "@/server/auth/session";
import type { Database } from "@/server/database/client";
import type { TransactionFailed } from "@/server/database/errors";
import type { DatabaseError } from "@/server/database/query";
import type * as RuntimeModule from "@/server/runtime";

/**
 * Place registry administration transport: list/detail plus full CRUD for
 * places, names, and parent edges.
 *
 * Every handler resolves the actor from the verified session and enforces
 * current database grants at the server boundary. Reads require
 * `food:read`; every mutation requires `food:update` here AND inside
 * `PlaceAdminService` (defense in depth). Route guards are navigation hints
 * only; these checks are the real authorization.
 *
 * `PlaceAdminService` is provided per call (not yet in the singleton
 * `AppLive`; the coordinator wires it into `src/server/layers.ts`). Client
 * failures arrive as `{ok:false,...}` outcomes; infrastructure failures
 * (permissions, database, transactions) propagate as server-function errors.
 */
const loadServer = async () => {
  const [effects, server, places, authorization, session, actor, currentActor, runtime] =
    await Promise.all([
      import("effect"),
      import("@tanstack/react-start/server"),
      import("@/modules/food-discovery/server/operations/place-admin-service"),
      import("@/modules/user/server/operations/authorization"),
      import("@/server/auth/session"),
      import("@/server/auth/actor"),
      import("@/server/auth/current-actor"),
      import("@/server/runtime"),
    ]);

  return {
    effects,
    server,
    places,
    authorization,
    session,
    actor,
    currentActor,
    runtime,
  };
};

const SURFACE_CHECKS = [
  { resource: "admin", actions: ["access"] },
  { resource: "food", actions: ["import"] },
  { resource: "moderation", actions: ["read"] },
] as const;

const requireSurface = async (
  loaded: {
    readonly effects: typeof EffectModule;
    readonly authorization: typeof AuthorizationModule;
    readonly session: typeof SessionModule;
    readonly actor: typeof ActorModule;
    readonly runtime: typeof RuntimeModule;
  },
  headers: Headers,
  operation: string,
  requestId: string,
) => {
  const { effects, authorization, session, actor, runtime } = loaded;

  return runtime.runApp(
    effects.Effect.flatMap(session.requireAuthenticatedActor(headers), (trusted) => {
      const member = actor.Actor.Member({ userId: trusted.userId });

      return effects.Effect.flatMap(
        effects.Effect.forEach(SURFACE_CHECKS, (check) =>
          effects.Effect.flatMap(authorization.Authorization, (authz) => authz.has(member, check)),
        ),
        (results) =>
          results.some(Boolean)
            ? effects.Effect.succeed(trusted)
            : effects.Effect.fail(
                new InsufficientPermissions({
                  reason: "administration requires admin, import, or moderation grants",
                }),
              ),
      );
    }),
    operation,
    15000,
    requestId,
  );
};

type PlaceMutationFailure =
  | { readonly ok: false; readonly code: "conflicting_place"; readonly reason: string }
  | { readonly ok: false; readonly code: "invalid_place"; readonly reason: string }
  | { readonly ok: false; readonly code: "invalid_relationship"; readonly reason: string }
  | { readonly ok: false; readonly code: "invalid_request"; readonly reason: string }
  | {
      readonly ok: false;
      readonly code: "place_has_children";
      readonly reason: string;
      readonly childCount: number;
    }
  | {
      readonly ok: false;
      readonly code: "place_has_dish_links";
      readonly reason: string;
      readonly dishCount: number;
    }
  | { readonly ok: false; readonly code: "place_not_found"; readonly reason: string };

/**
 * Maps expected place-domain failures to client-safe outcomes, mirroring
 * `settlePhotoTask` in admin.functions.ts. Permission, database, and
 * transaction failures are not caught: they propagate as server-function
 * errors instead of masquerading as place reasons.
 */
const settlePlaceTask = <A, R>(
  effects: typeof EffectModule,
  task: Effect.Effect<A, PlaceMutationError, R>,
): Effect.Effect<
  { readonly ok: true; readonly value: A } | PlaceMutationFailure,
  DatabaseError | InsufficientPermissions | TransactionFailed,
  R
> =>
  task.pipe(
    effects.Effect.map((value) => ({ ok: true as const, value })),
    effects.Effect.catchTags({
      ConflictingPlace: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "conflicting_place" as const,
          reason: failure.reason,
        }),
      InvalidPlaceData: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "invalid_place" as const,
          reason: failure.reason,
        }),
      InvalidRelationship: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "invalid_relationship" as const,
          reason: failure.reason,
        }),
      InvalidSearchFilter: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "invalid_request" as const,
          reason: failure.reason,
        }),
      PlaceHasChildren: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "place_has_children" as const,
          reason: `Place ${failure.placeId} has ${failure.childCount} child place(s); unlink them first.`,
          childCount: failure.childCount,
        }),
      PlaceHasDishLinks: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "place_has_dish_links" as const,
          reason: `Place ${failure.placeId} is linked to ${failure.dishCount} dish(es); unlink them first.`,
          dishCount: failure.dishCount,
        }),
      PlaceNotFound: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "place_not_found" as const,
          reason: `No place found for "${failure.placeId}". Ask the Place Manager to register it in the admin place catalog before linking.`,
        }),
    }),
  );

type AdminPlaceNamesOutcome =
  | { readonly ok: true; readonly names: ReadonlyArray<PlaceNameView> }
  | { readonly ok: true; readonly removedNameId: string; readonly promotedNameId: string | null }
  | PlaceMutationFailure;

type AdminPlaceParentOutcome =
  | { readonly ok: true; readonly linked: boolean }
  | { readonly ok: true; readonly removed: boolean }
  | PlaceMutationFailure;

const withPlaceService = async <A, E>(
  loaded: Awaited<ReturnType<typeof loadServer>>,
  headers: Headers,
  permission: PermissionRequest,
  operation: string,
  requestId: string,
  task: (
    service: PlaceAdminApi,
  ) => Effect.Effect<A, E, Database | CurrentActor | Authorization | RoleRepository>,
): Promise<A> => {
  const { effects, session, actor, currentActor, runtime } = loaded;

  await requireSurface(loaded, headers, operation, requestId);

  const trusted = await runtime.runApp(
    session.requirePermission(headers, permission),
    operation,
    15000,
    requestId,
  );

  return runtime.runApp(
    effects.Effect.provide(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(loaded.places.PlaceAdminService, (service) => task(service)),
      ),
      loaded.places.PlaceAdminServiceLive,
    ),
    operation,
    15000,
    requestId,
  );
};

export const adminPlacesListFn = createServerFn({ method: "GET" })
  .validator(adminPlacesListSchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();
    const { server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withPlaceService(
      loaded,
      headers,
      { resource: "food", actions: ["read"] },
      "fn/admin/places-list",
      requestId,
      (service) =>
        service.listPlaces({
          query: data.query,
          kind: data.kind,
          parentId: data.parentId,
          page: data.page,
        }),
    );
  });

export const adminPlaceDetailFn = createServerFn({ method: "GET" })
  .validator(adminPlaceDetailSchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();
    const { server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withPlaceService(
      loaded,
      headers,
      { resource: "food", actions: ["read"] },
      "fn/admin/place-detail",
      requestId,
      (service) => service.placeDetail(data.placeId),
    );
  });

export const adminCreatePlaceFn = createServerFn({ method: "POST" })
  .validator(adminCreatePlaceSchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();
    const { effects, server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withPlaceService(
      loaded,
      headers,
      { resource: "food", actions: ["update"] },
      "fn/admin/place-create",
      requestId,
      (service) =>
        effects.Effect.map(
          settlePlaceTask(
            effects,
            service.createPlace({
              kind: data.kind,
              iso3166: data.iso3166 ?? null,
              displayLatitude: data.displayLatitude ?? null,
              displayLongitude: data.displayLongitude ?? null,
              displayNote: data.displayNote ?? null,
              names: data.names,
              parentIds: data.parentIds,
            }),
          ),
          (outcome) => (outcome.ok ? { ok: true as const, place: outcome.value } : outcome),
        ),
    );
  });

export const adminUpdatePlaceFn = createServerFn({ method: "POST" })
  .validator(adminUpdatePlaceSchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();
    const { effects, server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withPlaceService(
      loaded,
      headers,
      { resource: "food", actions: ["update"] },
      "fn/admin/place-update",
      requestId,
      (service) =>
        effects.Effect.map(
          settlePlaceTask(
            effects,
            service.updatePlace(data.placeId, {
              kind: data.kind,
              iso3166: data.iso3166,
              displayLatitude: data.displayLatitude,
              displayLongitude: data.displayLongitude,
              displayNote: data.displayNote,
            }),
          ),
          (outcome) => (outcome.ok ? { ok: true as const, place: outcome.value } : outcome),
        ),
    );
  });

export const adminPlaceNamesFn = createServerFn({ method: "POST" })
  .validator(adminPlaceNamesSchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();
    const { effects, server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withPlaceService(
      loaded,
      headers,
      { resource: "food", actions: ["update"] },
      "fn/admin/place-names",
      requestId,
      (
        service: PlaceAdminApi,
      ): Effect.Effect<
        AdminPlaceNamesOutcome,
        PlaceMutationError | DatabaseError | InsufficientPermissions | TransactionFailed,
        Database | CurrentActor | Authorization | RoleRepository
      > => {
        if (data.action === "remove") {
          return effects.Effect.map(
            settlePlaceTask(effects, service.removePlaceName(data.placeId, data.nameId)),
            (outcome) =>
              outcome.ok
                ? {
                    ok: true as const,
                    removedNameId: outcome.value.removedNameId,
                    promotedNameId: outcome.value.promotedNameId,
                  }
                : outcome,
          );
        }

        return effects.Effect.map(
          settlePlaceTask(effects, service.upsertPlaceNames(data.placeId, data.names)),
          (outcome) => (outcome.ok ? { ok: true as const, names: outcome.value } : outcome),
        );
      },
    );
  });

export const adminPlaceParentFn = createServerFn({ method: "POST" })
  .validator(adminPlaceParentSchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();
    const { effects, server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withPlaceService(
      loaded,
      headers,
      { resource: "food", actions: ["update"] },
      "fn/admin/place-parent",
      requestId,
      (
        service: PlaceAdminApi,
      ): Effect.Effect<
        AdminPlaceParentOutcome,
        PlaceMutationError | DatabaseError | InsufficientPermissions | TransactionFailed,
        Database | CurrentActor | Authorization | RoleRepository
      > => {
        if (data.action === "remove") {
          return effects.Effect.map(
            settlePlaceTask(effects, service.removePlaceParent(data.placeId, data.parentPlaceId)),
            (outcome) =>
              outcome.ok ? { ok: true as const, removed: outcome.value.removed } : outcome,
          );
        }

        return effects.Effect.map(
          settlePlaceTask(effects, service.setPlaceParent(data.placeId, data.parentPlaceId)),
          (outcome) => (outcome.ok ? { ok: true as const, linked: outcome.value.linked } : outcome),
        );
      },
    );
  });

export const adminDeletePlaceFn = createServerFn({ method: "POST" })
  .validator(adminDeletePlaceSchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();
    const { effects, server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withPlaceService(
      loaded,
      headers,
      { resource: "food", actions: ["update"] },
      "fn/admin/place-delete",
      requestId,
      (service) =>
        effects.Effect.map(
          settlePlaceTask(effects, service.deletePlace(data.placeId)),
          (outcome) => (outcome.ok ? { ok: true as const, id: outcome.value.id } : outcome),
        ),
    );
  });
