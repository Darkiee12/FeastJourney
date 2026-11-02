import { Data, Effect } from "effect";
import type * as PersistenceRateLimiter from "effect/persistence/RateLimiter";
import type { ZodType } from "zod";

import type { DishProfile, DishSummary } from "@/modules/food-discovery/server/domain/dish";
import type { openApiDocument } from "@/modules/food-discovery/server/openapi";
import type { AdminService } from "@/modules/food-discovery/server/operations/admin-service";
import type {
  CatalogImportService,
  ImportApplyReport,
  ImportValidationReport,
} from "@/modules/food-discovery/server/operations/catalog-import-service";
import type {
  CatalogService,
  CategorySummary,
  CuisineSummary,
  IngredientDetail,
  IngredientSummary,
  PlaceDetail,
  PlaceSummary,
} from "@/modules/food-discovery/server/operations/catalog-service";
import type { CurationService } from "@/modules/food-discovery/server/operations/curation-service";
import {
  decodeFilterCursor,
  encodeCursor,
} from "@/modules/food-discovery/server/operations/cursor";
import type { DishService } from "@/modules/food-discovery/server/operations/dish-service";
import type { AmbiguousPlace } from "@/modules/food-discovery/server/operations/place-admin-service";
import type { PlaceRepository } from "@/modules/food-discovery/server/repository/place-repository";
import type { Authorization } from "@/modules/user/server/operations/authorization";
import type { RoleRepository } from "@/modules/user/server/repository/role-repository";
import { type Actor, Actor as ActorConstructors, describeActor } from "@/server/auth/actor";
import { withActor } from "@/server/auth/current-actor";
import type { InsufficientPermissions, SignInRequired, UserSuspended } from "@/server/auth/errors";
import type { PermissionRequest } from "@/server/auth/permissions";
import { requirePermission } from "@/server/auth/session";
import type { AppConfig } from "@/server/config";
import { appConfig } from "@/server/config";
import type { Database } from "@/server/database/client";
import type { DatabaseError } from "@/server/database/query";
import { apiErrorBody, troubleByTag } from "@/server/http/api-error";
import type { TroubleTag } from "@/server/http/api-error";
import { RateLimitPolicy } from "@/server/http/rate-limit";
import {
  corsPreflight,
  errorResponse,
  rateLimitHeaders,
  requestIdFromHeaders,
  resolveClientIdentity,
  responseHeaders,
} from "@/server/http/request";
import { RequestTimeout, withRequestTimeout } from "@/server/runtime";

type ApiRequirements =
  | PersistenceRateLimiter.RateLimiter
  | RateLimitPolicy
  | Database
  | RoleRepository
  | Authorization
  | DishService
  | CatalogService
  | PlaceRepository
  | AdminService
  | CurationService
  | CatalogImportService;

import {
  adminCategoryLinkSchema,
  adminCreateDishSchema,
  adminCuisineLinkSchema,
  adminDescriptionSchema,
  adminImportApplySchema,
  adminImportValidateSchema,
  adminIngredientLinkSchema,
  adminNameSchema,
  adminNoteSchema,
  adminPlaceLinkSchema,
  adminStatusSchema,
  adminUpdateDishSchema,
  dishDetailParamsSchema,
  dishSearchQuerySchema,
  nameSearchQuerySchema,
  placeDishesQuerySchema,
  placeQuerySchema,
  relatedQuerySchema,
  reviewQueueQuerySchema,
} from "@/modules/food-discovery/food.schema";
import { InvalidSearchFilter } from "@/modules/food-discovery/server/domain/errors";
import type {
  CatalogConflict,
  ConflictingDish,
  DishNotFound,
  IngredientNotFound,
  InvalidDishData,
  InvalidLocale,
  InvalidRelationship,
  PlaceNotFound,
  UnknownPlace,
} from "@/modules/food-discovery/server/domain/errors";
import { isDbIdString } from "@/modules/food-discovery/server/domain/ids";
import type {
  DatabaseUnavailable,
  PersistenceConflict,
  PersistenceError,
  TransactionConflict,
  TransactionFailed,
} from "@/server/database/errors";

export class InvalidJsonBody extends Data.TaggedError("InvalidJsonBody")<{
  readonly message: string;
}> {}

interface Guard {
  readonly config: AppConfig;
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly startedAt: number;
}

type ApiFailure =
  | DishNotFound
  | IngredientNotFound
  | PlaceNotFound
  | InvalidSearchFilter
  | UnknownPlace
  | AmbiguousPlace
  | InvalidLocale
  | InvalidJsonBody
  | InvalidDishData
  | InvalidRelationship
  | ConflictingDish
  | CatalogConflict
  | PersistenceConflict
  | TransactionConflict
  | SignInRequired
  | InsufficientPermissions
  | UserSuspended
  | DatabaseUnavailable
  | PersistenceError
  | TransactionFailed;

