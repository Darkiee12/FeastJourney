import { createHash, randomUUID } from "node:crypto";

import { Context, Data, Effect, Layer } from "effect";
import sharp, { type Metadata as SharpMetadata } from "sharp";
import { z } from "zod";

import {
  type PhotoRef,
  RESTAURANT_PHOTO_WIDTHS,
  restaurantPhotoPreviewUrl,
  restaurantPhotoSrcSet,
  restaurantPhotoUrl,
} from "@/modules/restaurant-discovery/components/restaurant-photos";
import {
  RestaurantPhotoStorage,
  RestaurantPhotoStorageLive,
  RestaurantPhotoStorageFailed,
  RestaurantPhotoStorageMisconfigured,
} from "@/modules/restaurant-discovery/server/integrations/restaurant-photo-storage";
import {
  RestaurantNotFound,
  type RestaurantInputError,
} from "@/modules/restaurant-discovery/server/operations/discovery";
import photoAdminList from "@/modules/restaurant-discovery/server/repository/sql/photo-admin-list.sql";
import photoCountByVenue from "@/modules/restaurant-discovery/server/repository/sql/photo-count-by-venue.sql";
import photoDelete from "@/modules/restaurant-discovery/server/repository/sql/photo-delete.sql";
import photoFinalize from "@/modules/restaurant-discovery/server/repository/sql/photo-finalize.sql";
import photoFindById from "@/modules/restaurant-discovery/server/repository/sql/photo-find-by-id.sql";
import photoInsert from "@/modules/restaurant-discovery/server/repository/sql/photo-insert.sql";
import photoMaxSortOrder from "@/modules/restaurant-discovery/server/repository/sql/photo-max-sort-order.sql";
import photoPublishedByVenueIds from "@/modules/restaurant-discovery/server/repository/sql/photo-published-by-venue-ids.sql";
import photoReviewQueue from "@/modules/restaurant-discovery/server/repository/sql/photo-review-queue.sql";
import photoSetSortOrder from "@/modules/restaurant-discovery/server/repository/sql/photo-set-sort-order.sql";
import photoUpdateMetadata from "@/modules/restaurant-discovery/server/repository/sql/photo-update-metadata.sql";
import photoUpdateStatus from "@/modules/restaurant-discovery/server/repository/sql/photo-update-status.sql";
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
export const MAX_RESTAURANT_PHOTO_BYTES = 8 * 1024 * 1024;

/** Shortest decoded edge must reach 600px; smaller sources are rejected. */
export const MIN_SHORT_SIDE_PX = 600;

/** Decoded pixel ceiling (24 MP) bounds Sharp memory per upload. */
export const MAX_DECODED_PIXELS = 24_000_000;

/** Editorial cap: at most five photos per venue. */
export const MAX_PHOTOS_PER_VENUE = 5;

/** Stored WebP derivative widths. Resizes never upscale. */
export const DERIVATIVE_WIDTHS = RESTAURANT_PHOTO_WIDTHS;

export const DERIVATIVE_QUALITY = 80;

/**
 * Licenses the editor may attach. `unknown` is storable at draft stage but
 * never publishable; anything outside this list is rejected at the boundary.
 */
export const SUPPORTED_PHOTO_LICENSES = [
  "own-work",
  "cc0",
  "cc-by",
  "cc-by-sa",
  "licensed",
] as const;

export type PhotoLicense = (typeof SUPPORTED_PHOTO_LICENSES)[number];

export const PUBLISHABLE_PHOTO_LICENSES: ReadonlySet<string> = new Set(SUPPORTED_PHOTO_LICENSES);

const PHOTO_STATUS = ["draft", "review", "published"] as const;

export type RestaurantPhotoStatus = (typeof PHOTO_STATUS)[number];

export class RestaurantPhotoNotFound extends Data.TaggedError("RestaurantPhotoNotFound")<{
  readonly photoId: string;
}> {}

export class RestaurantPhotoValidationFailed extends Data.TaggedError(
  "RestaurantPhotoValidationFailed",
)<{
  readonly reason: string;
}> {}

export class RestaurantPhotoLimitExceeded extends Data.TaggedError("RestaurantPhotoLimitExceeded")<{
  readonly venueId: string;
  readonly limit: number;
}> {}

export class RestaurantPhotoPublishBlocked extends Data.TaggedError(
  "RestaurantPhotoPublishBlocked",
)<{
  readonly photoId: string;
  readonly reasons: ReadonlyArray<string>;
}> {}

export class RestaurantPhotoConflict extends Data.TaggedError("RestaurantPhotoConflict")<{
  readonly reason: string;
}> {}

export type RestaurantPhotoError =
  | RestaurantPhotoNotFound
  | RestaurantPhotoValidationFailed
  | RestaurantPhotoLimitExceeded
  | RestaurantPhotoPublishBlocked
  | RestaurantPhotoConflict
  | RestaurantPhotoStorageFailed
  | RestaurantPhotoStorageMisconfigured
  | RestaurantNotFound
  | RestaurantInputError
  | InsufficientPermissions
  | TransactionFailed
  | DatabaseError;

export type RestaurantPhotoRow = (typeof photoFindById)["~reylo"]["element"];

export type RestaurantPhotoAdminRow = (typeof photoAdminList)["~reylo"]["element"];

export type RestaurantPhotoPublishedRow = (typeof photoPublishedByVenueIds)["~reylo"]["element"];

