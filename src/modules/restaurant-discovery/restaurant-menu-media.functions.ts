import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Menu-page transport: Zod 4.6 validation at the boundary, member-gated
 * staff writes, public published-only reads by venue.
 *
 * Byte delivery (`GET /api/v1/menu-pages/:pageId`, public published-only
 * plus `?preview=1` staff preview) is coordinator-owned and not part of
 * this file: until that route lands, views resolve metadata with delivery
 * URLs that 404. The viewer renders from these views and never invents
 * ingredients, prices, or dietary claims from page images.
 */

const uuidSchema = z.uuid();

// Client-safe delivery URL helpers. These mirror the server-side templates
// in server/operations/menu-page-media.ts; keep both in sync until the
// coordinator-owned delivery route lands.
/** Same-origin delivery URL for one published page (pending route; see above). */
export const menuPageDeliveryUrl = (pageId: string): string => `/api/v1/menu-pages/${pageId}`;

/** Session-gated preview URL for drafts/review rows with stored bytes. */
export const menuPagePreviewUrl = (pageId: string): string =>
  `${menuPageDeliveryUrl(pageId)}?preview=1`;

const menuPageLicenseSchema = z.enum([
  "own-work",
  "cc0",
  "cc-by",
  "cc-by-sa",
  "licensed",
  "unknown",
]);

const menuPageMetadataFields = {
  menuId: uuidSchema.nullable(),
  sourceUrl: z
    .string()
    .refine((value) => value.startsWith("https://"), "source_url must be an https URL")
    .nullable(),
  sourceName: z.string().trim().min(1).max(300).nullable(),
  rightsHolder: z.string().trim().min(1).max(300).nullable(),
  license: menuPageLicenseSchema,
  licenseEvidence: z.string().trim().min(1).max(2000).nullable(),
  attribution: z.string().trim().min(1).max(500).nullable(),
  observedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "observed_at must be a YYYY-MM-DD date")
    .nullable(),
};

export const menuPageVenueSchema = z.object({ venueId: uuidSchema });

export const menuPageIdSchema = z.object({ pageId: uuidSchema });

export const menuPageStageSchema = z.object({
  venueId: uuidSchema,
  ...menuPageMetadataFields,
  /** Base64-encoded JPEG/PNG/WebP bytes; decoded and size-checked server-side. */
  dataBase64: z.string().min(1).max(11_200_000),
  filename: z.string().min(1).max(255),
});

export const menuPageMetadataSchema = z.object({ pageId: uuidSchema, ...menuPageMetadataFields });

export const menuPageReorderSchema = z.object({
  venueId: uuidSchema,
  orderedIds: z.array(uuidSchema).min(1).max(50),
});

export const menuPageQueueSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
});

// Authentication builds the Actor; every privileged operation additionally checks its own grant.
const memberContext = async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server");
  const { requireAuthenticatedActor } = await import("@/server/auth/session");
  const { Actor } = await import("@/server/auth/actor");
  const { withActor } = await import("@/server/auth/current-actor");
  const { runClientOperation } = await import("@/server/http/run-client-operation");

  const session = await runClientOperation(requireAuthenticatedActor(getRequestHeaders()), "admin");

  return { actor: Actor.Member({ userId: session.userId }), withActor, runClientOperation };
};

// Imports the owning operation module directly; server/index.ts stays
// coordinator-owned (needed barrel exports are reported, not added here).
const menuPageOperations = () =>
  import("@/modules/restaurant-discovery/server/operations/menu-page-media");

// Domain layers are provided per call so the remaining requirements
// (Database, Authorization, current actor, user repositories) resolve from
// the application runtime: MenuPageService/Repository are not application
// singletons and server/index.ts stays coordinator-owned.
const menuPageServiceLayers = async () => {
  const { MenuPageFullLive } = await menuPageOperations();

  return MenuPageFullLive;
};

/** Public: published pages for one venue in display order. Guests allowed. */
export const listMenuPagesFn = createServerFn({ method: "GET" })
  .validator(menuPageVenueSchema)
  .handler(async ({ data }) => {
    const { MenuPageService } = await menuPageOperations();
    const { runClientOperation } = await import("@/server/http/run-client-operation");
    const { Effect } = await import("effect");

    return runClientOperation(
      Effect.provide(
        Effect.flatMap(MenuPageService, (service) => service.listPublishedByVenue(data.venueId)),
        await menuPageServiceLayers(),
      ),
      "public",
    );
  });

/** Staff: all live pages for one venue (drafts included). Requires restaurant:read. */
export const listMenuPagesAdminFn = createServerFn({ method: "GET" })
  .validator(menuPageVenueSchema)
  .handler(async ({ data }) => {
    const { MenuPageService } = await menuPageOperations();
    const { actor, withActor, runClientOperation } = await memberContext();
    const { Effect } = await import("effect");

    return runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(MenuPageService, (service) => service.listForAdmin(data.venueId)),
          await menuPageServiceLayers(),
        ),
      ),
      null,
    );
  });

