import { createHash, randomUUID } from "node:crypto";

import { Context, Data, Effect, Layer } from "effect";
import sharp from "sharp";
import { z } from "zod";

import {
  RestaurantPhotoStorage,
  type RestaurantPhotoStorageFailed,
  RestaurantPhotoStorageLive,
  type RestaurantPhotoStorageMisconfigured,
} from "@/modules/restaurant-discovery/server/integrations/restaurant-photo-storage";
import { RestaurantNotFound } from "@/modules/restaurant-discovery/server/operations/discovery";
import menuPageAdminList from "@/modules/restaurant-discovery/server/repository/sql/menu-page-admin-list.sql";
import menuPageCountByVenue from "@/modules/restaurant-discovery/server/repository/sql/menu-page-count-by-venue.sql";
import menuPageFindById from "@/modules/restaurant-discovery/server/repository/sql/menu-page-find-by-id.sql";
import menuPageInsert from "@/modules/restaurant-discovery/server/repository/sql/menu-page-insert.sql";
import menuPageMaxPageOrder from "@/modules/restaurant-discovery/server/repository/sql/menu-page-max-page-order.sql";
import menuPageMenuCheck from "@/modules/restaurant-discovery/server/repository/sql/menu-page-menu-check.sql";
import menuPagePublish from "@/modules/restaurant-discovery/server/repository/sql/menu-page-publish.sql";
import menuPagePublishedByVenue from "@/modules/restaurant-discovery/server/repository/sql/menu-page-published-by-venue.sql";
import menuPageRemove from "@/modules/restaurant-discovery/server/repository/sql/menu-page-remove.sql";
import menuPageReviewQueue from "@/modules/restaurant-discovery/server/repository/sql/menu-page-review-queue.sql";
import menuPageSetPageOrder from "@/modules/restaurant-discovery/server/repository/sql/menu-page-set-page-order.sql";
import menuPageSubmit from "@/modules/restaurant-discovery/server/repository/sql/menu-page-submit.sql";
import menuPageUpdateMetadata from "@/modules/restaurant-discovery/server/repository/sql/menu-page-update-metadata.sql";
import menuPageWithdraw from "@/modules/restaurant-discovery/server/repository/sql/menu-page-withdraw.sql";
import photoVenueExists from "@/modules/restaurant-discovery/server/repository/sql/photo-venue-exists.sql";
import { recordAuditEvent } from "@/modules/user/server/operations/audit";
import { Authorization } from "@/modules/user/server/operations/authorization";
import type { RoleRepository } from "@/modules/user/server/repository/role-repository";
import type { UserRepository } from "@/modules/user/server/repository/user-repository";
import { Actor } from "@/server/auth/actor";
import { CurrentActor } from "@/server/auth/current-actor";
import { InsufficientPermissions } from "@/server/auth/errors";
import type { Database } from "@/server/database/client";
import { withTransaction } from "@/server/database/client";
import type { TransactionFailed } from "@/server/database/errors";
import type { DatabaseError } from "@/server/database/query";
import { runQuery } from "@/server/database/query";

/** Largest accepted source upload: 8 MiB. Binaries never land in Postgres. */
export const MAX_MENU_PAGE_BYTES = 8 * 1024 * 1024;

/** Shortest decoded edge must reach 600px; smaller sources are rejected. */
export const MIN_SHORT_SIDE_PX = 600;

/** Decoded pixel ceiling (24 MP) bounds Sharp memory per upload. */
export const MAX_DECODED_PIXELS = 24_000_000;

/** Editorial cap: at most twelve pages per venue (multipage menus). */
export const MAX_MENU_PAGES_PER_VENUE = 12;

/**
 * Licenses the editor may attach. `unknown` is storable at draft stage but
 * never publishable; anything outside this list is rejected at the boundary.
 * A photographed menu stays viewable while its rights are unreviewed, but
 * publication additionally requires attribution (see publishPage).
 */
export const SUPPORTED_MENU_PAGE_LICENSES = [
  "own-work",
  "cc0",
  "cc-by",
  "cc-by-sa",
  "licensed",
] as const;

export type MenuPageLicense = (typeof SUPPORTED_MENU_PAGE_LICENSES)[number];

export const PUBLISHABLE_MENU_PAGE_LICENSES: ReadonlySet<string> = new Set(
  SUPPORTED_MENU_PAGE_LICENSES,
);

export class MenuPageNotFound extends Data.TaggedError("MenuPageNotFound")<{
  readonly pageId: string;
}> {}

export class MenuPageValidationFailed extends Data.TaggedError("MenuPageValidationFailed")<{
  readonly reason: string;
}> {}

export class MenuPageLimitExceeded extends Data.TaggedError("MenuPageLimitExceeded")<{
  readonly venueId: string;
  readonly limit: number;
}> {}

export class MenuPagePublishBlocked extends Data.TaggedError("MenuPagePublishBlocked")<{
  readonly pageId: string;
  readonly reasons: ReadonlyArray<string>;
}> {}

export class MenuPageConflict extends Data.TaggedError("MenuPageConflict")<{
  readonly reason: string;
}> {}