const publicDetailTags: ReadonlySet<TroubleTag> = new Set<TroubleTag>([
  "InvalidSearchFilter",
  "InvalidLocale",
  "InvalidJsonBody",
  "DishNotFound",
  "IngredientNotFound",
  "PlaceNotFound",
  "ConflictingDish",
  "InvalidDishData",
  "CatalogConflict",
]);

export const failureResponse = (request: Request, guard: Guard, failure: ApiFailure): Response => {
  const mapping = troubleByTag[failure._tag];

  const fallback =
    mapping.code === "unavailable" ? "Service temporarily unavailable." : "Request failed.";

  const message = publicDetailTags.has(failure._tag) ? failure.message || fallback : fallback;
  const response = errorResponse(request, guard.config, guard.requestId, failure._tag, message);
  response.headers.set("Server-Timing", `app;dur=${Date.now() - guard.startedAt}`);

  return response;
};

export interface PlaceHierarchyEdge {
  readonly placeId: string;
  readonly parentPlaceId: string;
}

export type ApiResponseBody =
  | { readonly status: string }
  | { readonly items: ReadonlyArray<DishSummary>; readonly next_cursor: string | null }
  | { readonly items: ReadonlyArray<DishSummary> }
  | { readonly items: ReadonlyArray<IngredientSummary> }
  | { readonly items: ReadonlyArray<PlaceSummary> }
  | { readonly items: ReadonlyArray<CategorySummary> }
  | { readonly items: ReadonlyArray<CuisineSummary> }
  | {
      readonly items: ReadonlyArray<PlaceSummary>;
      readonly hierarchy: ReadonlyArray<PlaceHierarchyEdge>;
    }
  | DishProfile
  | IngredientDetail
  | PlaceDetail
  | typeof openApiDocument
  | ImportValidationReport
  | ImportApplyReport
  | { readonly noteId: string }
  | {
      readonly items: ReadonlyArray<{
        readonly id: string;
        readonly author: string;
        readonly noteKind: string;
        readonly note: string;
        readonly createdAt: string;
      }>;
    }
  | {
      readonly items: ReadonlyArray<{
        readonly id: string;
        readonly actor: string;
        readonly operation: string;
        readonly summary: string;
        readonly createdAt: string;
      }>;
    }
  | {
      readonly items: ReadonlyArray<{
        readonly id: string;
        readonly slug: string;
        readonly status: string;
      }>;
      readonly next_cursor: string | null;
    }
  | { readonly id: string }
  | { readonly id: string; readonly status: string }
  | { readonly name: string }
  | { readonly updated: true }
  | { readonly linked: true }
  | { readonly recorded: true };

const okResponse = (
  request: Request,
  guard: Guard,
  body: ApiResponseBody,
  status = 200,
): Response => {
  const response = Response.json(body, {
    status,
    headers: responseHeaders(request, guard.config, guard.requestId),
  });

  response.headers.set("Server-Timing", `app;dur=${Date.now() - guard.startedAt}`);

  return response;
};

const logRequest = (guard: Guard, status: number): Effect.Effect<void> =>
  Effect.logInfo("api request", {
    method: guard.method,
    path: guard.path,
    status,
    durationMs: Date.now() - guard.startedAt,
    requestId: guard.requestId,
  });

