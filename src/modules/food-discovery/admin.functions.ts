import { createServerFn } from "@tanstack/react-start";
import type { Effect } from "effect";
import type * as EffectModule from "effect";
import { z } from "zod";

import {
  adminBulkPublishJobSchema,
  adminBulkPublishSchema,
  adminBulkReviewCandidatesSchema,
  adminDishesQuerySchema,
  adminImportApplyBatchSchema,
  adminImportApplySchema,
  adminImportBeginSchema,
  adminImportIssuesQuerySchema,
  adminImportStageBatchSchema,
  adminImportUploadSchema,
  adminJobQuerySchema,
  adminReviewsQuerySchema,
  adminUpdateDishDescriptionsSchema,
  adminUpdateDishFieldsSchema,
  adminUpdateDishIngredientsSchema,
  adminUpdateDishNamesSchema,
  adminUpdateDishPlacesSchema,
  adminUpdateDishTaxonomySchema,
  csvToRecords,
  jsonToRecords,
  MAX_IMPORT_FILE_BYTES,
  needsLicenseReview,
} from "@/modules/food-discovery/admin.schema";
import { localeSchema } from "@/modules/food-discovery/food.schema";
import type {
  AdminServiceApi,
  AdminServiceError,
} from "@/modules/food-discovery/server/operations/admin-service";
import type {
  DishMediaError,
  DishMediaRepository,
  DishMediaServiceApi,
  DishMediaStorage,
} from "@/modules/food-discovery/server/operations/dish-media-service";
import type * as AuthorizationModule from "@/modules/user/server/operations/authorization";
import type { Authorization } from "@/modules/user/server/operations/authorization";
import type { RoleRepository } from "@/modules/user/server/repository/role-repository";
import type * as ActorModule from "@/server/auth/actor";
import type { CurrentActor } from "@/server/auth/current-actor";
import { InsufficientPermissions } from "@/server/auth/errors";
import type { SignInRequired, UserSuspended } from "@/server/auth/errors";
import type { PermissionRequest } from "@/server/auth/permissions";
import type * as SessionModule from "@/server/auth/session";
import type { Database } from "@/server/database/client";
import type {
  DatabaseUnavailable,
  PersistenceConflict,
  PersistenceError,
  TransactionConflict,
  TransactionFailed,
} from "@/server/database/errors";
import type { DatabaseError } from "@/server/database/query";
import type * as RuntimeModule from "@/server/runtime";
import { formatFileSize } from "@/shared/format-file-size";

/**
 * Food-discovery administration transport: dashboard stats, dish curation
 * lists, review queue, and the dataset import studio.
 *
 * Every handler resolves the actor from the verified session and enforces
 * current database grants at the server boundary. Route guards are
 * navigation hints only; these checks are the real authorization.
 *
 * Surface rule: the caller must hold at least one of `admin:access`,
 * `food:import`, or `moderation:read`. Each operation then enforces its
 * own resource permission (`food:read`, `moderation:read`, `food:import`).
 * Import mutations never run without `food:import`.
 */
const loadServer = async () => {
  const [
    effects,
    server,
    dashboard,
    authorization,
    session,
    actor,
    currentActor,
    runtime,
    bulkPublish,
  ] = await Promise.all([
    import("effect"),
    import("@tanstack/react-start/server"),
    import("@/modules/food-discovery/server/operations/admin-dashboard-service"),
    import("@/modules/user/server/operations/authorization"),
    import("@/server/auth/session"),
    import("@/server/auth/actor"),
    import("@/server/auth/current-actor"),
    import("@/server/runtime"),
    import("@/modules/food-discovery/server/operations/bulk-publish-service"),
  ]);

  return {
    effects,
    server,
    dashboard,
    authorization,
    session,
    actor,
    currentActor,
    runtime,
    bulkPublish,
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

const adminImportApplyWithApprovalsSchema = adminImportApplySchema.extend({
  approvals: z.object({
    licenseAck: z.boolean(),
    reviewAck: z.boolean(),
    duplicateRefs: z.array(z.string().min(1).max(300)),
  }),
});

const adminDishStatusUpdateSchema = z.object({
  dishId: z.string().regex(/^[0-9]+$/, "dish id must be a decimal id string"),
  status: z.enum(["draft", "review", "published", "archived"]),
});

const adminPublicationCheckSchema = z.object({
  dishId: z.string().regex(/^[0-9]+$/, "dish id must be a decimal id string"),
});

export const adminSurfaceFn = createServerFn({ method: "GET" }).handler(async () => {
  const loaded = await loadServer();
  const { server } = loaded;

  const headers = server.getRequestHeaders();
  const requestId = crypto.randomUUID();

  return requireSurface(loaded, headers, "fn/admin/surface", requestId).then(
    () => ({ allowed: true as const }),
    () => ({ allowed: false as const }),
  );
});

export const adminDashboardStatsFn = createServerFn({ method: "GET" }).handler(async () => {
  const loaded = await loadServer();

  const {
    effects,
    server,
    dashboard: { AdminDashboardService },
    session,
    actor,
    currentActor,
    runtime,
  } = loaded;

  const headers = server.getRequestHeaders();
  const requestId = crypto.randomUUID();

  await requireSurface(loaded, headers, "fn/admin/dashboard", requestId);

  const trusted = await runtime.runApp(
    session.requirePermission(headers, { resource: "food", actions: ["read"] }),
    "fn/admin/dashboard",
    15000,
    requestId,
  );

  return runtime.runApp(
    currentActor.withActor(
      actor.Actor.Member({ userId: trusted.userId }),
      effects.Effect.flatMap(AdminDashboardService, (service) => service.dashboardStats()),
    ),
    "fn/admin/dashboard",
    15000,
    requestId,
  );
});

export const adminDishesListFn = createServerFn({ method: "GET" })
  .validator(adminDishesQuerySchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();

    const {
      effects,
      server,
      dashboard: { AdminDashboardService },
      session,
      actor,
      currentActor,
      runtime,
    } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/dishes", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "food", actions: ["read"] }),
      "fn/admin/dishes",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(AdminDashboardService, (service) =>
          service.listDishes(data.status, BigInt(data.cursor), data.limit),
        ),
      ),
      "fn/admin/dishes",
      15000,
      requestId,
    );
  });