export type RestaurantPhotoDeleteRow = (typeof photoDelete)["~reylo"]["element"];

/** Opaque versioned object prefix; one stored derivative per width hangs below it. */
export const restaurantPhotoKeyBase = (venueId: string, photoId: string, version: number): string =>
  `restaurant-photos/${venueId}/${photoId}/${version}`;

export const restaurantPhotoVariantKey = (base: string, width: number): string =>
  `${base}/${width}.webp`;

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

export interface RestaurantPhotoAdminView {
  readonly id: string;
  readonly venueId: string;
  readonly status: string;
  readonly sortOrder: number;
  readonly isPrimary: boolean;
  readonly altText: string | null;
  readonly attribution: string | null;
  readonly license: string;
  readonly focalX: number | null;
  readonly focalY: number | null;
  readonly originalWidth: number | null;
  readonly originalHeight: number | null;
  readonly format: string | null;
  readonly byteSize: number | null;
  readonly processing: string;
  readonly variantVersion: number;
  readonly uploadedBy: string | null;
  readonly reviewedAt: string | null;
  readonly publishedAt: string | null;
  readonly sourceUrl: string | null;
  /** Public delivery URL (1600w) — set only for published + ready rows. */
  readonly deliveryUrl: string | null;
  readonly srcSet: string | null;
  /** Session-gated preview URL for drafts/review rows with stored bytes. */
  readonly previewUrl: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

const toAdminView = (row: RestaurantPhotoAdminRow, index: number): RestaurantPhotoAdminView => {
  const version = Number(row.variant_version);

  const publishable =
    row.status === "published" && row.processing === "ready" && row.object_key !== null;

  // Admin previews resolve only for processed rows; failed processing has
  // no bytes to show, and published rows use the public delivery URL.
  const previewable = row.object_key !== null && !publishable && row.processing === "ready";

  return {
    id: row.id,
    venueId: row.venue_id,
    status: row.status,
    sortOrder: Number(row.sort_order),
    isPrimary: index === 0,
    altText: row.alt_text,
    attribution: row.attribution,
    license: row.license,
    focalX: row.focal_x,
    focalY: row.focal_y,
    originalWidth: toNumberOrNull(row.original_width),
    originalHeight: toNumberOrNull(row.original_height),
    format: row.format,
    byteSize: toNumberOrNull(row.byte_size),
    processing: row.processing,
    variantVersion: version,
    uploadedBy: row.uploaded_by,
    reviewedAt: toIso(row.reviewed_at),
    publishedAt: toIso(row.published_at),
    sourceUrl: row.source_url,
    deliveryUrl: publishable ? restaurantPhotoUrl(row.id, version, 1600) : null,
    srcSet: publishable ? restaurantPhotoSrcSet(row.id, version) : null,
    previewUrl: previewable ? restaurantPhotoPreviewUrl(row.id, version, 800) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
};

/**
 * Public shape for one published venue image. Rows missing display
 * dimensions or alt text never reach this shape: without reserved
 * dimensions the gallery would shift layout, and without alt text the image
 * is not publishable. Such rows indicate a bypassed publish gate, so they
 * are excluded rather than rendered with invented values.
 */
export const toPhotoRef = (row: RestaurantPhotoPublishedRow, index: number): PhotoRef | null => {
  if (row.alt_text === null || row.original_width === null || row.original_height === null) {
    return null;
  }

  const version = Number(row.variant_version);

  return {
    assetId: row.id,
    alt: row.alt_text,
    primary: index === 0,
    width: Number(row.original_width),
    height: Number(row.original_height),
    variants: DERIVATIVE_WIDTHS.map((width) => ({
      width,
      url: restaurantPhotoUrl(row.id, version, width),
    })),
  };
};

export interface ProcessedRestaurantPhoto {
  readonly format: "jpeg" | "png" | "webp";
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly checksumSha256: string;
  readonly variants: ReadonlyArray<{ readonly width: number; readonly bytes: Uint8Array }>;
}

const failValidation = (reason: string): RestaurantPhotoValidationFailed =>
  new RestaurantPhotoValidationFailed({ reason });

/**
 * Sharp validation + derivative pipeline. Pure over bytes: EXIF-oriented,
 * metadata-stripped, aspect-preserving resizes that never upscale, encoded
 * to WebP ~q80. Rejects anything that is not a jpeg/png/webp photograph.
 */
export const processRestaurantPhotoImage = async (
  bytes: Uint8Array,
  filename: string,
): Promise<ProcessedRestaurantPhoto> => {
  if (bytes.byteLength === 0) {
    throw failValidation("empty file: choose a photo to upload");
  }

  if (bytes.byteLength > MAX_RESTAURANT_PHOTO_BYTES) {
    throw failValidation(
      `file is ${(bytes.byteLength / 1048576).toFixed(1)} MiB; photos must be 8 MiB or smaller`,
    );
  }

  const extension = filename.split(".").pop()?.toLowerCase() ?? "";

  if (["svg", "gif", "heic", "heif", "pdf", "avif", "tiff"].includes(extension)) {
    throw failValidation(
      `".${extension}" files are not accepted; upload a JPEG, PNG, or WebP photo`,
    );
  }

  let metadata: SharpMetadata;

  try {
    metadata = await sharp(bytes).metadata();
  } catch {
    throw failValidation("file is not a readable image; upload a JPEG, PNG, or WebP photo");
  }

  const detected =
    metadata.format === "jpeg" || metadata.format === "png" || metadata.format === "webp"
      ? metadata.format
      : null;

  if (detected === null) {
    throw failValidation(
      "detected an unsupported image; only JPEG, PNG, and WebP photos are accepted",
    );
  }

  const width = metadata.width;
  const height = metadata.height;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw failValidation("image has no decodable dimensions");
  }

  // EXIF orientation ≥ 5 swaps the axes; report the displayed dimensions so
  // metadata, aspect reservation, and rendered bytes agree.
  const orientation = metadata.orientation ?? 1;
  const orientedWidth = orientation >= 5 ? height : width;
  const orientedHeight = orientation >= 5 ? width : height;

  if (Math.min(orientedWidth, orientedHeight) < MIN_SHORT_SIDE_PX) {
    throw failValidation(
      `image is ${orientedWidth}x${orientedHeight}px; the shortest side must be at least 600px`,
    );
  }

  if (orientedWidth * orientedHeight > MAX_DECODED_PIXELS) {
    throw failValidation(
      `image is ${orientedWidth}x${orientedHeight}px; photos above 24 megapixels are not accepted`,
    );
  }

  // Sequential resizes bound Sharp concurrency per upload: no worker pool,
  // no background jobs, one photo at a time.
  const variants: Array<{ readonly width: number; readonly bytes: Uint8Array }> = [];

  for (const targetWidth of DERIVATIVE_WIDTHS) {
    // eslint-disable-next-line no-await-in-loop -- sequential resizes bound Sharp memory per upload
    const rendered = await sharp(bytes)
      .rotate()
      .resize({ width: targetWidth, withoutEnlargement: true })
      .webp({ quality: DERIVATIVE_QUALITY })
      .toBuffer();

    variants.push({ width: targetWidth, bytes: new Uint8Array(rendered) });
  }

  return {
    format: detected,
    width: orientedWidth,
    height: orientedHeight,
    byteSize: bytes.byteLength,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    variants,
  };
};

export class RestaurantPhotoRepository extends Context.Service<
  RestaurantPhotoRepository,
  {
    readonly listByVenue: (
      venueId: string,
    ) => Effect.Effect<ReadonlyArray<RestaurantPhotoAdminRow>, DatabaseError, Database>;
    readonly findById: (
      id: string,
    ) => Effect.Effect<RestaurantPhotoAdminRow | null, DatabaseError, Database>;
    readonly publishedByVenueIds: (
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<RestaurantPhotoPublishedRow>, DatabaseError, Database>;
    readonly reviewQueue: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<RestaurantPhotoAdminRow>, DatabaseError, Database>;
    readonly countByVenue: (venueId: string) => Effect.Effect<number, DatabaseError, Database>;
    readonly maxSortOrder: (venueId: string) => Effect.Effect<number, DatabaseError, Database>;
    readonly venueExists: (venueId: string) => Effect.Effect<boolean, DatabaseError, Database>;
    readonly insertStaged: (input: {
      readonly venueId: string;
      readonly objectKey: string;
      readonly attribution: string | null;
      readonly license: string;
      readonly sortOrder: number;
      readonly altText: string | null;
      readonly focalX: number | null;
      readonly focalY: number | null;
      readonly originalWidth: number;
      readonly originalHeight: number;
      readonly format: "jpeg" | "png" | "webp";
      readonly byteSize: number;
      readonly checksumSha256: string;
      readonly uploadedBy: string;
      readonly processing: "processing" | "ready" | "failed";
      readonly sourceUrl: string | null;
    }) => Effect.Effect<RestaurantPhotoAdminRow, DatabaseError, Database>;
    readonly finalize: (input: {
      readonly id: string;
      readonly objectKey: string;
      readonly processing: "ready" | "failed";
    }) => Effect.Effect<RestaurantPhotoAdminRow | null, DatabaseError, Database>;
    readonly updateMetadata: (input: {
      readonly id: string;
      readonly altText: string | null;
      readonly attribution: string | null;
      readonly license: string;
      readonly focalX: number | null;
      readonly focalY: number | null;
      readonly sourceUrl: string | null;
    }) => Effect.Effect<RestaurantPhotoAdminRow | null, DatabaseError, Database>;
    readonly updateStatus: (input: {
      readonly id: string;
      readonly status: RestaurantPhotoStatus;
      readonly reviewedAt: string | null;
      readonly publishedAt: string | null;
    }) => Effect.Effect<RestaurantPhotoAdminRow | null, DatabaseError, Database>;
    readonly setSortOrder: (
      id: string,
      sortOrder: number,
    ) => Effect.Effect<void, DatabaseError, Database>;
    readonly remove: (
      id: string,
    ) => Effect.Effect<RestaurantPhotoDeleteRow | null, DatabaseError, Database>;
  }
>()("feastjourney/restaurant-discovery/RestaurantPhotoRepository") {}

export const RestaurantPhotoRepositoryLive = Layer.succeed(RestaurantPhotoRepository, {
  listByVenue: (venueId) =>
    runQuery("restaurant-photos/list", (sql) => photoAdminList.run(sql, { venue_id: venueId })),
  findById: (id) => runQuery("restaurant-photos/find", (sql) => photoFindById.run(sql, { id })),
  publishedByVenueIds: (ids) =>
    runQuery("restaurant-photos/published", (sql) =>
      photoPublishedByVenueIds.run(sql, { venue_ids: [...ids] }),
    ),
  reviewQueue: (limit) =>
    runQuery("restaurant-photos/review-queue", (sql) => photoReviewQueue.run(sql, { limit })),
  countByVenue: (venueId) =>
    Effect.map(
      runQuery("restaurant-photos/count", (sql) =>
        photoCountByVenue.run(sql, { venue_id: venueId }),
      ),
      (row) => Number(row.count),
    ),
  maxSortOrder: (venueId) =>
    Effect.map(
      runQuery("restaurant-photos/max-sort", (sql) =>
        photoMaxSortOrder.run(sql, { venue_id: venueId }),
      ),
      (row) => Number(row.max_sort_order),
    ),
  venueExists: (venueId) =>
    Effect.map(
      runQuery("restaurant-photos/venue-exists", (sql) =>
        photoVenueExists.run(sql, { id: venueId }),
      ),
      (row) => row !== null,
    ),
  insertStaged: (input) =>
    runQuery("restaurant-photos/insert", (sql) =>
      photoInsert.run(sql, {
        venue_id: input.venueId,
        object_key: input.objectKey,
        attribution: input.attribution,
        license: input.license,
        sort_order: input.sortOrder,
        alt_text: input.altText,
        focal_x: input.focalX,
        focal_y: input.focalY,
        original_width: input.originalWidth,
        original_height: input.originalHeight,
        format: input.format,
        byte_size: input.byteSize,
        checksum_sha256: input.checksumSha256,
        uploaded_by: input.uploadedBy,
        processing: input.processing,
        source_url: input.sourceUrl,
      }),
    ),
  finalize: (input) =>
    runQuery("restaurant-photos/finalize", (sql) =>
      photoFinalize.run(sql, {
        id: input.id,
        object_key: input.objectKey,
        processing: input.processing,
      }),
    ),
  updateMetadata: (input) =>
    runQuery("restaurant-photos/update-metadata", (sql) =>
      photoUpdateMetadata.run(sql, {
        id: input.id,
        alt_text: input.altText,
        attribution: input.attribution,
        license: input.license,
        focal_x: input.focalX,
        focal_y: input.focalY,
        source_url: input.sourceUrl,
      }),
    ),
  updateStatus: (input) =>
    runQuery("restaurant-photos/update-status", (sql) =>
      photoUpdateStatus.run(sql, {
        id: input.id,
        status: input.status,
        reviewed_at: input.reviewedAt,
        published_at: input.publishedAt,
      }),
    ),
  setSortOrder: (id, sortOrder) =>
    Effect.asVoid(
      runQuery("restaurant-photos/sort", (sql) =>
        photoSetSortOrder.run(sql, { id, sort_order: sortOrder }),
      ),
    ),
  remove: (id) => runQuery("restaurant-photos/delete", (sql) => photoDelete.run(sql, { id })),
});

export interface StagePhotoInput {
  readonly venueId: string;
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly altText: string | null;
  readonly attribution: string | null;
  readonly license: string;
  readonly focalX: number | null;
  readonly focalY: number | null;
  readonly sourceUrl: string | null;
  readonly makePrimary: boolean;
}

export interface UpdatePhotoMetadataInput {
  readonly photoId: string;
  readonly altText: string | null;
  readonly attribution: string | null;
  readonly license: string;
  readonly focalX: number | null;
  readonly focalY: number | null;
  readonly sourceUrl: string | null;
}

export interface ServeDerivativeInput {
  readonly photoId: string;
  readonly version: number;
  readonly width: number;
  readonly preview: boolean;
}

export interface ServedDerivative {
  readonly bytes: Uint8Array;
  readonly contentType: "image/webp";
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
      Effect.fail(
        new InsufficientPermissions({ reason: "restaurant photos require a signed-in member" }),
      ),
    Member: ({ userId }) => Effect.succeed(userId),
  });

const authorizeManage = Effect.gen(function* () {
  const actor = yield* CurrentActor;
  const authorization = yield* Authorization;
  yield* authorization.require(actor, { resource: "restaurant", actions: ["manage"] });

  return Actor.$match(actor, {
    Guest: () =>
      Effect.fail(
        new InsufficientPermissions({ reason: "restaurant photos require a signed-in member" }),
      ),
    Member: ({ userId }) => Effect.succeed(userId),
  });
}).pipe(Effect.flatten);

const validateMetadataFields = (
  input: Omit<UpdatePhotoMetadataInput, "photoId">,
): Effect.Effect<void, RestaurantPhotoValidationFailed> => {
  if (input.license !== "unknown" && !PUBLISHABLE_PHOTO_LICENSES.has(input.license)) {
    return Effect.fail(
      failValidation(
        `license "${input.license}" is not supported; choose ${[...SUPPORTED_PHOTO_LICENSES].join(", ")}, or unknown`,
      ),
    );
  }

  for (const [label, value] of [
    ["focal_x", input.focalX],
    ["focal_y", input.focalY],
  ] as const) {
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) {
      return Effect.fail(failValidation(`${label} must be between 0 and 1`));
    }
  }