const unavailableResponse = (requestId: string): Response =>
  Response.json(apiErrorBody("unavailable", "Service temporarily unavailable.", requestId), {
    status: 503,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const withGuard = <E extends ApiFailure, R>(
  request: Request,
  bucket: "public" | "search" | "admin",
  use: (guard: Guard) => Effect.Effect<Response, E, R>,
): Effect.Effect<Response, never, R | RateLimitPolicy | PersistenceRateLimiter.RateLimiter> =>
  Effect.gen(function* () {
    const config = yield* appConfig;
    const requestId = requestIdFromHeaders(request.headers);
    const url = new URL(request.url);

    const guard: Guard = {
      config,
      requestId,
      method: request.method,
      path: url.pathname,
      startedAt: Date.now(),
    };

    const preflight = corsPreflight(request, config);

    if (preflight !== null) {
      preflight.headers.set("X-Request-Id", requestId);

      return preflight;
    }

    const policy = yield* RateLimitPolicy;
    const identity = resolveClientIdentity(request, config);

    const rateLimited = yield* policy.check(bucket, identity).pipe(
      Effect.map(() => null),
      Effect.catchTag("RateLimitExceeded", (failure) =>
        Effect.succeed(
          errorResponse(
            request,
            config,
            requestId,
            "RateLimitExceeded",
            "Rate limit exceeded. Slow down and retry.",
            rateLimitHeaders(failure.retryAfterSeconds, failure.limit),
          ),
        ),
      ),
      Effect.catchTag("StoreUnavailable", () =>
        Effect.succeed(
          errorResponse(
            request,
            config,
            requestId,
            "StoreUnavailable",
            "Service temporarily unavailable.",
          ),
        ),
      ),
    );

    if (rateLimited !== null) {
      yield* logRequest(guard, rateLimited.status);

      return rateLimited;
    }

    const result = yield* withRequestTimeout(
      use(guard),
      `${bucket} ${url.pathname}`,
      config.requestTimeoutMs,
    ).pipe(
      Effect.matchEffect({
        onFailure: (failure) =>
          Effect.succeed(
            failure instanceof RequestTimeout
              ? errorResponse(
                  request,
                  config,
                  requestId,
                  "RequestTimeout",
                  "Service temporarily unavailable.",
                )
              : failureResponse(request, guard, failure),
          ),
        onSuccess: (response) => Effect.succeed(response),
      }),
    );

    yield* logRequest(guard, result.status);

    return result;
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.logError("api unhandled cause", cause).pipe(
          Effect.as(unavailableResponse(requestIdFromHeaders(request.headers))),
        ),
      onSuccess: (response) => Effect.succeed(response),
    }),
  );

const runOperation = <A, E extends ApiFailure, R>(
  guard: Guard,
  operation: string,
  actor: Actor,
  effect: Effect.Effect<A, E, R>,
  respond: (data: A) => Response,
): Effect.Effect<Response, E, R> =>
  Effect.map(
    withActor(actor, effect).pipe(Effect.annotateLogs({ requestId: guard.requestId, operation })),
    respond,
  );

const parseQuery = (request: Request) => {
  const params = new URL(request.url).searchParams;

  return {
    singles: () => {
      const output: Record<string, string> = {};
      params.forEach((value, key) => {
        if (output[key] === undefined) {
          output[key] = value;
        }
      });

      return output;
    },
    multiple: (key: string) => {
      const values = params.getAll(key);

      return values.length > 0 ? values : undefined;
    },
  };
};

const parseJsonBody = <Output>(
  request: Request,
  schema: ZodType<Output>,
): Effect.Effect<Output, InvalidJsonBody> =>
  Effect.flatMap(
    Effect.tryPromise<unknown, InvalidJsonBody>({
      try: () => request.json(),
      catch: () => new InvalidJsonBody({ message: "Request body must be valid JSON." }),
    }),
    (raw) => {
      const parsed = schema.safeParse(raw);

      return parsed.success
        ? Effect.succeed(parsed.data)
        : Effect.fail(
            new InvalidJsonBody({
              message: parsed.error.issues[0]?.message ?? "Invalid request body.",
            }),
          );
    },
  );

const invalidFilter = (message: string): Effect.Effect<never, InvalidSearchFilter> =>
  Effect.fail(new InvalidSearchFilter({ reason: message }));

export const handleHealthLive = (
  request: Request,
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "public", (guard) =>
    Effect.succeed(okResponse(request, guard, { status: "live" })),
  );

export const handleHealthReady = (
  request: Request,
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "public", (guard) =>
    Effect.gen(function* () {
      const { checkDatabaseHealth } = yield* Effect.promise(
        async () => import("@/server/database/client"),
      );

      yield* checkDatabaseHealth;

      return okResponse(request, guard, { status: "ready" });
    }),
  );

export const handleDishSearch = (
  request: Request,
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "search", (guard) =>
    Effect.gen(function* () {
      const query = parseQuery(request);

      const parsed = dishSearchQuerySchema.safeParse({
        ...query.singles(),
        ingredient: query.multiple("ingredient"),
        category: query.multiple("category"),
      });

      if (!parsed.success) {
        return yield* invalidFilter(
          parsed.error.issues[0]?.message ?? "Invalid search parameters.",
        );
      }

      const { DishService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/dish-service"),
      );

      const actor = ActorConstructors.Guest();

      return yield* runOperation(
        guard,
        "dishes/search",
        actor,
        Effect.flatMap(DishService, (service) =>
          service.searchDishes({
            q: parsed.data.q,
            locale: parsed.data.locale,
            ingredientIds: parsed.data.ingredient,
            ingredientMode: parsed.data.ingredient_mode,
            categorySlugs: parsed.data.category,
            categoryMode: parsed.data.category_mode,
            cuisine: parsed.data.cuisine,
            country: parsed.data.country,
            region: parsed.data.region,
            placeId: parsed.data.place,
            association: parsed.data.association,
            sort: parsed.data.sort,
            limit: parsed.data.limit,
            cursor: parsed.data.cursor,
          }),
        ),
        (output) => {
          const response = okResponse(request, guard, {
            items: output.items,
            next_cursor: output.nextCursor,
          });

          response.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");

          return response;
        },
      );
    }),
  );

export const handleDishDetail = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "public", (guard) =>
    Effect.gen(function* () {
      const query = parseQuery(request);
      const parsed = dishDetailParamsSchema.safeParse({ ...query.singles(), id: params.id });

      if (!parsed.success) {
        return yield* invalidFilter(parsed.error.issues[0]?.message ?? "Invalid dish parameters.");
      }

      const { DishService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/dish-service"),
      );

      const actor = ActorConstructors.Guest();

      return yield* runOperation(
        guard,
        "dishes/detail",
        actor,
        Effect.flatMap(DishService, (service) =>
          service.getDish(parsed.data.id, parsed.data.locale),
        ),
        (detail) => {
          const response = okResponse(request, guard, detail);
          response.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");

          return response;
        },
      );
    }),
  );