const dishDetailQuerySchema = z.object({
  dishId: z.string().min(1).max(200),
  locale: localeSchema,
});

export const adminDishDetailFn = createServerFn({ method: "GET" })
  .validator(dishDetailQuerySchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();

    const {
      effects,
      server,
      dashboard: { AdminDashboardService },
      session,
      actor,
      currentActor,
      runtime,
    } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/dish-detail", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "food", actions: ["read"] }),
      "fn/admin/dish-detail",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(AdminDashboardService, (service) =>
          service.dishDetail(data.dishId, data.locale),
        ),
      ),
      "fn/admin/dish-detail",
      15000,
      requestId,
    );
  });

const dishRevisionHistoryQuerySchema = z.object({
  dishId: z.string().regex(/^[0-9]+$/, "dish id must be a decimal id string"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(500).nullable().default(null),
});

/**
 * Dish-detail revision history page. The initial detail loader carries the
 * dish and notes only; revision history pages load separately through this
 * function so long timelines never block the first paint. Every call
 * rechecks `food:read` against current database grants at the server
 * boundary, and the keyset cursor is validated before it reaches SQL.
 */
export const adminDishRevisionHistoryFn = createServerFn({ method: "GET" })
  .validator(dishRevisionHistoryQuerySchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();

    const {
      effects,
      server,
      dashboard: { AdminDashboardService },
      session,
      actor,
      currentActor,
      runtime,
    } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/dish-revision-history", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "food", actions: ["read"] }),
      "fn/admin/dish-revision-history",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(AdminDashboardService, (service) =>
          service.dishRevisionHistory(data.dishId, { limit: data.limit, cursor: data.cursor }),
        ),
      ),
      "fn/admin/dish-revision-history",
      15000,
      requestId,
    );
  });

export const adminReviewQueueFn = createServerFn({ method: "GET" })
  .validator(adminReviewsQuerySchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();

    const {
      effects,
      server,
      dashboard: { AdminDashboardService },
      session,
      actor,
      currentActor,
      runtime,
    } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/reviews", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "moderation", actions: ["read"] }),
      "fn/admin/reviews",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(AdminDashboardService, (service) =>
          service.reviewQueue(data.limit, BigInt(data.cursor)),
        ),
      ),
      "fn/admin/reviews",
      15000,
      requestId,
    );
  });

export const adminImportJobsFn = createServerFn({ method: "GET" })
  .validator(
    z.object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  )
  .handler(async ({ data }) => {
    const loaded = await loadServer();

    const {
      effects,
      server,
      dashboard: { AdminDashboardService },
      session,
      actor,
      currentActor,
      runtime,
    } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/import-jobs", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "food", actions: ["import"] }),
      "fn/admin/import-jobs",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(AdminDashboardService, (service) =>
          service.importJobs(data.limit, data.offset),
        ),
      ),
      "fn/admin/import-jobs",
      15000,
      requestId,
    );
  });

export const adminImportJobDetailFn = createServerFn({ method: "GET" })
  .validator(adminJobQuerySchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();

    const {
      effects,
      server,
      dashboard: { AdminDashboardService },
      session,
      actor,
      currentActor,
      runtime,
    } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/import-job", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "food", actions: ["import"] }),
      "fn/admin/import-job",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(AdminDashboardService, (service) =>
          service.importJobDetail(data.jobId, data.recordLimit),
        ),
      ),
      "fn/admin/import-job",
      15000,
      requestId,
    );
  });