export type MenuPageError =
  | MenuPageNotFound
  | MenuPageValidationFailed
  | MenuPageLimitExceeded
  | MenuPagePublishBlocked
  | MenuPageConflict
  | RestaurantPhotoStorageFailed
  | RestaurantPhotoStorageMisconfigured
  | RestaurantNotFound
  | InsufficientPermissions
  | TransactionFailed
  | DatabaseError;

export type MenuPageAdminRow = (typeof menuPageFindById)["~reylo"]["element"];

export type MenuPagePublishedRow = (typeof menuPagePublishedByVenue)["~reylo"]["element"];

/** Opaque versioned object key; one stored original hangs below it. */
export const menuPageKeyBase = (venueId: string, pageId: string): string =>
  `menu-pages/${venueId}/${pageId}`;

export const menuPageObjectKey = (venueId: string, pageId: string, format: string): string =>
  `${menuPageKeyBase(venueId, pageId)}/original.${format}`;

// Delivery URL helpers. The client-safe copies in
// restaurant-menu-media.functions.ts mirror these templates; keep both in
// sync until the coordinator-owned delivery route lands.
/** Same-origin delivery URL for one published page. Served by the
 *  coordinator-owned route `GET /api/v1/menu-pages/:pageId` (pending);
 *  until that route lands, published pages resolve metadata but no bytes. */
export const menuPageDeliveryUrl = (pageId: string): string => `/api/v1/menu-pages/${pageId}`;

/** Session-gated preview URL for drafts/review rows with stored bytes. */
export const menuPagePreviewUrl = (pageId: string): string =>
  `${menuPageDeliveryUrl(pageId)}?preview=1`;

const toIso = (value: string | Date | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
};