  if (input.sourceUrl !== null && !input.sourceUrl.startsWith("https://")) {
    return Effect.fail(failValidation("source_url must be an https URL"));
  }

  if (input.altText !== null && input.altText.length > 500) {
    return Effect.fail(failValidation("alt text must be 500 characters or fewer"));
  }

  if (input.attribution !== null && input.attribution.length > 500) {
    return Effect.fail(failValidation("attribution must be 500 characters or fewer"));
  }

  return Effect.void;
};

export interface RestaurantPhotoServiceApi {
  readonly listForAdmin: (
    venueId: string,
  ) => Effect.Effect<
    ReadonlyArray<RestaurantPhotoAdminView>,
    RestaurantPhotoError,
    Database | RestaurantPhotoRepository | CurrentActor | Authorization | RoleRepository
  >;
  readonly listReviewQueue: (
    limit: number,
  ) => Effect.Effect<
    ReadonlyArray<RestaurantPhotoAdminView>,
    RestaurantPhotoError,
    Database | RestaurantPhotoRepository | CurrentActor | Authorization | RoleRepository
  >;
  readonly stagePhoto: (
    input: StagePhotoInput,
  ) => Effect.Effect<
    RestaurantPhotoAdminView,
    RestaurantPhotoError,
    | Database
    | RestaurantPhotoRepository
    | RestaurantPhotoStorage
    | CurrentActor
    | Authorization
    | RoleRepository
  >;
  readonly updateMetadata: (
    input: UpdatePhotoMetadataInput,
  ) => Effect.Effect<
    RestaurantPhotoAdminView,
    RestaurantPhotoError,
    Database | RestaurantPhotoRepository | CurrentActor | Authorization | RoleRepository
  >;
  readonly reorderPhotos: (input: {
    readonly venueId: string;
    readonly orderedIds: ReadonlyArray<string>;
  }) => Effect.Effect<
    ReadonlyArray<RestaurantPhotoAdminView>,
    RestaurantPhotoError,
    Database | RestaurantPhotoRepository | CurrentActor | Authorization | RoleRepository
  >;
  readonly submitForReview: (
    photoId: string,
  ) => Effect.Effect<
    RestaurantPhotoAdminView,
    RestaurantPhotoError,
    Database | RestaurantPhotoRepository | CurrentActor | Authorization | RoleRepository
  >;
  readonly publishPhoto: (
    photoId: string,
  ) => Effect.Effect<
    RestaurantPhotoAdminView,
    RestaurantPhotoError,
    | Database
    | RestaurantPhotoRepository
    | RestaurantPhotoStorage
    | CurrentActor
    | Authorization
    | RoleRepository
    | UserRepository
  >;
  readonly returnToDraft: (
    photoId: string,
  ) => Effect.Effect<
    RestaurantPhotoAdminView,
    RestaurantPhotoError,
    | Database
    | RestaurantPhotoRepository
    | CurrentActor
    | Authorization
    | RoleRepository
    | UserRepository
  >;
  readonly removePhoto: (
    photoId: string,
  ) => Effect.Effect<
    { readonly id: string; readonly venueId: string },
    RestaurantPhotoError,
    | Database
    | RestaurantPhotoRepository
    | RestaurantPhotoStorage
    | CurrentActor
    | Authorization
    | RoleRepository
    | UserRepository
  >;
  readonly serveDerivative: (
    input: ServeDerivativeInput,
  ) => Effect.Effect<
    ServedDerivative,
    RestaurantPhotoError,
    | Database
    | RestaurantPhotoRepository
    | RestaurantPhotoStorage
    | CurrentActor
    | Authorization
    | RoleRepository
  >;
  readonly publishedPhotosByVenueIds: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<
    ReadonlyMap<string, ReadonlyArray<PhotoRef>>,
    DatabaseError,
    Database | RestaurantPhotoRepository
  >;
}