export const adminImportValidateFn = createServerFn({ method: "POST" })
  .validator(adminImportUploadSchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();

    const {
      effects,
      server,
      dashboard: { AdminDashboardService },
      session,
      actor,
      currentActor,
      runtime,
    } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/import-validate", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "food", actions: ["import"] }),
      "fn/admin/import-validate",
      15000,
      requestId,
    );

    let records: Array<unknown>;

    const contentBytes = Buffer.byteLength(data.contentText, "utf8");

    if (contentBytes > MAX_IMPORT_FILE_BYTES) {
      return {
        ok: false as const,
        reason: `file is ${formatFileSize(contentBytes)} (${contentBytes} bytes); the maximum allowed size is ${formatFileSize(MAX_IMPORT_FILE_BYTES)}`,
      };
    }

    try {
      const parsed =
        data.fileType === "json" ? jsonToRecords(data.contentText) : csvToRecords(data.contentText);

      // Single-shot legacy bound: this path stages the whole payload in one
      // transaction, so it stays capped at one batch. Larger datasets use
      // the batched protocol (begin + stage batches), which has no
      // per-dataset cap below MAX_BATCHED_IMPORT_RECORDS.
      if (parsed.length > 100) {
        return {
          ok: false as const,
          reason: `dataset has ${parsed.length} records; single-shot validation holds at most 100 per call. Use the batched upload (begin the import, then send stage batches of 100) for larger datasets`,
        };
      }

      records = parsed;
    } catch (error) {
      return {
        ok: false as const,
        reason: error instanceof Error ? error.message : "could not parse dataset file",
      };
    }

    const licenseReview = needsLicenseReview(data.sourceId, data.license);

    return runtime
      .runApp(
        currentActor.withActor(
          actor.Actor.Member({ userId: trusted.userId }),
          effects.Effect.flatMap(AdminDashboardService, (service) =>
            service.validateImport({
              sourceName: data.sourceName,
              payload: { source_name: data.sourceName, records },
              format: data.fileType,
              sourceUrl: data.sourceUrl ?? null,
              sourceVersion: data.sourceVersion ?? null,
              license: `${data.sourceId}:${data.license}`,
              attribution: data.attribution ?? null,
              editorialNotes: data.editorialNotes ?? null,
            }),
          ).pipe(
            effects.Effect.map((report) => ({
              ok: true as const,
              report,
              licenseReview,
            })),
            effects.Effect.catchTag("InvalidDishData", (failure) =>
              effects.Effect.succeed({ ok: false as const, reason: failure.reason }),
            ),
          ),
        ),
        "fn/admin/import-validate",
        60000,
        requestId,
      )
      .then((outcome) => outcome);
  });

export const adminImportApplyFn = createServerFn({ method: "POST" })
  .validator(adminImportApplyWithApprovalsSchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();

    const {
      effects,
      server,
      dashboard: { AdminDashboardService },
      session,
      actor,
      currentActor,
      runtime,
    } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/import-apply", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "food", actions: ["import"] }),
      "fn/admin/import-apply",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(AdminDashboardService, (service) =>
          service.applyImport({
            jobId: data.jobId,
            approvals: {
              licenseAck: data.approvals.licenseAck,
              reviewAck: data.approvals.reviewAck,
              duplicateRefs: data.approvals.duplicateRefs,
            },
            actorUserId: trusted.userId,
          }),
        ),
      ),
      "fn/admin/import-apply",
      60000,
      requestId,
    );
  });

/**
 * Batched import transport: one logical job id, one provenance row, one
 * review/apply flow for datasets up to MAX_BATCHED_IMPORT_RECORDS. The
 * client parses the file locally and drives the cursor forward:
 * begin → stage batches (baseIndex 0, 100, …) until complete → review →
 * apply batches until done → paginated issues for review. The full file is
 * never resent; every call is bounded (≤100 records) for the 60 s budget.
 */
const loadImportServer = async () => {
  const [effects, server, imports, authorization, session, actor, currentActor, runtime] =
    await Promise.all([
      import("effect"),
      import("@tanstack/react-start/server"),
      import("@/modules/food-discovery/server/operations/catalog-import-service"),
      import("@/modules/user/server/operations/authorization"),
      import("@/server/auth/session"),
      import("@/server/auth/actor"),
      import("@/server/auth/current-actor"),
      import("@/server/runtime"),
    ]);

  return { effects, server, imports, authorization, session, actor, currentActor, runtime };
};

export const adminImportBeginFn = createServerFn({ method: "POST" })
  .validator(adminImportBeginSchema)
  .handler(async ({ data }) => {
    const loaded = await loadImportServer();
    const { effects, server, imports, session, actor, currentActor, runtime } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/import-begin", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "food", actions: ["import"] }),
      "fn/admin/import-begin",
      15000,
      requestId,
    );

    // Reserve ONE logical job for the declared total. Provenance uses the
    // same `<sourceId>:<license>` convention as the single-shot path, so
    // review/apply gates behave identically once staging completes.
    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(imports.CatalogImportService, (service) =>
          service.beginImport({
            sourceName: data.sourceName,
            format: data.fileType,
            totalRecords: data.totalRecords,
            sourceUrl: data.sourceUrl ?? null,
            sourceVersion: data.sourceVersion ?? null,
            license: `${data.sourceId}:${data.license}`,
            attribution: data.attribution ?? null,
            editorialNotes: data.editorialNotes ?? null,
          }),
        ),
      ),
      "fn/admin/import-begin",
      15000,
      requestId,
    );
  });

export const adminImportStageBatchFn = createServerFn({ method: "POST" })
  .validator(adminImportStageBatchSchema)
  .handler(async ({ data }) => {
    const loaded = await loadImportServer();
    const { effects, server, imports, session, actor, currentActor, runtime } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/import-stage-batch", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "food", actions: ["import"] }),
      "fn/admin/import-stage-batch",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(imports.CatalogImportService, (service) =>
          service.stageImportBatch({
            jobId: data.jobId,
            baseIndex: data.baseIndex,
            records: data.records,
          }),
        ),
      ),
      "fn/admin/import-stage-batch",
      60000,
      requestId,
    );
  });