export const handleDishRelated = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "public", (guard) =>
    Effect.gen(function* () {
      const parsedParams = dishDetailParamsSchema.safeParse({ locale: "en", id: params.id });
      const parsedQuery = relatedQuerySchema.safeParse(parseQuery(request).singles());

      if (!parsedParams.success || !parsedQuery.success) {
        return yield* invalidFilter("Invalid dish id or query.");
      }

      const { DishService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/dish-service"),
      );

      const actor = ActorConstructors.Guest();

      return yield* runOperation(
        guard,
        "dishes/related",
        actor,
        Effect.flatMap(DishService, (service) =>
          service.getRelated(parsedParams.data.id, parsedQuery.data.locale, parsedQuery.data.limit),
        ),
        (items) => {
          const response = okResponse(request, guard, { items });
          response.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");

          return response;
        },
      );
    }),
  );

export const handleIngredientSearch = (
  request: Request,
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "search", (guard) =>
    Effect.gen(function* () {
      const parsed = nameSearchQuerySchema.safeParse(parseQuery(request).singles());

      if (!parsed.success) {
        return yield* invalidFilter(
          parsed.error.issues[0]?.message ?? "Invalid search parameters.",
        );
      }

      const { CatalogService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/catalog-service"),
      );

      const actor = ActorConstructors.Guest();

      return yield* runOperation(
        guard,
        "ingredients/search",
        actor,
        Effect.flatMap(CatalogService, (service) =>
          service.searchIngredients(parsed.data.q, parsed.data.locale, parsed.data.limit),
        ),
        (items) => okResponse(request, guard, { items }),
      );
    }),
  );

export const handleIngredientDetail = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "public", (guard) =>
    Effect.gen(function* () {
      const query = parseQuery(request);
      const parsed = dishDetailParamsSchema.safeParse({ ...query.singles(), id: params.id });

      if (!parsed.success) {
        return yield* invalidFilter(
          parsed.error.issues[0]?.message ?? "Invalid ingredient parameters.",
        );
      }

      const { CatalogService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/catalog-service"),
      );

      const actor = ActorConstructors.Guest();

      return yield* runOperation(
        guard,
        "ingredients/detail",
        actor,
        Effect.flatMap(CatalogService, (service) =>
          service.getIngredient(parsed.data.id, parsed.data.locale),
        ),
        (detail) => okResponse(request, guard, detail),
      );
    }),
  );

export const handlePlaceList = (
  request: Request,
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "public", (guard) =>
    Effect.gen(function* () {
      const query = parseQuery(request);
      const rawQ = query.singles()["q"];

      if (rawQ !== undefined && rawQ.trim().length > 0) {
        const parsed = nameSearchQuerySchema.safeParse(query.singles());

        if (!parsed.success) {
          return yield* invalidFilter(
            parsed.error.issues[0]?.message ?? "Invalid search parameters.",
          );
        }

        const { CatalogService } = yield* Effect.promise(
          async () => import("@/modules/food-discovery/server/operations/catalog-service"),
        );

        const actor = ActorConstructors.Guest();

        return yield* runOperation(
          guard,
          "places/search",
          actor,
          Effect.flatMap(CatalogService, (service) =>
            service.searchPlaces(parsed.data.q, parsed.data.locale, parsed.data.limit),
          ),
          (items) => okResponse(request, guard, { items }),
        );
      }

      const parsed = placeQuerySchema.safeParse(query);

      if (!parsed.success) {
        return yield* invalidFilter(parsed.error.issues[0]?.message ?? "Invalid place parameters.");
      }

      const [{ CatalogService }, { PlaceRepository }] = yield* Effect.promise(async () =>
        Promise.all([
          import("@/modules/food-discovery/server/operations/catalog-service"),
          import("@/modules/food-discovery/server/repository/place-repository"),
        ]),
      );

      const actor = ActorConstructors.Guest();

      return yield* runOperation(
        guard,
        "places/list",
        actor,
        Effect.all(
          [
            Effect.flatMap(CatalogService, (service) =>
              service.listPlaces(parsed.data.locale, parsed.data.limit),
            ),
            Effect.flatMap(PlaceRepository, (repository) => repository.parentEdges()),
          ],
          { concurrency: 2 },
        ),
        ([items, edges]) =>
          okResponse(request, guard, {
            items,
            hierarchy: edges.map((edge) => ({
              placeId: edge.placeId.toString(),
              parentPlaceId: edge.parentPlaceId.toString(),
            })),
          }),
      );
    }),
  );