/** Staff: pending review queue. Requires restaurant:review. */
export const listMenuPageReviewQueueFn = createServerFn({ method: "GET" })
  .validator(menuPageQueueSchema)
  .handler(async ({ data }) => {
    const { MenuPageService } = await menuPageOperations();
    const { actor, withActor, runClientOperation } = await memberContext();
    const { Effect } = await import("effect");

    return runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(MenuPageService, (service) => service.listReviewQueue(data.limit)),
          await menuPageServiceLayers(),
        ),
      ),
      null,
    );
  });

/** Staff: stage one photographed menu page. Requires restaurant:manage. */
export const stageMenuPageFn = createServerFn({ method: "POST" })
  .validator(menuPageStageSchema)
  .handler(async ({ data }) => {
    const { MenuPageService } = await menuPageOperations();
    const { actor, withActor, runClientOperation } = await memberContext();
    const { Effect } = await import("effect");

    const bytes = new Uint8Array(Buffer.from(data.dataBase64, "base64"));

    return runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(MenuPageService, (service) =>
            service.stagePage({
              venueId: data.venueId,
              menuId: data.menuId,
              bytes,
              filename: data.filename,
              sourceUrl: data.sourceUrl,
              sourceName: data.sourceName,
              rightsHolder: data.rightsHolder,
              license: data.license,
              licenseEvidence: data.licenseEvidence,
              attribution: data.attribution,
              observedAt: data.observedAt,
            }),
          ),
          await menuPageServiceLayers(),
        ),
      ),
      null,
    );
  });

/** Staff: edit rights metadata. Requires restaurant:manage. */
export const updateMenuPageFn = createServerFn({ method: "POST" })
  .validator(menuPageMetadataSchema)
  .handler(async ({ data }) => {
    const { MenuPageService } = await menuPageOperations();
    const { actor, withActor, runClientOperation } = await memberContext();
    const { Effect } = await import("effect");

    return runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(MenuPageService, (service) =>
            service.updateMetadata({
              pageId: data.pageId,
              menuId: data.menuId,
              sourceUrl: data.sourceUrl,
              sourceName: data.sourceName,
              rightsHolder: data.rightsHolder,
              license: data.license,
              licenseEvidence: data.licenseEvidence,
              attribution: data.attribution,
              observedAt: data.observedAt,
            }),
          ),
          await menuPageServiceLayers(),
        ),
      ),
      null,
    );
  });

/** Staff: reorder a venue's pages. Requires restaurant:manage. */
export const reorderMenuPagesFn = createServerFn({ method: "POST" })
  .validator(menuPageReorderSchema)
  .handler(async ({ data }) => {
    const { MenuPageService } = await menuPageOperations();
    const { actor, withActor, runClientOperation } = await memberContext();
    const { Effect } = await import("effect");

    return runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(MenuPageService, (service) =>
            service.reorderPages({ venueId: data.venueId, orderedIds: data.orderedIds }),
          ),
          await menuPageServiceLayers(),
        ),
      ),
      null,
    );
  });

/** Staff: submit a draft for review. Requires restaurant:manage. */
export const submitMenuPageFn = createServerFn({ method: "POST" })
  .validator(menuPageIdSchema)
  .handler(async ({ data }) => {
    const { MenuPageService } = await menuPageOperations();
    const { actor, withActor, runClientOperation } = await memberContext();
    const { Effect } = await import("effect");

    return runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(MenuPageService, (service) => service.submitForReview(data.pageId)),
          await menuPageServiceLayers(),
        ),
      ),
      null,
    );
  });

/** Staff: publish a reviewed page. Requires restaurant:review. License+attribution gated. */
export const publishMenuPageFn = createServerFn({ method: "POST" })
  .validator(menuPageIdSchema)
  .handler(async ({ data }) => {
    const { MenuPageService } = await menuPageOperations();
    const { actor, withActor, runClientOperation } = await memberContext();
    const { Effect } = await import("effect");

    return runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(MenuPageService, (service) => service.publishPage(data.pageId)),
          await menuPageServiceLayers(),
        ),
      ),
      null,
    );
  });

/** Staff: withdraw a page from public delivery. Published pages require restaurant:review. */
export const withdrawMenuPageFn = createServerFn({ method: "POST" })
  .validator(menuPageIdSchema)
  .handler(async ({ data }) => {
    const { MenuPageService } = await menuPageOperations();
    const { actor, withActor, runClientOperation } = await memberContext();
    const { Effect } = await import("effect");

    return runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(MenuPageService, (service) => service.withdrawPage(data.pageId)),
          await menuPageServiceLayers(),
        ),
      ),
      null,
    );
  });

/** Staff: remove a page (terminal removed state, bytes deleted). Published pages require restaurant:review. */
export const removeMenuPageFn = createServerFn({ method: "POST" })
  .validator(menuPageIdSchema)
  .handler(async ({ data }) => {
    const { MenuPageService } = await menuPageOperations();
    const { actor, withActor, runClientOperation } = await memberContext();
    const { Effect } = await import("effect");

    return runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(MenuPageService, (service) => service.removePage(data.pageId)),
          await menuPageServiceLayers(),
        ),
      ),
      null,
    );
  });