export const adminImportApplyBatchFn = createServerFn({ method: "POST" })
  .validator(adminImportApplyBatchSchema)
  .handler(async ({ data }) => {
    const loaded = await loadImportServer();
    const { effects, server, imports, session, actor, currentActor, runtime } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/import-apply-batch", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "food", actions: ["import"] }),
      "fn/admin/import-apply-batch",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(imports.CatalogImportService, (service) =>
          service.applyImportBatch({
            jobId: data.jobId,
            approvals: {
              licenseAck: data.approvals.licenseAck,
              reviewAck: data.approvals.reviewAck,
              duplicateRefs: data.approvals.duplicateRefs,
            },
            actorUserId: trusted.userId,
            limit: data.limit,
          }),
        ),
      ),
      "fn/admin/import-apply-batch",
      60000,
      requestId,
    );
  });

export const adminImportJobIssuesFn = createServerFn({ method: "GET" })
  .validator(adminImportIssuesQuerySchema)
  .handler(async ({ data }) => {
    const loaded = await loadImportServer();
    const { effects, server, imports, session, actor, currentActor, runtime } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/import-issues", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "food", actions: ["import"] }),
      "fn/admin/import-issues",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(imports.CatalogImportService, (service) =>
          service.importJobIssues({
            jobId: data.jobId,
            status: data.status,
            limit: data.limit,
            cursor: data.cursor,
          }),
        ),
      ),
      "fn/admin/import-issues",
      15000,
      requestId,
    );
  });

/**
 * Bulk editorial publish transport. Candidates require `moderation:read`
 * (same as the review queue); publishing requires `food:publish`.
 * Every call is bounded (≤100 candidates, ≤50 publishes) for the 60 s
 * budget; the client pages with the returned cursor until it is null.
 * The service layer (not this transport) owns idempotency: re-running
 * the same ids yields `skipped`, never a double publish.
 */
export const adminBulkReviewCandidatesFn = createServerFn({ method: "GET" })
  .validator(adminBulkReviewCandidatesSchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();

    const {
      effects,
      server,
      bulkPublish: { BulkPublishService, BulkPublishServiceLive },
      session,
      actor,
      currentActor,
      runtime,
    } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/bulk-review-candidates", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "moderation", actions: ["read"] }),
      "fn/admin/bulk-review-candidates",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(BulkPublishService, (service) =>
          service.listReviewCandidates({
            cursor: BigInt(data.cursor),
            limit: data.limit,
            jobId: data.jobId === null || data.jobId === undefined ? null : BigInt(data.jobId),
          }),
        ).pipe(effects.Effect.provide(BulkPublishServiceLive)),
      ),
      "fn/admin/bulk-review-candidates",
      15000,
      requestId,
    );
  });

export const adminBulkPublishFn = createServerFn({ method: "POST" })
  .validator(adminBulkPublishSchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();

    const {
      effects,
      server,
      bulkPublish: { BulkPublishService, BulkPublishServiceLive },
      session,
      actor,
      currentActor,
      runtime,
    } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/bulk-publish", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "food", actions: ["publish"] }),
      "fn/admin/bulk-publish",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(BulkPublishService, (service) =>
          service.publishBatch({
            actor: `admin:${trusted.userId}`,
            ids: data.ids,
            acks: data.acks,
          }),
        ).pipe(effects.Effect.provide(BulkPublishServiceLive)),
      ),
      "fn/admin/bulk-publish",
      60000,
      requestId,
    );
  });

export const adminBulkPublishJobFn = createServerFn({ method: "POST" })
  .validator(adminBulkPublishJobSchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();

    const {
      effects,
      server,
      bulkPublish: { BulkPublishService, BulkPublishServiceLive },
      session,
      actor,
      currentActor,
      runtime,
    } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/bulk-publish-job", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "food", actions: ["publish"] }),
      "fn/admin/bulk-publish-job",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(BulkPublishService, (service) =>
          service.publishImportJobBatch({
            actor: `admin:${trusted.userId}`,
            jobId: data.jobId,
            cursor: BigInt(data.cursor),
            limit: data.limit,
            acks: data.acks,
          }),
        ).pipe(effects.Effect.provide(BulkPublishServiceLive)),
      ),
      "fn/admin/bulk-publish-job",
      60000,
      requestId,
    );
  });

export const adminUpdateDishStatusFn = createServerFn({ method: "POST" })
  .validator(adminDishStatusUpdateSchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();

    const {
      effects,
      server,
      dashboard: { AdminDashboardService },
      session,
      actor,
      currentActor,
      runtime,
    } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/dish-status", requestId);

    const permission: PermissionRequest = { resource: "food", actions: ["publish"] };

    const trusted = await runtime.runApp(
      session.requirePermission(headers, permission),
      "fn/admin/dish-status",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(AdminDashboardService, (service) =>
          service.publishDish(trusted.userId, data.dishId, data.status),
        ),
      ),
      "fn/admin/dish-status",
      15000,
      requestId,
    );
  });

const loadMediaServer = async () => {
  const [effects, server, media, authorization, session, actor, currentActor, runtime] =
    await Promise.all([
      import("effect"),
      import("@tanstack/react-start/server"),
      import("@/modules/food-discovery/server/operations/dish-media-service"),
      import("@/modules/user/server/operations/authorization"),
      import("@/server/auth/session"),
      import("@/server/auth/actor"),
      import("@/server/auth/current-actor"),
      import("@/server/runtime"),
    ]);

  return { effects, server, media, authorization, session, actor, currentActor, runtime };
};