export const handlePlaceSearch = (
  request: Request,
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "search", (guard) =>
    Effect.gen(function* () {
      const parsed = nameSearchQuerySchema.safeParse(parseQuery(request).singles());

      if (!parsed.success) {
        return yield* invalidFilter(
          parsed.error.issues[0]?.message ?? "Invalid search parameters.",
        );
      }

      const { CatalogService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/catalog-service"),
      );

      const actor = ActorConstructors.Guest();

      return yield* runOperation(
        guard,
        "places/search",
        actor,
        Effect.flatMap(CatalogService, (service) =>
          service.searchPlaces(parsed.data.q, parsed.data.locale, parsed.data.limit),
        ),
        (items) => okResponse(request, guard, { items }),
      );
    }),
  );

export const handlePlaceDishes = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "public", (guard) =>
    Effect.gen(function* () {
      const parsed = placeDishesQuerySchema.safeParse(parseQuery(request).singles());

      if (!parsed.success) {
        return yield* invalidFilter(parsed.error.issues[0]?.message ?? "Invalid place parameters.");
      }

      if (!isDbIdString(params.id)) {
        return yield* invalidFilter("place id must be a decimal id string");
      }

      const { DishService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/dish-service"),
      );

      const actor = ActorConstructors.Guest();

      return yield* runOperation(
        guard,
        "places/dishes",
        actor,
        Effect.flatMap(DishService, (service) =>
          service.searchDishes({
            locale: parsed.data.locale,
            placeId: params.id,
            association: parsed.data.association,
            limit: parsed.data.limit,
          }),
        ),
        (output) =>
          okResponse(request, guard, { items: output.items, next_cursor: output.nextCursor }),
      );
    }),
  );

export const handlePlaceDetail = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "public", (guard) =>
    Effect.gen(function* () {
      const query = parseQuery(request);
      const parsed = dishDetailParamsSchema.safeParse({ ...query.singles(), id: params.id });

      if (!parsed.success) {
        return yield* invalidFilter(parsed.error.issues[0]?.message ?? "Invalid place parameters.");
      }

      const { CatalogService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/catalog-service"),
      );

      const actor = ActorConstructors.Guest();

      return yield* runOperation(
        guard,
        "places/detail",
        actor,
        Effect.flatMap(CatalogService, (service) =>
          service.getPlace(parsed.data.id, parsed.data.locale),
        ),
        (detail) => okResponse(request, guard, detail),
      );
    }),
  );

export const handleCategories = (
  request: Request,
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "public", (guard) =>
    Effect.gen(function* () {
      const { CatalogService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/catalog-service"),
      );

      const actor = ActorConstructors.Guest();
      const locale = new URL(request.url).searchParams.get("locale") ?? "en";

      return yield* runOperation(
        guard,
        "categories/list",
        actor,
        Effect.flatMap(CatalogService, (service) => service.listCategories(locale)),
        (items) => okResponse(request, guard, { items }),
      );
    }),
  );

export const handleCuisines = (request: Request): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "public", (guard) =>
    Effect.gen(function* () {
      const { CatalogService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/catalog-service"),
      );

      const actor = ActorConstructors.Guest();
      const locale = new URL(request.url).searchParams.get("locale") ?? "en";

      return yield* runOperation(
        guard,
        "cuisines/list",
        actor,
        Effect.flatMap(CatalogService, (service) => service.listCuisines(locale)),
        (items) => okResponse(request, guard, { items }),
      );
    }),
  );

/**
 * Session-first authorization gate for catalog administration. The actor is
 * built from the verified Better Auth session and checked against current
 * database grants; no shared secret can mint an administrator identity.
 *
 * Permission mapping (least privilege, documented per handler):
 * - create draft dish ......... `food:create` (+ `food:publish` when the
 *   request publishes immediately via `status: "published"`)
 * - update dish metadata ....... `food:update` (+ `food:publish` when the
 *   request changes `status`, which governs publication visibility)
 * - status-only transitions .... `food:publish`
 * - names/descriptions/links ... `food:update`
 * - curation notes/revisions ... `food:update` (content working history)
 * - review queue ............... `moderation:read` (reviewer surface)
 * - import validate/apply ...... `food:import` (explicit bulk-write grant)
 *
 * `admin:access` is intentionally NOT required: it guards the administration
 * surface, not individual resource mutations.
 */