export class RestaurantPhotoService extends Context.Service<
  RestaurantPhotoService,
  RestaurantPhotoServiceApi
>()("feastjourney/restaurant-discovery/RestaurantPhotoService") {}

const loadPhoto = (
  photoId: string,
): Effect.Effect<
  RestaurantPhotoAdminRow,
  RestaurantPhotoError,
  Database | RestaurantPhotoRepository
> => {
  const id = parseUuid(photoId);

  if (id === null) {
    return Effect.fail(new RestaurantPhotoNotFound({ photoId }));
  }

  return Effect.flatMap(RestaurantPhotoRepository, (repository) =>
    Effect.flatMap(repository.findById(id), (row) =>
      row === null ? Effect.fail(new RestaurantPhotoNotFound({ photoId })) : Effect.succeed(row),
    ),
  );
};

const auditPhotoEvent = (
  actorUserId: string,
  event: "restaurant.photo.published" | "restaurant.photo.withdrawn" | "restaurant.photo.removed",
  photo: { readonly id: string; readonly venueId: string },
) =>
  recordAuditEvent({
    actorUserId,
    sessionId: null,
    requestId: crypto.randomUUID(),
    event,
    outcome: "succeeded",
    resource: photo.id,
    metadata: { venue_id: photo.venueId },
  });