const dishMediaIdSchema = z.object({
  mediaId: z.string().regex(/^[0-9]+$/, "photo id must be a decimal id string"),
});

const dishMediaDishSchema = z.object({
  dishId: z.string().regex(/^[0-9]+$/, "dish id must be a decimal id string"),
});

const dishMediaFocalSchema = z.number().min(0).max(1).nullable().default(null);

const dishMediaMetadataFields = {
  altText: z.string().trim().max(500).nullable().default(null),
  attribution: z.string().trim().max(500).nullable().default(null),
  license: z.string().min(1).max(60),
  focalX: dishMediaFocalSchema,
  focalY: dishMediaFocalSchema,
  sourceUrl: z.string().trim().max(2000).nullable().default(null),
};

const dishMediaStageSchema = z.object({
  dishId: z.string().regex(/^[0-9]+$/, "dish id must be a decimal id string"),
  filename: z.string().min(1).max(255),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  dataBase64: z.string().min(1).max(12_000_000),
  makePrimary: z.boolean().default(false),
  ...dishMediaMetadataFields,
});

const dishMediaMetadataSchema = z
  .object({ mediaId: dishMediaIdSchema.shape.mediaId, ...dishMediaMetadataFields })
  .strict();

const dishMediaReorderSchema = z.object({
  dishId: z.string().regex(/^[0-9]+$/, "dish id must be a decimal id string"),
  orderedIds: z
    .array(z.string().regex(/^[0-9]+$/))
    .min(1)
    .max(5),
});

type PhotoResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: string };

/**
 * Maps expected photo-domain failures to client-safe outcomes. Database,
 * permission, transaction, and session failures are not caught here: they
 * propagate as server-function errors (5xx/4xx) instead of masquerading as
 * photo reasons.
 */
const settlePhotoTask = <A, R>(
  effects: typeof EffectModule,
  task: Effect.Effect<A, DishMediaError, R>,
): Effect.Effect<PhotoResult<A>, DatabaseError | InsufficientPermissions | TransactionFailed, R> =>
  task.pipe(
    effects.Effect.map((value) => ({ ok: true as const, value })),
    effects.Effect.catchTags({
      DishMediaNotFound: () =>
        effects.Effect.succeed({ ok: false as const, reason: "photo not found" }),
      DishNotFound: () => effects.Effect.succeed({ ok: false as const, reason: "dish not found" }),
      DishMediaValidationFailed: (failure) =>
        effects.Effect.succeed({ ok: false as const, reason: failure.reason }),
      DishMediaConflict: (failure) =>
        effects.Effect.succeed({ ok: false as const, reason: failure.reason }),
      DishMediaLimitExceeded: () =>
        effects.Effect.succeed({
          ok: false as const,
          reason: "this dish already has the maximum of 5 photos",
        }),
      DishMediaPublishBlocked: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          reason:
            failure.reasons.length > 0 ? failure.reasons.join("; ") : "photo cannot be published",
        }),
      DishMediaStorageFailed: () =>
        effects.Effect.succeed({
          ok: false as const,
          reason: "photo storage failed; try again",
        }),
      DishMediaStorageMisconfigured: () =>
        effects.Effect.succeed({
          ok: false as const,
          reason: "photo storage is not configured",
        }),
    }),
  );

const withDishMediaService = async <A>(
  loaded: Awaited<ReturnType<typeof loadMediaServer>>,
  headers: Headers,
  permission: PermissionRequest,
  operation: string,
  requestId: string,
  task: (
    service: DishMediaServiceApi,
  ) => Effect.Effect<
    A,
    DishMediaError,
    | Database
    | DishMediaRepository
    | DishMediaStorage
    | CurrentActor
    | Authorization
    | RoleRepository
  >,
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
        effects.Effect.flatMap(loaded.media.DishMediaService, (service) => task(service)),
      ),
      loaded.media.DishMediaFullLive,
    ),
    operation,
    60000,
    requestId,
  );
};