const withAuthorized = <E, R>(
  request: Request,
  guard: Guard,
  operation: string,
  permissions: PermissionRequest | ReadonlyArray<PermissionRequest>,
  use: (actorLabel: string, actor: Actor) => Effect.Effect<Response, E, R>,
): Effect.Effect<
  Response,
  E | SignInRequired | UserSuspended | InsufficientPermissions | DatabaseError,
  R | Database | RoleRepository | Authorization
> =>
  Effect.flatMap(requirePermission(request.headers, permissions), (trusted) => {
    const actor = ActorConstructors.Member({ userId: trusted.userId });

    return use(describeActor(actor), actor).pipe(
      Effect.annotateLogs({ requestId: guard.requestId, operation }),
    );
  });

export const handleAdminCreateDish = (
  request: Request,
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "admin", (guard) =>
    Effect.gen(function* () {
      const { AdminService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/admin-service"),
      );

      const body = yield* parseJsonBody(request, adminCreateDishSchema);

      const checks: ReadonlyArray<PermissionRequest> =
        body.status === "published"
          ? [
              { resource: "food", actions: ["create"] },
              { resource: "food", actions: ["publish"] },
            ]
          : [{ resource: "food", actions: ["create"] }];

      return yield* withAuthorized(
        request,
        guard,
        "admin/dishes/create",
        checks,
        (actorLabel, actor) =>
          Effect.gen(function* () {
            return yield* runOperation(
              guard,
              "admin/dishes/create",
              actor,
              Effect.flatMap(AdminService, (service) =>
                service.createDish(actorLabel, {
                  slug: body.slug,
                  status: body.status,
                  parentSlug: body.parent_slug,
                  names: body.names.map((entry) => ({
                    languageTag: entry.language_tag,
                    name: entry.name,
                    nameKind: entry.name_kind,
                  })),
                }),
              ),
              (created) => okResponse(request, guard, created, 201),
            );
          }),
      );
    }),
  );

export const handleAdminUpdateDishStatus = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "admin", (guard) =>
    Effect.gen(function* () {
      const { AdminService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/admin-service"),
      );

      return yield* withAuthorized(
        request,
        guard,
        "admin/dishes/status",
        { resource: "food", actions: ["publish"] },
        (actorLabel, actor) =>
          Effect.gen(function* () {
            const body = yield* parseJsonBody(request, adminStatusSchema);

            return yield* runOperation(
              guard,
              "admin/dishes/status",
              actor,
              Effect.flatMap(AdminService, (service) =>
                service.updateDishStatus(actorLabel, params.id, body.status),
              ),
              (updated) => okResponse(request, guard, updated),
            );
          }),
      );
    }),
  );

export const handleAdminAddDishName = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "admin", (guard) =>
    Effect.gen(function* () {
      const { AdminService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/admin-service"),
      );

      return yield* withAuthorized(
        request,
        guard,
        "admin/dishes/names",
        { resource: "food", actions: ["update"] },
        (actorLabel, actor) =>
          Effect.gen(function* () {
            const body = yield* parseJsonBody(request, adminNameSchema);

            return yield* runOperation(
              guard,
              "admin/dishes/names",
              actor,
              Effect.flatMap(AdminService, (service) =>
                service.addDishName(actorLabel, params.id, {
                  languageTag: body.language_tag,
                  name: body.name,
                  nameKind: body.name_kind,
                }),
              ),
              (created) => okResponse(request, guard, created, 201),
            );
          }),
      );
    }),
  );

export const handleAdminUpdateDish = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "admin", (guard) =>
    Effect.gen(function* () {
      const { AdminService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/admin-service"),
      );

      const body = yield* parseJsonBody(request, adminUpdateDishSchema);

      const checks: ReadonlyArray<PermissionRequest> =
        body.status === undefined
          ? [{ resource: "food", actions: ["update"] }]
          : [
              { resource: "food", actions: ["update"] },
              { resource: "food", actions: ["publish"] },
            ];

      return yield* withAuthorized(
        request,
        guard,
        "admin/dishes/update",
        checks,
        (actorLabel, actor) =>
          Effect.gen(function* () {
            return yield* runOperation(
              guard,
              "admin/dishes/update",
              actor,
              Effect.flatMap(AdminService, (service) =>
                service.updateDish(actorLabel, params.id, {
                  slug: body.slug,
                  status: body.status,
                  parentSlug: body.parent_slug ?? undefined,
                }),
              ),
              (updated) => okResponse(request, guard, updated),
            );
          }),
      );
    }),
  );