const toNumberOrNull = (value: number | bigint | string | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

export interface MenuPageAdminView {
  readonly id: string;
  readonly venueId: string;
  readonly menuId: string | null;
  readonly pageOrder: number;
  readonly status: string;
  readonly sourceUrl: string | null;
  readonly sourceName: string | null;
  readonly rightsHolder: string | null;
  readonly license: string;
  readonly licenseEvidence: string | null;
  readonly attribution: string | null;
  readonly observedAt: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly format: string | null;
  readonly byteSize: number | null;
  readonly checksum: string | null;
  readonly uploadedBy: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly publishedAt: string | null;
  /** Public delivery URL — set only for published rows. */
  readonly deliveryUrl: string | null;
  /** Session-gated preview URL for draft/review rows. */
  readonly previewUrl: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface MenuPagePublicView {
  readonly id: string;
  readonly venueId: string;
  readonly pageOrder: number;
  readonly width: number;
  readonly height: number;
  readonly attribution: string;
  readonly sourceName: string | null;
  readonly sourceUrl: string | null;
  readonly license: string;
  readonly deliveryUrl: string;
}

const toAdminView = (row: MenuPageAdminRow): MenuPageAdminView => ({
  id: row.id,
  venueId: row.venue_id,
  menuId: row.menu_id,
  pageOrder: Number(row.page_order),
  status: row.status,
  sourceUrl: row.source_url,
  sourceName: row.source_name,
  rightsHolder: row.rights_holder,
  license: row.license,
  licenseEvidence: row.license_evidence,
  attribution: row.attribution,
  observedAt: toIso(row.observed_at),
  width: toNumberOrNull(row.original_width),
  height: toNumberOrNull(row.original_height),
  format: row.format,
  byteSize: toNumberOrNull(row.byte_size),
  checksum: row.checksum_sha256,
  uploadedBy: row.uploaded_by,
  reviewedBy: row.reviewed_by,
  reviewedAt: toIso(row.reviewed_at),
  publishedAt: toIso(row.published_at),
  deliveryUrl: row.status === "published" ? menuPageDeliveryUrl(row.id) : null,
  previewUrl: row.status === "draft" || row.status === "review" ? menuPagePreviewUrl(row.id) : null,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

/**
 * Public shape for one published menu page. Dimensions and attribution are
 * publish gates, so a published row missing them never reaches this shape:
 * without reserved dimensions the pager would shift layout, and without
 * attribution the page is not publishable. Such rows indicate a bypassed
 * publish gate, so they are excluded rather than rendered with invented
 * values.
 */
export const toMenuPagePublicView = (row: MenuPagePublishedRow): MenuPagePublicView | null => {
  if (
    row.original_width === null ||
    row.original_height === null ||
    row.attribution === null ||
    row.attribution.trim().length === 0
  ) {
    return null;
  }

  return {
    id: row.id,
    venueId: row.venue_id,
    pageOrder: Number(row.page_order),
    width: Number(row.original_width),
    height: Number(row.original_height),
    attribution: row.attribution,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    license: row.license,
    deliveryUrl: menuPageDeliveryUrl(row.id),
  };
};

export interface ValidatedMenuPage {
  readonly format: "jpeg" | "png" | "webp";
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly checksumSha256: string;
}

const failValidation = (reason: string): MenuPageValidationFailed =>
  new MenuPageValidationFailed({ reason });

/**
 * Sharp validation over raw page bytes. Pure: EXIF-oriented, no resizes,
 * no derivatives — the stored original is served as-is so photographed
 * text stays readable at full size. Rejects anything that is not a
 * jpeg/png/webp image.
 */
export const validateMenuPageImage = async (
  bytes: Uint8Array,
  filename: string,
): Promise<ValidatedMenuPage> => {
  if (bytes.byteLength === 0) {
    throw failValidation("empty file: choose a menu page to upload");
  }

  if (bytes.byteLength > MAX_MENU_PAGE_BYTES) {
    throw failValidation(
      `file is ${(bytes.byteLength / 1048576).toFixed(1)} MiB; menu pages must be 8 MiB or smaller`,
    );
  }

  const extension = filename.split(".").pop()?.toLowerCase() ?? "";

  if (["svg", "gif", "heic", "heif", "pdf", "avif", "tiff"].includes(extension)) {
    throw failValidation(
      `".${extension}" files are not accepted; upload a JPEG, PNG, or WebP menu page`,
    );
  }

  let width: number | undefined;
  let height: number | undefined;
  let detected: string | undefined;
  let orientation = 1;

  try {
    const metadata = await sharp(bytes).metadata();

    width = metadata.width;
    height = metadata.height;
    detected = metadata.format;
    orientation = metadata.orientation ?? 1;
  } catch {
    throw failValidation("file is not a readable image; upload a JPEG, PNG, or WebP menu page");
  }

  if (detected !== "jpeg" && detected !== "png" && detected !== "webp") {
    throw failValidation(
      "detected an unsupported image; only JPEG, PNG, and WebP menu pages are accepted",
    );
  }

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw failValidation("image has no decodable dimensions");
  }

  // EXIF orientation ≥ 5 swaps the axes; report the displayed dimensions so
  // metadata, aspect reservation, and rendered bytes agree.
  const orientedWidth = orientation >= 5 ? height : width;
  const orientedHeight = orientation >= 5 ? width : height;

  if (Math.min(orientedWidth, orientedHeight) < MIN_SHORT_SIDE_PX) {
    throw failValidation(
      `image is ${orientedWidth}x${orientedHeight}px; the shortest side must be at least 600px`,
    );
  }

  if (orientedWidth * orientedHeight > MAX_DECODED_PIXELS) {
    throw failValidation(
      `image is ${orientedWidth}x${orientedHeight}px; menu pages above 24 megapixels are not accepted`,
    );
  }

  return {
    format: detected,
    width: orientedWidth,
    height: orientedHeight,
    byteSize: bytes.byteLength,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

export class MenuPageRepository extends Context.Service<
  MenuPageRepository,
  {
    readonly listByVenue: (
      venueId: string,
    ) => Effect.Effect<ReadonlyArray<MenuPageAdminRow>, DatabaseError, Database>;
    readonly publishedByVenue: (
      venueId: string,
    ) => Effect.Effect<ReadonlyArray<MenuPagePublishedRow>, DatabaseError, Database>;
    readonly reviewQueue: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<MenuPageAdminRow>, DatabaseError, Database>;
    readonly findById: (
      id: string,
    ) => Effect.Effect<MenuPageAdminRow | null, DatabaseError, Database>;
    readonly menuCheck: (
      id: string,
    ) => Effect.Effect<
      { readonly id: string; readonly venue_id: string } | null,
      DatabaseError,
      Database
    >;
    readonly venueExists: (venueId: string) => Effect.Effect<boolean, DatabaseError, Database>;
    readonly countByVenue: (venueId: string) => Effect.Effect<number, DatabaseError, Database>;
    readonly maxPageOrder: (venueId: string) => Effect.Effect<number, DatabaseError, Database>;
    readonly insertStaged: (input: {
      readonly id: string;
      readonly venueId: string;
      readonly menuId: string | null;
      readonly pageOrder: number;
      readonly objectKey: string;
      readonly sourceUrl: string | null;
      readonly sourceName: string | null;
      readonly rightsHolder: string | null;
      readonly license: string;
      readonly licenseEvidence: string | null;
      readonly attribution: string | null;
      readonly observedAt: string | null;
      readonly originalWidth: number;
      readonly originalHeight: number;
      readonly format: "jpeg" | "png" | "webp";
      readonly byteSize: number;
      readonly checksumSha256: string;
      readonly uploadedBy: string;
    }) => Effect.Effect<MenuPageAdminRow, DatabaseError, Database>;
    readonly updateMetadata: (input: {
      readonly id: string;
      readonly menuId: string | null;
      readonly sourceUrl: string | null;
      readonly sourceName: string | null;
      readonly rightsHolder: string | null;
      readonly license: string;
      readonly licenseEvidence: string | null;
      readonly attribution: string | null;
      readonly observedAt: string | null;
    }) => Effect.Effect<MenuPageAdminRow | null, DatabaseError, Database>;
    readonly submit: (
      id: string,
    ) => Effect.Effect<MenuPageAdminRow | null, DatabaseError, Database>;
    readonly publish: (input: {
      readonly id: string;
      readonly reviewedBy: string;
    }) => Effect.Effect<MenuPageAdminRow | null, DatabaseError, Database>;
    readonly withdraw: (
      id: string,
    ) => Effect.Effect<MenuPageAdminRow | null, DatabaseError, Database>;
    readonly remove: (
      id: string,
    ) => Effect.Effect<MenuPageAdminRow | null, DatabaseError, Database>;
    readonly setPageOrder: (
      id: string,
      pageOrder: number,
    ) => Effect.Effect<void, DatabaseError, Database>;
  }
>()("feastjourney/restaurant-discovery/MenuPageRepository") {}

export const MenuPageRepositoryLive = Layer.succeed(MenuPageRepository, {
  listByVenue: (venueId) =>
    runQuery("menu-pages/list", (sql) => menuPageAdminList.run(sql, { venue_id: venueId })),
  publishedByVenue: (venueId) =>
    runQuery("menu-pages/published", (sql) =>
      menuPagePublishedByVenue.run(sql, { venue_id: venueId }),
    ),
  reviewQueue: (limit) =>
    runQuery("menu-pages/review-queue", (sql) => menuPageReviewQueue.run(sql, { limit })),
  findById: (id) => runQuery("menu-pages/find", (sql) => menuPageFindById.run(sql, { id })),
  menuCheck: (id) => runQuery("menu-pages/menu-check", (sql) => menuPageMenuCheck.run(sql, { id })),
  venueExists: (venueId) =>
    Effect.map(
      runQuery("menu-pages/venue-exists", (sql) => photoVenueExists.run(sql, { id: venueId })),
      (row) => row !== null,
    ),
  countByVenue: (venueId) =>
    Effect.map(
      runQuery("menu-pages/count", (sql) => menuPageCountByVenue.run(sql, { venue_id: venueId })),
      (row) => Number(row.count),
    ),
  maxPageOrder: (venueId) =>
    Effect.map(
      runQuery("menu-pages/max-order", (sql) =>
        menuPageMaxPageOrder.run(sql, { venue_id: venueId }),
      ),
      (row) => Number(row.max_page_order),
    ),
  insertStaged: (input) =>
    runQuery("menu-pages/insert", (sql) =>
      menuPageInsert.run(sql, {
        id: input.id,
        venue_id: input.venueId,
        menu_id: input.menuId,
        page_order: input.pageOrder,
        object_key: input.objectKey,
        source_url: input.sourceUrl,
        source_name: input.sourceName,
        rights_holder: input.rightsHolder,
        license: input.license,
        license_evidence: input.licenseEvidence,
        attribution: input.attribution,
        observed_at: input.observedAt,
        original_width: input.originalWidth,
        original_height: input.originalHeight,
        format: input.format,
        byte_size: input.byteSize,
        checksum_sha256: input.checksumSha256,
        uploaded_by: input.uploadedBy,
      }),
    ),
  updateMetadata: (input) =>
    runQuery("menu-pages/update-metadata", (sql) =>
      menuPageUpdateMetadata.run(sql, {
        id: input.id,
        menu_id: input.menuId,
        source_url: input.sourceUrl,
        source_name: input.sourceName,
        rights_holder: input.rightsHolder,
        license: input.license,
        license_evidence: input.licenseEvidence,
        attribution: input.attribution,
        observed_at: input.observedAt,
      }),
    ),
  submit: (id) => runQuery("menu-pages/submit", (sql) => menuPageSubmit.run(sql, { id })),
  publish: (input) =>
    runQuery("menu-pages/publish", (sql) =>
      menuPagePublish.run(sql, { id: input.id, reviewed_by: input.reviewedBy }),
    ),
  withdraw: (id) => runQuery("menu-pages/withdraw", (sql) => menuPageWithdraw.run(sql, { id })),
  remove: (id) => runQuery("menu-pages/remove", (sql) => menuPageRemove.run(sql, { id })),
  setPageOrder: (id, pageOrder) =>
    Effect.asVoid(
      runQuery("menu-pages/order", (sql) =>
        menuPageSetPageOrder.run(sql, { id, page_order: pageOrder }),
      ),
    ),
});

export interface StageMenuPageInput {
  readonly venueId: string;
  readonly menuId: string | null;
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly sourceUrl: string | null;
  readonly sourceName: string | null;
  readonly rightsHolder: string | null;
  readonly license: string;
  readonly licenseEvidence: string | null;
  readonly attribution: string | null;
  readonly observedAt: string | null;
}

export interface UpdateMenuPageMetadataInput {
  readonly pageId: string;
  readonly menuId: string | null;
  readonly sourceUrl: string | null;
  readonly sourceName: string | null;
  readonly rightsHolder: string | null;
  readonly license: string;
  readonly licenseEvidence: string | null;
  readonly attribution: string | null;
  readonly observedAt: string | null;
}

export interface ServeMenuPageInput {
  readonly pageId: string;
  readonly preview: boolean;
}

export interface ServedMenuPage {
  readonly bytes: Uint8Array;
  readonly contentType: "image/jpeg" | "image/png" | "image/webp";
  readonly etag: string;
  readonly byteSize: number;
}

const uuidSchema = z.uuid();

const parseUuid = (value: string): string | null => {
  const parsed = uuidSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
};

const memberUserId = (actor: Actor): Effect.Effect<string, InsufficientPermissions> =>
  Actor.$match(actor, {
    Guest: () =>
      Effect.fail(new InsufficientPermissions({ reason: "menu pages require a signed-in member" })),
    Member: ({ userId }) => Effect.succeed(userId),
  });

const authorizeManage = Effect.gen(function* () {
  const actor = yield* CurrentActor;
  const authorization = yield* Authorization;
  yield* authorization.require(actor, { resource: "restaurant", actions: ["manage"] });

  return Actor.$match(actor, {
    Guest: () =>
      Effect.fail(new InsufficientPermissions({ reason: "menu pages require a signed-in member" })),
    Member: ({ userId }) => Effect.succeed(userId),
  });
}).pipe(Effect.flatten);

const validateMetadataFields = (
  input: Omit<UpdateMenuPageMetadataInput, "pageId">,
): Effect.Effect<void, MenuPageValidationFailed> => {
  if (input.license !== "unknown" && !PUBLISHABLE_MENU_PAGE_LICENSES.has(input.license)) {
    return Effect.fail(
      failValidation(
        `license "${input.license}" is not supported; choose ${[...SUPPORTED_MENU_PAGE_LICENSES].join(", ")}, or unknown`,
      ),
    );
  }

  if (input.sourceUrl !== null && !input.sourceUrl.startsWith("https://")) {
    return Effect.fail(failValidation("source_url must be an https URL"));
  }

  if (input.sourceName !== null && input.sourceName.trim().length === 0) {
    return Effect.fail(failValidation("source_name must not be blank"));
  }

  if (input.rightsHolder !== null && input.rightsHolder.trim().length === 0) {
    return Effect.fail(failValidation("rights_holder must not be blank"));
  }

  if (input.attribution !== null && input.attribution.length > 500) {
    return Effect.fail(failValidation("attribution must be 500 characters or fewer"));
  }

  if (input.observedAt !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.observedAt)) {
    return Effect.fail(failValidation("observed_at must be a YYYY-MM-DD date"));
  }

  return Effect.void;
};

export interface MenuPageServiceApi {
  readonly listPublishedByVenue: (
    venueId: string,
  ) => Effect.Effect<
    ReadonlyArray<MenuPagePublicView>,
    MenuPageError,
    Database | MenuPageRepository
  >;
  readonly listForAdmin: (
    venueId: string,
  ) => Effect.Effect<
    ReadonlyArray<MenuPageAdminView>,
    MenuPageError,
    Database | MenuPageRepository | CurrentActor | Authorization | RoleRepository
  >;
  readonly listReviewQueue: (
    limit: number,
  ) => Effect.Effect<
    ReadonlyArray<MenuPageAdminView>,
    MenuPageError,
    Database | MenuPageRepository | CurrentActor | Authorization | RoleRepository
  >;
  readonly stagePage: (
    input: StageMenuPageInput,
  ) => Effect.Effect<
    MenuPageAdminView,
    MenuPageError,
    | Database
    | MenuPageRepository
    | RestaurantPhotoStorage
    | CurrentActor
    | Authorization
    | RoleRepository
  >;
  readonly updateMetadata: (
    input: UpdateMenuPageMetadataInput,
  ) => Effect.Effect<
    MenuPageAdminView,
    MenuPageError,
    Database | MenuPageRepository | CurrentActor | Authorization | RoleRepository
  >;
  readonly reorderPages: (input: {
    readonly venueId: string;
    readonly orderedIds: ReadonlyArray<string>;
  }) => Effect.Effect<
    ReadonlyArray<MenuPageAdminView>,
    MenuPageError,
    Database | MenuPageRepository | CurrentActor | Authorization | RoleRepository
  >;
  readonly submitForReview: (
    pageId: string,
  ) => Effect.Effect<
    MenuPageAdminView,
    MenuPageError,
    Database | MenuPageRepository | CurrentActor | Authorization | RoleRepository
  >;
  readonly publishPage: (
    pageId: string,
  ) => Effect.Effect<
    MenuPageAdminView,
    MenuPageError,
    | Database
    | MenuPageRepository
    | RestaurantPhotoStorage
    | CurrentActor
    | Authorization
    | RoleRepository
    | UserRepository
  >;
  readonly withdrawPage: (
    pageId: string,
  ) => Effect.Effect<
    MenuPageAdminView,
    MenuPageError,
    Database | MenuPageRepository | CurrentActor | Authorization | RoleRepository | UserRepository
  >;
  readonly removePage: (
    pageId: string,
  ) => Effect.Effect<
    { readonly id: string; readonly venueId: string },
    MenuPageError,
    | Database
    | MenuPageRepository
    | RestaurantPhotoStorage
    | CurrentActor
    | Authorization
    | RoleRepository
    | UserRepository
  >;
  readonly servePage: (
    input: ServeMenuPageInput,
  ) => Effect.Effect<
    ServedMenuPage,
    MenuPageError,
    | Database
    | MenuPageRepository
    | RestaurantPhotoStorage
    | CurrentActor
    | Authorization
    | RoleRepository
  >;
}

export class MenuPageService extends Context.Service<MenuPageService, MenuPageServiceApi>()(
  "feastjourney/restaurant-discovery/MenuPageService",
) {}

const loadPage = (
  pageId: string,
): Effect.Effect<MenuPageAdminRow, MenuPageError, Database | MenuPageRepository> => {
  const id = parseUuid(pageId);

  if (id === null) {
    return Effect.fail(new MenuPageNotFound({ pageId }));
  }

  return Effect.flatMap(MenuPageRepository, (repository) =>
    Effect.flatMap(repository.findById(id), (row) =>
      row === null || row.status === "removed"
        ? Effect.fail(new MenuPageNotFound({ pageId }))
        : Effect.succeed(row),
    ),
  );
};

const auditMenuPageEvent = (
  actorUserId: string,
  event:
    | "restaurant.menu_page.published"
    | "restaurant.menu_page.withdrawn"
    | "restaurant.menu_page.removed",
  page: { readonly id: string; readonly venueId: string },
) =>
  recordAuditEvent({
    actorUserId,
    sessionId: null,
    requestId: crypto.randomUUID(),
    event,
    outcome: "succeeded",
    resource: page.id,
    metadata: { venue_id: page.venueId },
  });

export const MenuPageServiceLive = Layer.effect(
  MenuPageService,
  Effect.gen(function* () {
    const repository = yield* MenuPageRepository;
    const storage = yield* RestaurantPhotoStorage;

    const listViews = (
      venueId: string,
    ): Effect.Effect<ReadonlyArray<MenuPageAdminView>, DatabaseError, Database> =>
      Effect.map(repository.listByVenue(venueId), (rows) =>
        rows.filter((row) => row.status !== "removed").map((row) => toAdminView(row)),
      );

    const checkMenuScope = (
      venueId: string,
      menuId: string | null,
    ): Effect.Effect<void, MenuPageError, Database | MenuPageRepository> => {
      if (menuId === null) {
        return Effect.void;
      }

      const parsed = parseUuid(menuId);

      if (parsed === null) {
        return Effect.fail(new MenuPageNotFound({ pageId: menuId }));
      }

      return Effect.gen(function* () {
        const menu = yield* repository.menuCheck(parsed);

        if (menu === null) {
          return yield* new MenuPageNotFound({ pageId: menuId });
        }

        if (menu.venue_id !== venueId) {
          return yield* new MenuPageConflict({ reason: "menu belongs to a different venue" });
        }

        return yield* Effect.void;
      });
    };

    return MenuPageService.of({
      listPublishedByVenue: (venueId) =>
        Effect.gen(function* () {
          const parsed = parseUuid(venueId);

          if (parsed === null) {
            return [];
          }

          if (!(yield* repository.venueExists(parsed))) {
            return [];
          }

          const rows = yield* repository.publishedByVenue(parsed);

          return rows.flatMap((row) => {
            const view = toMenuPagePublicView(row);

            return view === null ? [] : [view];
          });
        }),
      listForAdmin: (venueId) =>
        Effect.gen(function* () {
          const actor = yield* CurrentActor;
          const authorization = yield* Authorization;

          yield* authorization.require(actor, { resource: "restaurant", actions: ["read"] });

          const parsed = parseUuid(venueId);

          if (parsed === null) {
            return yield* new RestaurantNotFound();
          }

          if (!(yield* repository.venueExists(parsed))) {
            return yield* new RestaurantNotFound();
          }

          return yield* listViews(parsed);
        }),
      listReviewQueue: (limit) =>
        Effect.gen(function* () {
          const actor = yield* CurrentActor;
          const authorization = yield* Authorization;

          yield* authorization.require(actor, { resource: "restaurant", actions: ["review"] });

          const bounded = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 20;
          const rows = yield* repository.reviewQueue(bounded);

          return rows.map((row) => toAdminView(row));
        }),
      stagePage: (input) =>
        Effect.gen(function* () {
          const actorUserId = yield* authorizeManage;
          yield* validateMetadataFields(input);

          const venueId = parseUuid(input.venueId);

          if (venueId === null) {
            return yield* new RestaurantNotFound();
          }

          if (!(yield* repository.venueExists(venueId))) {
            return yield* new RestaurantNotFound();
          }

          yield* checkMenuScope(venueId, input.menuId);

          const existing = yield* repository.countByVenue(venueId);

          if (existing >= MAX_MENU_PAGES_PER_VENUE) {
            return yield* new MenuPageLimitExceeded({
              venueId: input.venueId,
              limit: MAX_MENU_PAGES_PER_VENUE,
            });
          }

          const validated = yield* Effect.tryPromise({
            try: () => validateMenuPageImage(input.bytes, input.filename),
            catch: (cause) =>
              cause instanceof MenuPageValidationFailed
                ? cause
                : failValidation(
                    cause instanceof Error ? cause.message : "could not process image",
                  ),
          });

          const pageId = randomUUID();
          const objectKey = menuPageObjectKey(venueId, pageId, validated.format);

          yield* storage.putVariant(objectKey, input.bytes);

          const maxOrder = yield* repository.maxPageOrder(venueId);

          // Insert failure after a successful PUT must not strand orphan
          // bytes: the cleanup is best-effort and never masks the insert
          // failure.
          yield* repository
            .insertStaged({
              id: pageId,
              venueId,
              menuId: input.menuId,
              pageOrder: maxOrder + 1,
              objectKey,
              sourceUrl: input.sourceUrl,
              sourceName: input.sourceName,
              rightsHolder: input.rightsHolder,
              license: input.license,
              licenseEvidence: input.licenseEvidence,
              attribution: input.attribution,
              observedAt: input.observedAt,
              originalWidth: validated.width,
              originalHeight: validated.height,
              format: validated.format,
              byteSize: validated.byteSize,
              checksumSha256: validated.checksumSha256,
              uploadedBy: actorUserId,
            })
            .pipe(Effect.onError(() => Effect.ignore(storage.deleteVariants([objectKey]))));

          const views = yield* listViews(venueId);
          const created = views.find((view) => view.id === pageId);

          if (created === undefined) {
            return yield* new MenuPageNotFound({ pageId });
          }

          return created;
        }),
      updateMetadata: (input) =>
        Effect.gen(function* () {
          yield* authorizeManage;
          yield* validateMetadataFields(input);

          const row = yield* loadPage(input.pageId);

          if (row.status !== "draft" && row.status !== "review") {
            return yield* new MenuPageConflict({
              reason: `page is ${row.status}; metadata edits are only available for drafts and review items`,
            });
          }

          yield* checkMenuScope(row.venue_id, input.menuId);

          const updated = yield* repository.updateMetadata({
            id: row.id,
            menuId: input.menuId,
            sourceUrl: input.sourceUrl,
            sourceName: input.sourceName,
            rightsHolder: input.rightsHolder,
            license: input.license,
            licenseEvidence: input.licenseEvidence,
            attribution: input.attribution,
            observedAt: input.observedAt,
          });

          if (updated === null) {
            return yield* new MenuPageConflict({
              reason: "page left the editable state before the update applied",
            });
          }

          return toAdminView(updated);
        }),
      reorderPages: (input) =>
        Effect.gen(function* () {
          yield* authorizeManage;

          const venueId = parseUuid(input.venueId);

          if (venueId === null) {
            return yield* new RestaurantNotFound();
          }

          if (!(yield* repository.venueExists(venueId))) {
            return yield* new RestaurantNotFound();
          }

          const rows = yield* repository.listByVenue(venueId);
          const live = rows.filter((row) => row.status !== "removed");
          const current = new Set(live.map((row) => row.id));
          const proposed = new Set(input.orderedIds);

          if (
            input.orderedIds.length !== current.size ||
            current.size !== proposed.size ||
            [...current].some((id) => !proposed.has(id))
          ) {
            return yield* new MenuPageConflict({
              reason: "reorder must include every live page of the venue exactly once",
            });
          }

          yield* withTransaction(
            "menu-pages/reorder",
            Effect.forEach(input.orderedIds, (id, index) => repository.setPageOrder(id, index)),
          );

          return yield* listViews(venueId);
        }),
      submitForReview: (pageId) =>
        Effect.gen(function* () {
          yield* authorizeManage;

          const row = yield* loadPage(pageId);

          if (row.status === "published") {
            return yield* new MenuPageConflict({
              reason: "published pages return to draft first; they never re-enter review directly",
            });
          }

          if (row.status === "review") {
            return toAdminView(row);
          }

          const updated = yield* repository.submit(row.id);

          if (updated === null) {
            return yield* new MenuPageConflict({
              reason: "page left the draft state before submit applied",
            });
          }

          return toAdminView(updated);
        }),
      publishPage: (pageId) =>
        Effect.gen(function* () {
          const actor = yield* CurrentActor;
          const authorization = yield* Authorization;
          const actorUserId = yield* memberUserId(actor);

          yield* authorization.require(actor, { resource: "restaurant", actions: ["review"] });

          const row = yield* loadPage(pageId);
          const reasons: Array<string> = [];

          if (row.original_width === null || row.original_height === null || row.format === null) {
            reasons.push("page has no stored image dimensions");
          }

          if (row.license === "unknown" || !PUBLISHABLE_MENU_PAGE_LICENSES.has(row.license)) {
            reasons.push(
              `license "${row.license}" cannot publish; attach ${[...SUPPORTED_MENU_PAGE_LICENSES].join(", ")}`,
            );
          }

          if (row.attribution === null || row.attribution.trim().length === 0) {
            reasons.push("attribution is required to publish");
          }

          if (row.status === "published") {
            const views = yield* listViews(row.venue_id);
            const view = views.find((entry) => entry.id === row.id);

            if (view === undefined) {
              return yield* new MenuPageNotFound({ pageId });
            }

            return view;
          }

          // Review is mandatory: drafts carry unvetted rights metadata and
          // must pass submitForReview before they can go public.
          if (row.status !== "review") {
            return yield* new MenuPageConflict({
              reason: `page is ${row.status}; submit it for review before publishing`,
            });
          }

          if (reasons.length > 0) {
            return yield* new MenuPagePublishBlocked({ pageId, reasons });
          }

          const exists = yield* storage.variantExists(row.object_key);

          if (!exists) {
            return yield* new MenuPagePublishBlocked({
              pageId,
              reasons: ["stored menu page bytes are missing"],
            });
          }

          // The status flip and its mandatory audit row commit atomically:
          // an audit-insert failure rolls the publication back.
          return yield* withTransaction(
            "menu-pages/publish",
            Effect.gen(function* () {
              const updated = yield* repository.publish({ id: row.id, reviewedBy: actorUserId });

              if (updated === null) {
                return yield* new MenuPageConflict({
                  reason: "page left the review state before publish applied",
                });
              }

              yield* auditMenuPageEvent(actorUserId, "restaurant.menu_page.published", {
                id: updated.id,
                venueId: updated.venue_id,
              });

              return toAdminView(updated);
            }),
          );
        }),
      withdrawPage: (pageId) =>
        Effect.gen(function* () {
          const actor = yield* CurrentActor;
          const authorization = yield* Authorization;
          const actorUserId = yield* memberUserId(actor);

          yield* authorization.require(actor, { resource: "restaurant", actions: ["manage"] });

          const row = yield* loadPage(pageId);

          // Withdrawing a published page revokes a public delivery URL:
          // same bar as publishing, not plain manage.
          if (row.status === "published") {
            yield* authorization.require(actor, { resource: "restaurant", actions: ["review"] });
          }

          if (row.status === "draft") {
            return toAdminView(row);
          }

          // Withdrawal revokes delivery first: the row leaves published
          // status in the same transaction as its audit record, so nothing
          // public can resolve afterwards. Object deletion is best-effort
          // and never fails the withdrawal (bytes stay for re-review,
          // unreachable publicly).
          return yield* withTransaction(
            "menu-pages/withdraw",
            Effect.gen(function* () {
              const updated = yield* repository.withdraw(row.id);

              if (updated === null) {
                return yield* new MenuPageConflict({
                  reason: "page left the withdrawable state before withdraw applied",
                });
              }

              if (row.status === "published") {
                yield* auditMenuPageEvent(actorUserId, "restaurant.menu_page.withdrawn", {
                  id: updated.id,
                  venueId: updated.venue_id,
                });
              }

              return toAdminView(updated);
            }),
          );
        }),
      removePage: (pageId) =>
        Effect.gen(function* () {
          const actor = yield* CurrentActor;
          const authorization = yield* Authorization;
          const actorUserId = yield* memberUserId(actor);

          yield* authorization.require(actor, { resource: "restaurant", actions: ["manage"] });

          // loadPage first: removing a published page revokes a public
          // delivery URL, so it needs the review bar, not plain manage.
          const existing = yield* loadPage(pageId);

          if (existing.status === "published") {
            yield* authorization.require(actor, { resource: "restaurant", actions: ["review"] });
          }

          // Removal first: the row enters the terminal removed state in the
          // same transaction as its audit record, so nothing public can
          // resolve afterwards. Object removal is best-effort and never
          // fails the removal.
          const removed = yield* withTransaction(
            "menu-pages/remove",
            Effect.gen(function* () {
              const tombstone = yield* repository.remove(existing.id);

              if (tombstone === null) {
                return yield* new MenuPageNotFound({ pageId });
              }

              yield* auditMenuPageEvent(actorUserId, "restaurant.menu_page.removed", {
                id: tombstone.id,
                venueId: tombstone.venue_id,
              });

              return tombstone;
            }),
          );

          yield* storage.deleteVariants([removed.object_key]);

          return { id: removed.id, venueId: removed.venue_id };
        }),
      servePage: (input) =>
        Effect.gen(function* () {
          const row = yield* loadPage(input.pageId);

          if (!input.preview) {
            // Public origin serves published pages only. Drafts, review
            // items, and removed rows stay unfetchable. Private menu-scan
            // bytes live under menu/ keys and are never addressable here:
            // every row key carries the menu-pages/ prefix enforced by the
            // table CHECK.
            if (row.status !== "published") {
              return yield* new MenuPageNotFound({ pageId: input.pageId });
            }
          } else {
            const actor = yield* CurrentActor;
            const authorization = yield* Authorization;

            // Member-only preview: Guest fails here, so only signed-in
            // members holding restaurant:read reach stored bytes.
            yield* memberUserId(actor);
            yield* authorization.require(actor, { resource: "restaurant", actions: ["read"] });
          }

          const bytes = yield* storage.getVariant(row.object_key);

          if (row.format === "png") {
            return {
              bytes,
              contentType: "image/png" as const,
              etag: `"mp-${row.id}"`,
              byteSize: bytes.byteLength,
            };
          }

          if (row.format === "webp") {
            return {
              bytes,
              contentType: "image/webp" as const,
              etag: `"mp-${row.id}"`,
              byteSize: bytes.byteLength,
            };
          }

          return {
            bytes,
            contentType: "image/jpeg" as const,
            etag: `"mp-${row.id}"`,
            byteSize: bytes.byteLength,
          };
        }),
    });
  }),
);

export const MenuPageLayersLive = Layer.provide(
  MenuPageServiceLive,
  Layer.mergeAll(MenuPageRepositoryLive, RestaurantPhotoStorageLive),
);

export const MenuPageFullLive = Layer.mergeAll(
  MenuPageRepositoryLive,
  RestaurantPhotoStorageLive,
  MenuPageLayersLive,
);