export const listDishPhotosFn = createServerFn({ method: "GET" })
  .validator(dishMediaDishSchema)
  .handler(async ({ data }) => {
    const loaded = await loadMediaServer();
    const { server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withDishMediaService(
      loaded,
      headers,
      { resource: "food", actions: ["read"] },
      "fn/admin/dish-photos",
      requestId,
      (service) => service.listForAdmin(data.dishId),
    );
  });

export const stageDishPhotoFn = createServerFn({ method: "POST" })
  .validator(dishMediaStageSchema)
  .handler(async ({ data }) => {
    const loaded = await loadMediaServer();
    const { effects, server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    let bytes: Uint8Array;

    try {
      bytes = new Uint8Array(Buffer.from(data.dataBase64, "base64"));
    } catch {
      return { ok: false as const, reason: "upload payload is not valid base64" };
    }

    if (bytes.byteLength === 0 || bytes.byteLength > 12_000_000) {
      return { ok: false as const, reason: "upload payload has an unexpected size" };
    }

    return withDishMediaService(
      loaded,
      headers,
      { resource: "food", actions: ["import"] },
      "fn/admin/dish-photo-stage",
      requestId,
      (service) =>
        effects.Effect.map(
          settlePhotoTask(
            effects,
            service.stagePhoto({
              dishId: data.dishId,
              bytes,
              filename: data.filename,
              altText: data.altText,
              attribution: data.attribution,
              license: data.license,
              focalX: data.focalX,
              focalY: data.focalY,
              sourceUrl: data.sourceUrl,
              makePrimary: data.makePrimary,
            }),
          ),
          (outcome) => (outcome.ok ? { ok: true as const, photo: outcome.value } : outcome),
        ),
    );
  });

export const updateDishPhotoMetadataFn = createServerFn({ method: "POST" })
  .validator(dishMediaMetadataSchema)
  .handler(async ({ data }) => {
    const loaded = await loadMediaServer();
    const { effects, server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withDishMediaService(
      loaded,
      headers,
      { resource: "food", actions: ["import"] },
      "fn/admin/dish-photo-metadata",
      requestId,
      (service) =>
        effects.Effect.map(
          settlePhotoTask(
            effects,
            service.updateMetadata({
              mediaId: data.mediaId,
              altText: data.altText,
              attribution: data.attribution,
              license: data.license,
              focalX: data.focalX,
              focalY: data.focalY,
              sourceUrl: data.sourceUrl,
            }),
          ),
          (outcome) => (outcome.ok ? { ok: true as const, photo: outcome.value } : outcome),
        ),
    );
  });

export const reorderDishPhotosFn = createServerFn({ method: "POST" })
  .validator(dishMediaReorderSchema)
  .handler(async ({ data }) => {
    const loaded = await loadMediaServer();
    const { effects, server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withDishMediaService(
      loaded,
      headers,
      { resource: "food", actions: ["import"] },
      "fn/admin/dish-photos-reorder",
      requestId,
      (service) =>
        effects.Effect.map(
          settlePhotoTask(
            effects,
            service.reorderPhotos({ dishId: data.dishId, orderedIds: data.orderedIds }),
          ),
          (outcome) => (outcome.ok ? { ok: true as const, photos: outcome.value } : outcome),
        ),
    );
  });

export const submitDishPhotoForReviewFn = createServerFn({ method: "POST" })
  .validator(dishMediaIdSchema)
  .handler(async ({ data }) => {
    const loaded = await loadMediaServer();
    const { effects, server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withDishMediaService(
      loaded,
      headers,
      { resource: "food", actions: ["import"] },
      "fn/admin/dish-photo-review",
      requestId,
      (service) =>
        effects.Effect.map(
          settlePhotoTask(effects, service.submitForReview(data.mediaId)),
          (outcome) => (outcome.ok ? { ok: true as const, photo: outcome.value } : outcome),
        ),
    );
  });

export const publishDishPhotoFn = createServerFn({ method: "POST" })
  .validator(dishMediaIdSchema)
  .handler(async ({ data }) => {
    const loaded = await loadMediaServer();
    const { effects, server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withDishMediaService(
      loaded,
      headers,
      { resource: "food", actions: ["publish"] },
      "fn/admin/dish-photo-publish",
      requestId,
      (service) =>
        effects.Effect.map(
          settlePhotoTask(effects, service.publishPhoto(data.mediaId)),
          (outcome) => (outcome.ok ? { ok: true as const, photo: outcome.value } : outcome),
        ),
    );
  });

export const returnDishPhotoToDraftFn = createServerFn({ method: "POST" })
  .validator(dishMediaIdSchema)
  .handler(async ({ data }) => {
    const loaded = await loadMediaServer();
    const { effects, server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withDishMediaService(
      loaded,
      headers,
      { resource: "food", actions: ["import"] },
      "fn/admin/dish-photo-draft",
      requestId,
      (service) =>
        effects.Effect.map(
          settlePhotoTask(effects, service.returnToDraft(data.mediaId)),
          (outcome) => (outcome.ok ? { ok: true as const, photo: outcome.value } : outcome),
        ),
    );
  });

export const removeDishPhotoFn = createServerFn({ method: "POST" })
  .validator(dishMediaIdSchema)
  .handler(async ({ data }) => {
    const loaded = await loadMediaServer();
    const { effects, server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withDishMediaService(
      loaded,
      headers,
      { resource: "food", actions: ["import"] },
      "fn/admin/dish-photo-delete",
      requestId,
      (service) =>
        effects.Effect.map(
          settlePhotoTask(effects, service.removePhoto(data.mediaId)),
          (outcome) => (outcome.ok ? { ok: true as const, deleted: outcome.value } : outcome),
        ),
    );
  });

export const adminPublicationCheckFn = createServerFn({ method: "GET" })
  .validator(adminPublicationCheckSchema)
  .handler(async ({ data }) => {
    const loaded = await loadServer();

    const {
      effects,
      server,
      dashboard: { AdminDashboardService },
      session,
      actor,
      currentActor,
      runtime,
    } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await requireSurface(loaded, headers, "fn/admin/publication-check", requestId);

    const trusted = await runtime.runApp(
      session.requirePermission(headers, { resource: "food", actions: ["read"] }),
      "fn/admin/publication-check",
      15000,
      requestId,
    );

    return runtime.runApp(
      currentActor.withActor(
        actor.Actor.Member({ userId: trusted.userId }),
        effects.Effect.flatMap(AdminDashboardService, (service) =>
          service.publicationCheck(data.dishId),
        ),
      ),
      "fn/admin/publication-check",
      15000,
      requestId,
    );
  });

/**
 * Dish-editing transport: curator updates to slug/parent/status, names,
 * descriptions, ingredients, taxonomy, and place links.
 *
 * Every mutation enforces `food:update` at the server boundary; a status
 * transition to `published` additionally requires `food:publish`, exactly
 * like the dish-status endpoint. Route guards are navigation hints only;
 * these checks are the real authorization.
 *
 * Update shapes use explicit `{ upsert, remove }` semantics: upsert entries
 * carry record ids for in-place edits (an edit never inserts a duplicate),
 * removals name the records to delete (never delete-and-recreate the dish).
 * Dish-place upserts always carry the full link state: an omitted
 * `association` defaults to `associated` (origin claims must be explicit),
 * an omitted `isDisputed` resets to false, and an omitted `note` clears the
 * stored note. The `(dish_id, place_id)` pair is the link key: changing
 * association/disputed/note updates the row in place.
 */
const loadDishAdminServer = async () => {
  const [effects, server, dishes, authorization, session, actor, currentActor, runtime] =
    await Promise.all([
      import("effect"),
      import("@tanstack/react-start/server"),
      import("@/modules/food-discovery/server/operations/admin-service"),
      import("@/modules/user/server/operations/authorization"),
      import("@/server/auth/session"),
      import("@/server/auth/actor"),
      import("@/server/auth/current-actor"),
      import("@/server/runtime"),
    ]);

  return { effects, server, dishes, authorization, session, actor, currentActor, runtime };
};

const dishUpdatePermissions = (status: string | undefined): ReadonlyArray<PermissionRequest> =>
  status === "published"
    ? [
        { resource: "food", actions: ["update"] },
        { resource: "food", actions: ["publish"] },
      ]
    : [{ resource: "food", actions: ["update"] }];

/**
 * Client-safe dish-edit failure codes. Every code maps to one copy string
 * on the client via an exhaustive switch — no runtime error sniffing.
 * Infrastructure failures (database, transactions) are not settled here;
 * they propagate as server-function errors and surface the generic message.
 */
export type DishEditFailureCode =
  | "unknown_place"
  | "ambiguous_place"
  | "invalid_reference"
  | "conflict"
  | "forbidden"
  | "not_found";

export interface DishEditFailure {
  readonly ok: false;
  readonly code: DishEditFailureCode;
  readonly reason: string;
}

export type DishEditOutcome = { readonly ok: true } | DishEditFailure;

/**
 * Settles dish-edit failures into the client-safe outcome contract,
 * mirroring `settlePlaceTask` in place.functions.ts. Domain failures map
 * per Effect tag (known at compile time from AdminServiceError); the
 * permission-stage tags map to `forbidden`. Anything else propagates.
 */
const settleDishEdit = <A, R>(
  effects: typeof EffectModule,
  task: Effect.Effect<
    A,
    AdminServiceError | SignInRequired | UserSuspended | InsufficientPermissions,
    R
  >,
): Effect.Effect<
  DishEditOutcome,
  | DatabaseUnavailable
  | PersistenceError
  | PersistenceConflict
  | TransactionConflict
  | TransactionFailed
  | DatabaseError,
  R
> =>
  task.pipe(
    effects.Effect.map(() => ({ ok: true as const })),
    effects.Effect.catchTags({
      UnknownPlace: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "unknown_place" as const,
          reason: failure.reason,
        }),
      AmbiguousPlace: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "ambiguous_place" as const,
          reason:
            `ambiguous city "${failure.query}": ` +
            failure.candidates
              .map((candidate) => `${candidate.id}: ${candidate.name} (${candidate.context})`)
              .join("; "),
        }),
      InvalidSearchFilter: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "invalid_reference" as const,
          reason: failure.reason,
        }),
      InvalidDishData: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "invalid_reference" as const,
          reason: failure.reason,
        }),
      InvalidRelationship: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "invalid_reference" as const,
          reason: failure.reason,
        }),
      InvalidLocale: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "invalid_reference" as const,
          reason: failure.locale,
        }),
      ConflictingDish: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "conflict" as const,
          reason: failure.reason,
        }),
      CatalogConflict: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "conflict" as const,
          reason: failure.reason,
        }),
      DishNotFound: (failure) =>
        effects.Effect.succeed({
          ok: false as const,
          code: "not_found" as const,
          reason: `Dish ${failure.dishId} was not found.`,
        }),
      SignInRequired: () =>
        effects.Effect.succeed({
          ok: false as const,
          code: "forbidden" as const,
          reason: "Administration requires a signed-in curator.",
        }),
      UserSuspended: () =>
        effects.Effect.succeed({
          ok: false as const,
          code: "forbidden" as const,
          reason: "Suspended accounts cannot edit the catalog.",
        }),
      InsufficientPermissions: () =>
        effects.Effect.succeed({
          ok: false as const,
          code: "forbidden" as const,
          reason: "Administration requires food:update.",
        }),
    }),
  );