export const handleAdminUpsertDishDescription = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "admin", (guard) =>
    Effect.gen(function* () {
      const { AdminService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/admin-service"),
      );

      return yield* withAuthorized(
        request,
        guard,
        "admin/dishes/descriptions",
        { resource: "food", actions: ["update"] },
        (actorLabel, actor) =>
          Effect.gen(function* () {
            const body = yield* parseJsonBody(request, adminDescriptionSchema);

            return yield* runOperation(
              guard,
              "admin/dishes/descriptions",
              actor,
              Effect.flatMap(AdminService, (service) =>
                service.upsertDishDescription(
                  actorLabel,
                  params.id,
                  body.language_tag,
                  body.description,
                  body.summary,
                ),
              ),
              () => okResponse(request, guard, { updated: true }),
            );
          }),
      );
    }),
  );

export const handleAdminLinkDishIngredient = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "admin", (guard) =>
    Effect.gen(function* () {
      const { AdminService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/admin-service"),
      );

      return yield* withAuthorized(
        request,
        guard,
        "admin/dishes/ingredients",
        { resource: "food", actions: ["update"] },
        (actorLabel, actor) =>
          Effect.gen(function* () {
            const body = yield* parseJsonBody(request, adminIngredientLinkSchema);

            return yield* runOperation(
              guard,
              "admin/dishes/ingredients",
              actor,
              Effect.flatMap(AdminService, (service) =>
                service.linkDishIngredient(actorLabel, params.id, body.ingredient_id, body.role),
              ),
              () => okResponse(request, guard, { linked: true }),
            );
          }),
      );
    }),
  );

export const handleAdminLinkDishPlace = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "admin", (guard) =>
    Effect.gen(function* () {
      const { AdminService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/admin-service"),
      );

      return yield* withAuthorized(
        request,
        guard,
        "admin/dishes/places",
        { resource: "food", actions: ["update"] },
        (actorLabel, actor) =>
          Effect.gen(function* () {
            const body = yield* parseJsonBody(request, adminPlaceLinkSchema);

            return yield* runOperation(
              guard,
              "admin/dishes/places",
              actor,
              Effect.flatMap(AdminService, (service) =>
                service.linkDishPlace(
                  actorLabel,
                  params.id,
                  body.place_id,
                  body.association,
                  body.is_disputed,
                ),
              ),
              () => okResponse(request, guard, { linked: true }),
            );
          }),
      );
    }),
  );

export const handleAdminLinkDishCategory = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "admin", (guard) =>
    Effect.gen(function* () {
      const { AdminService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/admin-service"),
      );

      return yield* withAuthorized(
        request,
        guard,
        "admin/dishes/categories",
        { resource: "food", actions: ["update"] },
        (actorLabel, actor) =>
          Effect.gen(function* () {
            const body = yield* parseJsonBody(request, adminCategoryLinkSchema);

            return yield* runOperation(
              guard,
              "admin/dishes/categories",
              actor,
              Effect.flatMap(AdminService, (service) =>
                service.linkDishCategory(actorLabel, params.id, body.category_slug),
              ),
              () => okResponse(request, guard, { linked: true }),
            );
          }),
      );
    }),
  );

export const handleAdminLinkDishCuisine = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "admin", (guard) =>
    Effect.gen(function* () {
      const { AdminService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/admin-service"),
      );

      return yield* withAuthorized(
        request,
        guard,
        "admin/dishes/cuisines",
        { resource: "food", actions: ["update"] },
        (actorLabel, actor) =>
          Effect.gen(function* () {
            const body = yield* parseJsonBody(request, adminCuisineLinkSchema);

            return yield* runOperation(
              guard,
              "admin/dishes/cuisines",
              actor,
              Effect.flatMap(AdminService, (service) =>
                service.linkDishCuisine(actorLabel, params.id, body.cuisine_slug),
              ),
              () => okResponse(request, guard, { linked: true }),
            );
          }),
      );
    }),
  );

export const handleAdminAddNote = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "admin", (guard) =>
    Effect.gen(function* () {
      const { CurationService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/curation-service"),
      );

      return yield* withAuthorized(
        request,
        guard,
        "admin/dishes/notes",
        { resource: "food", actions: ["update"] },
        (actorLabel, actor) =>
          Effect.gen(function* () {
            const body = yield* parseJsonBody(request, adminNoteSchema);

            return yield* runOperation(
              guard,
              "admin/dishes/notes",
              actor,
              Effect.flatMap(CurationService, (service) =>
                service.addNote(params.id, body.author, body.note_kind, body.note),
              ),
              (created) => okResponse(request, guard, created, 201),
            );
          }),
      );
    }),
  );