export const RestaurantPhotoServiceLive = Layer.effect(
  RestaurantPhotoService,
  Effect.gen(function* () {
    const repository = yield* RestaurantPhotoRepository;
    const storage = yield* RestaurantPhotoStorage;

    const listViews = (
      venueId: string,
    ): Effect.Effect<ReadonlyArray<RestaurantPhotoAdminView>, DatabaseError, Database> =>
      Effect.map(repository.listByVenue(venueId), (rows) =>
        rows.map((row, index) => toAdminView(row, index)),
      );

    return RestaurantPhotoService.of({
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

          return rows.map((row, index) => toAdminView(row, index));
        }),
      stagePhoto: (input) =>
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

          const existing = yield* repository.countByVenue(venueId);

          if (existing >= MAX_PHOTOS_PER_VENUE) {
            return yield* new RestaurantPhotoLimitExceeded({
              venueId: input.venueId,
              limit: MAX_PHOTOS_PER_VENUE,
            });
          }

          const processed = yield* Effect.tryPromise({
            try: () => processRestaurantPhotoImage(input.bytes, input.filename),
            catch: (cause) =>
              cause instanceof RestaurantPhotoValidationFailed
                ? cause
                : failValidation(
                    cause instanceof Error ? cause.message : "could not process image",
                  ),
          });

          const stagedKey = `restaurant-photos/staged/${randomUUID()}`;
          const maxSortOrder = yield* repository.maxSortOrder(venueId);

          const staged = yield* repository.insertStaged({
            venueId,
            objectKey: stagedKey,
            attribution: input.attribution,
            license: input.license,
            sortOrder: maxSortOrder + 1,
            altText: input.altText,
            focalX: input.focalX,
            focalY: input.focalY,
            originalWidth: processed.width,
            originalHeight: processed.height,
            format: processed.format,
            byteSize: processed.byteSize,
            checksumSha256: processed.checksumSha256,
            uploadedBy: actorUserId,
            processing: "processing",
            sourceUrl: input.sourceUrl,
          });

          const finalBase = restaurantPhotoKeyBase(venueId, staged.id, 1);

          const uploads = processed.variants.map((variant) => ({
            key: restaurantPhotoVariantKey(finalBase, variant.width),
            bytes: variant.bytes,
          }));

          const variantKeys = uploads.map((upload) => upload.key);

          const uploaded = yield* Effect.forEach(uploads, (upload) =>
            storage.putVariant(upload.key, upload.bytes),
          ).pipe(
            Effect.as(true),
            Effect.catch((cause) => Effect.succeed(cause)),
          );

          if (uploaded !== true) {
            const failure =
              uploaded instanceof RestaurantPhotoStorageFailed ||
              uploaded instanceof RestaurantPhotoStorageMisconfigured
                ? uploaded
                : new RestaurantPhotoStorageFailed({ operation: "put", reason: "unknown" });

            yield* repository.finalize({
              id: staged.id,
              objectKey: stagedKey,
              processing: "failed",
            });
            yield* storage.deleteVariants(variantKeys);

            return yield* failure;
          }

          const finalized = yield* repository.finalize({
            id: staged.id,
            objectKey: finalBase,
            processing: "ready",
          });

          if (finalized === null) {
            yield* storage.deleteVariants(variantKeys);

            return yield* new RestaurantPhotoStorageFailed({
              operation: "finalize",
              reason: "staged row disappeared before finalize",
            });
          }

          if (input.makePrimary) {
            const rows = yield* repository.listByVenue(venueId);
            const rest = rows.map((row) => row.id).filter((id) => id !== staged.id);

            yield* withTransaction(
              "restaurant-photos/reorder",
              Effect.forEach([staged.id, ...rest], (id, index) =>
                repository.setSortOrder(id, index),
              ),
            );
          }

          const views = yield* listViews(venueId);
          const created = views.find((view) => view.id === staged.id);

          if (created === undefined) {
            return yield* new RestaurantPhotoStorageFailed({
              operation: "finalize",
              reason: "staged row missing after finalize",
            });
          }

          return created;
        }),
      updateMetadata: (input) =>
        Effect.gen(function* () {
          yield* authorizeManage;
          yield* validateMetadataFields(input);

          const row = yield* loadPhoto(input.photoId);

          const updated = yield* repository.updateMetadata({
            id: row.id,
            altText: input.altText,
            attribution: input.attribution,
            license: input.license,
            focalX: input.focalX,
            focalY: input.focalY,
            sourceUrl: input.sourceUrl,
          });

          if (updated === null) {
            return yield* new RestaurantPhotoNotFound({ photoId: input.photoId });
          }

          const views = yield* listViews(updated.venue_id);
          const view = views.find((entry) => entry.id === updated.id);

          if (view === undefined) {
            return yield* new RestaurantPhotoNotFound({ photoId: input.photoId });
          }

          return view;
        }),
      reorderPhotos: (input) =>
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
          const current = new Set(rows.map((row) => row.id));
          const proposed = new Set(input.orderedIds);

          if (
            input.orderedIds.length !== current.size ||
            current.size !== proposed.size ||
            [...current].some((id) => !proposed.has(id))
          ) {
            return yield* new RestaurantPhotoConflict({
              reason: "reorder must include every photo of the venue exactly once",
            });
          }

          yield* withTransaction(
            "restaurant-photos/reorder",
            Effect.forEach(input.orderedIds, (id, index) => repository.setSortOrder(id, index)),
          );

          return yield* listViews(venueId);
        }),
      submitForReview: (photoId) =>
        Effect.gen(function* () {
          yield* authorizeManage;

          const row = yield* loadPhoto(photoId);

          if (row.processing !== "ready") {
            return yield* new RestaurantPhotoConflict({
              reason: `photo is ${row.processing}; only processed photos can enter review`,
            });
          }

          if (row.status === "published") {
            return yield* new RestaurantPhotoConflict({
              reason: "published photos return to draft first; they never re-enter review directly",
            });
          }

          if (row.status === "review") {
            const views = yield* listViews(row.venue_id);
            const view = views.find((entry) => entry.id === row.id);

            if (view === undefined) {
              return yield* new RestaurantPhotoNotFound({ photoId });
            }

            return view;
          }

          const updated = yield* repository.updateStatus({
            id: row.id,
            status: "review",
            reviewedAt: new Date().toISOString(),
            publishedAt: null,
          });

          if (updated === null) {
            return yield* new RestaurantPhotoNotFound({ photoId });
          }

          const views = yield* listViews(updated.venue_id);
          const view = views.find((entry) => entry.id === updated.id);

          if (view === undefined) {
            return yield* new RestaurantPhotoNotFound({ photoId });
          }

          return view;
        }),
      publishPhoto: (photoId) =>
        Effect.gen(function* () {
          const actor = yield* CurrentActor;
          const authorization = yield* Authorization;
          const actorUserId = yield* memberUserId(actor);

          yield* authorization.require(actor, { resource: "restaurant", actions: ["review"] });

          const row = yield* loadPhoto(photoId);
          const reasons: Array<string> = [];

          if (row.processing !== "ready") {
            reasons.push(`photo is ${row.processing}; finalize processing before publishing`);
          }

          if (row.object_key === null) {
            reasons.push("photo has no stored image");
          }

          if (row.license === "unknown" || !PUBLISHABLE_PHOTO_LICENSES.has(row.license)) {
            reasons.push(
              `license "${row.license}" cannot publish; attach ${[...SUPPORTED_PHOTO_LICENSES].join(", ")}`,
            );
          }

          if (row.attribution === null || row.attribution.trim().length === 0) {
            reasons.push("attribution is required to publish");
          }

          if (row.alt_text === null || row.alt_text.trim().length === 0) {
            reasons.push("alt text is required to publish");
          }

          if (row.status === "published") {
            const views = yield* listViews(row.venue_id);
            const view = views.find((entry) => entry.id === row.id);

            if (view === undefined) {
              return yield* new RestaurantPhotoNotFound({ photoId });
            }

            return view;
          }

          // Review is mandatory: drafts carry unvetted metadata and must
          // pass submitForReview before they can go public.
          if (row.status !== "review") {
            return yield* new RestaurantPhotoConflict({
              reason: `photo is ${row.status}; submit it for review before publishing`,
            });
          }

          if (reasons.length > 0) {
            return yield* new RestaurantPhotoPublishBlocked({ photoId, reasons });
          }

          const base = restaurantPhotoKeyBase(row.venue_id, row.id, Number(row.variant_version));
          const missing: Array<number> = [];

          for (const width of DERIVATIVE_WIDTHS) {
            const exists = yield* storage.variantExists(restaurantPhotoVariantKey(base, width));

            if (!exists) {
              missing.push(width);
            }
          }

          if (missing.length > 0) {
            return yield* new RestaurantPhotoPublishBlocked({
              photoId,
              reasons: [`stored derivatives missing for widths: ${missing.join(", ")}`],
            });
          }

          // The status flip and its mandatory audit row commit atomically:
          // an audit-insert failure rolls the publication back.
          return yield* withTransaction(
            "restaurant-photos/publish",
            Effect.gen(function* () {
              const updated = yield* repository.updateStatus({
                id: row.id,
                status: "published",
                reviewedAt: row.reviewed_at ?? new Date().toISOString(),
                publishedAt: new Date().toISOString(),
              });

              if (updated === null) {
                return yield* new RestaurantPhotoNotFound({ photoId });
              }

              yield* auditPhotoEvent(actorUserId, "restaurant.photo.published", {
                id: updated.id,
                venueId: updated.venue_id,
              });

              const views = yield* listViews(updated.venue_id);
              const view = views.find((entry) => entry.id === updated.id);

              if (view === undefined) {
                return yield* new RestaurantPhotoNotFound({ photoId });
              }

              return view;
            }),
          );
        }),
      returnToDraft: (photoId) =>
        Effect.gen(function* () {
          const actor = yield* CurrentActor;
          const authorization = yield* Authorization;
          const actorUserId = yield* memberUserId(actor);

          yield* authorization.require(actor, { resource: "restaurant", actions: ["manage"] });

          const row = yield* loadPhoto(photoId);

          // Withdrawing a published photo revokes a public delivery URL:
          // same bar as publishing, not plain manage.
          if (row.status === "published") {
            yield* authorization.require(actor, { resource: "restaurant", actions: ["review"] });
          }

          if (row.status === "draft") {
            const views = yield* listViews(row.venue_id);
            const view = views.find((entry) => entry.id === row.id);

            if (view === undefined) {
              return yield* new RestaurantPhotoNotFound({ photoId });
            }

            return view;
          }

          // Withdrawal revokes delivery first: the row leaves published
          // status in the same transaction as its audit record, so nothing
          // public can resolve afterwards. Object deletion is best-effort
          // and never fails the withdrawal (there is no object delete on
          // withdrawal — bytes stay for re-review, unreachable publicly).
          return yield* withTransaction(
            "restaurant-photos/withdraw",
            Effect.gen(function* () {
              const updated = yield* repository.updateStatus({
                id: row.id,
                status: "draft",
                reviewedAt: row.reviewed_at,
                publishedAt: null,
              });

              if (updated === null) {
                return yield* new RestaurantPhotoNotFound({ photoId });
              }

              if (row.status === "published") {
                yield* auditPhotoEvent(actorUserId, "restaurant.photo.withdrawn", {
                  id: updated.id,
                  venueId: updated.venue_id,
                });
              }

              const views = yield* listViews(updated.venue_id);
              const view = views.find((entry) => entry.id === updated.id);

              if (view === undefined) {
                return yield* new RestaurantPhotoNotFound({ photoId });
              }

              return view;
            }),
          );
        }),
      removePhoto: (photoId) =>
        Effect.gen(function* () {
          const actor = yield* CurrentActor;
          const authorization = yield* Authorization;
          const actorUserId = yield* memberUserId(actor);

          yield* authorization.require(actor, { resource: "restaurant", actions: ["manage"] });

          // loadPhoto first: deleting a published photo revokes a public
          // delivery URL, so it needs the review bar, not plain manage.
          // The row must exist to decide; missing rows still 404 below.
          const existing = yield* loadPhoto(photoId);

          if (existing.status === "published") {
            yield* authorization.require(actor, { resource: "restaurant", actions: ["review"] });
          }

          const id = parseUuid(photoId);

          if (id === null) {
            return yield* new RestaurantPhotoNotFound({ photoId });
          }

          // Withdrawal first: the row delete and its audit record commit
          // atomically, so nothing public can resolve afterwards. Object
          // removal is best-effort and never fails the delete.
          const deleted = yield* withTransaction(
            "restaurant-photos/remove",
            Effect.gen(function* () {
              const removed = yield* repository.remove(id);

              if (removed === null) {
                return yield* new RestaurantPhotoNotFound({ photoId });
              }

              yield* auditPhotoEvent(actorUserId, "restaurant.photo.removed", {
                id: removed.id,
                venueId: removed.venue_id,
              });

              return removed;
            }),
          );

          if (deleted.object_key !== null) {
            const base = restaurantPhotoKeyBase(
              deleted.venue_id,
              deleted.id,
              Number(deleted.variant_version),
            );

            yield* storage.deleteVariants(
              DERIVATIVE_WIDTHS.map((width) => restaurantPhotoVariantKey(base, width)),
            );
          }

          return { id: deleted.id, venueId: deleted.venue_id };
        }),
      serveDerivative: (input) =>
        Effect.gen(function* () {
          if (
            !Number.isInteger(input.version) ||
            input.version < 1 ||
            !DERIVATIVE_WIDTHS.some((allowed) => allowed === input.width)
          ) {
            return yield* new RestaurantPhotoValidationFailed({
              reason: `unknown derivative version=${input.version} width=${input.width}`,
            });
          }

          const row = yield* loadPhoto(input.photoId);

          if (row.object_key === null) {
            return yield* new RestaurantPhotoNotFound({ photoId: input.photoId });
          }

          if (Number(row.variant_version) !== input.version) {
            // Immutable versioned URLs: a rotated version never serves stale bytes.
            return yield* new RestaurantPhotoNotFound({ photoId: input.photoId });
          }

          if (!input.preview) {
            // Public origin serves published + ready derivatives only.
            // Drafts, review items, and failed processing stay unfetchable.
            // Private menu-scan bytes live under menu keys and are never
            // addressable here: every row key carries the restaurant-photos/
            // prefix enforced by the table CHECK.
            if (row.status !== "published" || row.processing !== "ready") {
              return yield* new RestaurantPhotoNotFound({ photoId: input.photoId });
            }
          } else {
            const actor = yield* CurrentActor;
            const authorization = yield* Authorization;

            // Member-only preview: Guest fails here, so only signed-in
            // members holding restaurant:read reach stored bytes.
            yield* memberUserId(actor);
            yield* authorization.require(actor, { resource: "restaurant", actions: ["read"] });

            if (row.processing !== "ready") {
              return yield* new RestaurantPhotoNotFound({ photoId: input.photoId });
            }
          }

          const base = restaurantPhotoKeyBase(row.venue_id, row.id, Number(row.variant_version));
          const bytes = yield* storage.getVariant(restaurantPhotoVariantKey(base, input.width));

          return {
            bytes,
            contentType: "image/webp" as const,
            etag: `"rp-${row.id}-v${row.variant_version}-${input.width}"`,
            byteSize: bytes.byteLength,
          };
        }),
      publishedPhotosByVenueIds: (ids) =>
        Effect.gen(function* () {
          const valid = ids.map((id) => parseUuid(id)).filter((id): id is string => id !== null);

          if (valid.length === 0) {
            return new Map<string, ReadonlyArray<PhotoRef>>();
          }

          const rows = yield* repository.publishedByVenueIds(valid);
          const grouped = new Map<string, ReadonlyArray<PhotoRef>>();
          const positionByVenue = new Map<string, number>();

          for (const row of rows) {
            const position = positionByVenue.get(row.venue_id) ?? 0;
            positionByVenue.set(row.venue_id, position + 1);
            const image = toPhotoRef(row, position);

            if (image === null) {
              continue;
            }

            grouped.set(row.venue_id, [...(grouped.get(row.venue_id) ?? []), image]);
          }

          return grouped;
        }),
    });
  }),
);

export const RestaurantPhotoLayersLive = Layer.provide(
  RestaurantPhotoServiceLive,
  Layer.mergeAll(RestaurantPhotoRepositoryLive, RestaurantPhotoStorageLive),
);

export const RestaurantPhotoFullLive = Layer.mergeAll(
  RestaurantPhotoRepositoryLive,
  RestaurantPhotoStorageLive,
  RestaurantPhotoLayersLive,
);