/**
 * Dish-edit transport with settled outcomes. Same two gates as the other
 * admin transports (surface access, then `food:update`), but composed
 * into one Effect so permission-stage failures settle to `forbidden`
 * instead of throwing — the client switches on the outcome code and never
 * inspects thrown errors.
 */
const withDishEditService = async <A>(
  loaded: Awaited<ReturnType<typeof loadDishAdminServer>>,
  headers: Headers,
  permissions: PermissionRequest | ReadonlyArray<PermissionRequest>,
  operation: string,
  requestId: string,
  task: (
    service: AdminServiceApi,
    actorLabel: string,
  ) => Effect.Effect<A, AdminServiceError, Database>,
): Promise<DishEditOutcome> => {
  const { effects, session, actor, authorization, currentActor, runtime } = loaded;

  const program = effects.Effect.flatMap(session.requireAuthenticatedActor(headers), (trusted) =>
    effects.Effect.flatMap(
      effects.Effect.forEach(SURFACE_CHECKS, (check) =>
        effects.Effect.flatMap(authorization.Authorization, (authz) =>
          authz.has(actor.Actor.Member({ userId: trusted.userId }), check),
        ),
      ),
      (results) =>
        results.some(Boolean)
          ? effects.Effect.flatMap(session.requirePermission(headers, permissions), (verified) =>
              currentActor.withActor(
                actor.Actor.Member({ userId: verified.userId }),
                effects.Effect.flatMap(loaded.dishes.AdminService, (service) =>
                  task(service, `admin:${verified.userId}`),
                ),
              ),
            )
          : effects.Effect.fail(
              new InsufficientPermissions({
                reason: "administration requires admin, import, or moderation grants",
              }),
            ),
    ),
  );

  return runtime.runApp(settleDishEdit(effects, program), operation, 15000, requestId);
};