export const handleAdminListNotes = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "admin", (guard) =>
    Effect.gen(function* () {
      const { CurationService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/curation-service"),
      );

      return yield* withAuthorized(
        request,
        guard,
        "admin/dishes/notes-list",
        { resource: "food", actions: ["update"] },
        (_actorLabel, actor) =>
          runOperation(
            guard,
            "admin/dishes/notes-list",
            actor,
            Effect.flatMap(CurationService, (service) => service.listNotes(params.id, 50)),
            (items) => okResponse(request, guard, { items }),
          ),
      );
    }),
  );

export const handleAdminListRevisions = (
  request: Request,
  params: { readonly id: string },
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "admin", (guard) =>
    Effect.gen(function* () {
      const { CurationService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/curation-service"),
      );

      return yield* withAuthorized(
        request,
        guard,
        "admin/dishes/revisions",
        { resource: "food", actions: ["update"] },
        (_actorLabel, actor) =>
          runOperation(
            guard,
            "admin/dishes/revisions",
            actor,
            Effect.flatMap(CurationService, (service) => service.listRevisions(params.id, 50)),
            (items) => okResponse(request, guard, { items }),
          ),
      );
    }),
  );

export const handleAdminReviewQueue = (
  request: Request,
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "admin", (guard) =>
    Effect.gen(function* () {
      const parsed = reviewQueueQuerySchema.safeParse(parseQuery(request).singles());

      if (!parsed.success) {
        return yield* invalidFilter(parsed.error.issues[0]?.message ?? "Invalid query.");
      }

      const cursor = decodeFilterCursor(parsed.data.cursor);

      if (parsed.data.cursor !== undefined && cursor === null) {
        return yield* invalidFilter("cursor is invalid");
      }

      const { CurationService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/curation-service"),
      );

      return yield* withAuthorized(
        request,
        guard,
        "admin/review-queue",
        { resource: "moderation", actions: ["read"] },
        (actorLabel, actor) =>
          runOperation(
            guard,
            "admin/review-queue",
            actor,
            Effect.flatMap(CurationService, (service) =>
              service.reviewQueue(parsed.data.limit, BigInt(cursor?.id ?? "0")),
            ),
            (items) => {
              const last = items[items.length - 1];

              const nextCursor =
                items.length >= parsed.data.limit && last !== undefined
                  ? encodeCursor({ id: last.id })
                  : null;

              return okResponse(request, guard, { items, next_cursor: nextCursor });
            },
          ),
      );
    }),
  );

export const handleAdminImportValidate = (
  request: Request,
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "admin", (guard) =>
    Effect.gen(function* () {
      const { CatalogImportService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/catalog-import-service"),
      );

      return yield* withAuthorized(
        request,
        guard,
        "admin/imports/validate",
        { resource: "food", actions: ["import"] },
        (_actorLabel, actor) =>
          Effect.gen(function* () {
            const body = yield* parseJsonBody(request, adminImportValidateSchema);

            return yield* runOperation(
              guard,
              "admin/imports/validate",
              actor,
              Effect.flatMap(CatalogImportService, (service) =>
                service.validateImport({ sourceName: body.source_name, payload: body }),
              ),
              (report) => okResponse(request, guard, report, 202),
            );
          }),
      );
    }),
  );

export const handleAdminImportApply = (
  request: Request,
): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "admin", (guard) =>
    Effect.gen(function* () {
      const { CatalogImportService } = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/operations/catalog-import-service"),
      );

      return yield* withAuthorized(
        request,
        guard,
        "admin/imports/apply",
        { resource: "food", actions: ["import"] },
        (_actorLabel, actor) =>
          Effect.gen(function* () {
            const body = yield* parseJsonBody(request, adminImportApplySchema);

            const actorUserId = ActorConstructors.$match(actor, {
              Guest: () => _actorLabel,
              Member: ({ userId }) => userId,
            });

            return yield* runOperation(
              guard,
              "admin/imports/apply",
              actor,
              Effect.flatMap(CatalogImportService, (service) =>
                service.applyImport({
                  jobId: body.job_id,
                  approvals: {
                    licenseAck: body.approvals.license_ack,
                    reviewAck: body.approvals.review_ack,
                    duplicateRefs: body.approvals.duplicate_refs,
                  },
                  actorUserId,
                }),
              ),
              (report) => okResponse(request, guard, report),
            );
          }),
      );
    }),
  );

export const handleOpenApi = (request: Request): Effect.Effect<Response, never, ApiRequirements> =>
  withGuard(request, "public", (guard) =>
    Effect.gen(function* () {
      const document = yield* Effect.promise(
        async () => import("@/modules/food-discovery/server/openapi"),
      ).pipe(Effect.map((module) => module.openApiDocument));

      return okResponse(request, guard, document);
    }),
  );