export const adminUpdateDishFieldsFn = createServerFn({ method: "POST" })
  .validator(adminUpdateDishFieldsSchema)
  .handler(async ({ data }) => {
    const loaded = await loadDishAdminServer();
    const { server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withDishEditService(
      loaded,
      headers,
      dishUpdatePermissions(data.status),
      "fn/admin/dish-update-fields",
      requestId,
      (service, actorLabel) =>
        service.updateDishFields(actorLabel, data.dishId, {
          slug: data.slug,
          parentSlug: data.parentSlug,
          status: data.status,
        }),
    );
  });

export const adminUpdateDishNamesFn = createServerFn({ method: "POST" })
  .validator(adminUpdateDishNamesSchema)
  .handler(async ({ data }) => {
    const loaded = await loadDishAdminServer();
    const { server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withDishEditService(
      loaded,
      headers,
      dishUpdatePermissions(undefined),
      "fn/admin/dish-update-names",
      requestId,
      (service, actorLabel) =>
        service.updateDishNames(actorLabel, data.dishId, {
          upsert: data.upsert.map((entry) => ({
            id: entry.id,
            languageTag: entry.languageTag,
            name: entry.name,
            nameKind: entry.nameKind,
            isPreferred: entry.isPreferred,
          })),
          removeIds: data.removeIds,
        }),
    );
  });

export const adminUpdateDishDescriptionsFn = createServerFn({ method: "POST" })
  .validator(adminUpdateDishDescriptionsSchema)
  .handler(async ({ data }) => {
    const loaded = await loadDishAdminServer();
    const { server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withDishEditService(
      loaded,
      headers,
      dishUpdatePermissions(undefined),
      "fn/admin/dish-update-descriptions",
      requestId,
      (service, actorLabel) =>
        service.updateDishDescriptions(actorLabel, data.dishId, {
          upsert: data.upsert.map((entry) => ({
            languageTag: entry.languageTag,
            description: entry.description,
            summary: entry.summary,
          })),
          removeLanguageTags: data.removeLanguageTags,
        }),
    );
  });

export const adminUpdateDishIngredientsFn = createServerFn({ method: "POST" })
  .validator(adminUpdateDishIngredientsSchema)
  .handler(async ({ data }) => {
    const loaded = await loadDishAdminServer();
    const { server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withDishEditService(
      loaded,
      headers,
      dishUpdatePermissions(undefined),
      "fn/admin/dish-update-ingredients",
      requestId,
      (service, actorLabel) =>
        service.updateDishIngredients(actorLabel, data.dishId, {
          upsert: data.upsert.map((entry) => ({
            ingredientId: entry.ingredientId,
            role: entry.role,
          })),
          removeIngredientIds: data.removeIngredientIds,
        }),
    );
  });

export const adminUpdateDishTaxonomyFn = createServerFn({ method: "POST" })
  .validator(adminUpdateDishTaxonomySchema)
  .handler(async ({ data }) => {
    const loaded = await loadDishAdminServer();
    const { server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withDishEditService(
      loaded,
      headers,
      dishUpdatePermissions(undefined),
      "fn/admin/dish-update-taxonomy",
      requestId,
      (service, actorLabel) =>
        service.updateDishTaxonomy(actorLabel, data.dishId, {
          cuisineUpsert: data.cuisineUpsert,
          cuisineRemove: data.cuisineRemove,
          categoryUpsert: data.categoryUpsert,
          categoryRemove: data.categoryRemove,
        }),
    );
  });

export const adminUpdateDishPlacesFn = createServerFn({ method: "POST" })
  .validator(adminUpdateDishPlacesSchema)
  .handler(async ({ data }) => {
    const loaded = await loadDishAdminServer();
    const { server } = loaded;

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    return withDishEditService(
      loaded,
      headers,
      dishUpdatePermissions(undefined),
      "fn/admin/dish-update-places",
      requestId,
      (service, actorLabel) =>
        service.updateDishPlaces(actorLabel, data.dishId, {
          upsert: data.upsert.map((entry) => ({
            place: entry.place,
            association: entry.association,
            isDisputed: entry.isDisputed,
            note: entry.note,
          })),
          removePlaceIds: data.removePlaceIds,
        }),
    );
  });
