import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  previewRestaurantPhotoSchema,
  reorderRestaurantPhotosSchema,
  restaurantPhotoAdminListSchema,
  restaurantPhotoAdminSchema,
  restaurantPhotoIdInputSchema,
  restaurantPhotoRemovedSchema,
  restaurantPhotoReviewQueueSchema,
  restaurantPhotoVenueSchema,
  stageRestaurantPhotoFieldsSchema,
  stageRestaurantPhotoFormSchema,
  updateRestaurantPhotoMetadataSchema,
  type StageRestaurantPhotoFields,
} from "@/modules/restaurant-discovery/restaurant-photos.schema";

/**
 * Browser transport for first-party venue photography.
 *
 * Thin adapters only: Zod validates every input, the verified session
 * builds the Actor, and the Effect service (`server/operations/photos.ts`,
 * used as-is) enforces grants, venue existence, the 5-photo cap, publish
 * gating, and audit atomicity. Outputs re-parse through the strict admin
 * schema so storage object keys and checksums can never leak — the SQL
 * selects them for service logic, but the transport projection drops them.
 *
 * Grant map (enforced by the service, mirrored from `operations/review.ts`
 * `authorizeReviewer` — `restaurant:review` alone never authorizes a
 * mutation outside review decisions, `restaurant:manage` alone never
 * publishes or unpublishes):
 * - listVenuePhotos: `restaurant:read`
 * - previewPhoto: `restaurant:read` for draft/review previews; published
 *   derivatives additionally resolve publicly (no grant) but this
 *   authenticated entry point always requires a sign-in
 * - listPhotoReviewQueue, publishPhoto: `restaurant:review`
 * - stageVenuePhoto, updatePhotoMetadata, reorderPhotos,
 *   submitPhotoForReview, withdrawPhoto: `restaurant:manage`
 * - withdrawPhoto, deletePhoto on a published photo: additionally
 *   `restaurant:review` (revoking a public delivery URL is a review-bar
 *   action, same as publishing)
 *
 * Uploads travel as multipart/form-data through `stageVenuePhoto` — the
 * single upload path. JSON/base64 image payloads are rejected at the
 * boundary; actual bytes and dimensions are validated server-side by Sharp
 * inside the service. No `src/routes/api/restaurant-photos.ts` exists on
 * purpose: TanStack server functions carry FormData natively, so a second
 * upload route would split the contract.
 */

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

const photoServiceLayers = async () => {
  const { RestaurantPhotoFullLive } =
    await import("@/modules/restaurant-discovery/server/operations/photos");

  return RestaurantPhotoFullLive;
};

/** Staff venue listing: every photo of one venue in display order, drafts included. */
export const listVenuePhotos = createServerFn({ method: "GET" })
  .validator(restaurantPhotoVenueSchema)
  .handler(async ({ data }) => {
    const { RestaurantPhotoService } =
      await import("@/modules/restaurant-discovery/server/operations/photos");

    const { Effect } = await import("effect");

    const { actor, withActor, runClientOperation } = await memberContext();

    const views = await runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(RestaurantPhotoService, (service) => service.listForAdmin(data.venueId)),
          await photoServiceLayers(),
        ),
      ),
      null,
    );

    return restaurantPhotoAdminListSchema.parse(views);
  });

/** Staff review queue: pending-first window over `review`-status photos. */
export const listPhotoReviewQueue = createServerFn({ method: "GET" })
  .validator(restaurantPhotoReviewQueueSchema)
  .handler(async ({ data }) => {
    const { RestaurantPhotoService } =
      await import("@/modules/restaurant-discovery/server/operations/photos");

    const { Effect } = await import("effect");

    const { actor, withActor, runClientOperation } = await memberContext();

    // The queue SQL is latest-N with no offset; windowing happens here so
    // the transport keeps a stable limit/offset contract without touching
    // the service. Queue depth is bounded by the per-venue photo cap.
    const views = await runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(RestaurantPhotoService, (service) =>
            service.listReviewQueue(Math.min(data.offset + data.limit, 100)),
          ),
          await photoServiceLayers(),
        ),
      ),
      null,
    );

    return restaurantPhotoAdminListSchema.parse(views.slice(data.offset, data.offset + data.limit));
  });

/** Bounded editorial metadata edit. Author and grants resolve from the session, never input. */
export const updatePhotoMetadata = createServerFn({ method: "POST" })
  .validator(updateRestaurantPhotoMetadataSchema)
  .handler(async ({ data }) => {
    const { RestaurantPhotoService } =
      await import("@/modules/restaurant-discovery/server/operations/photos");

    const { Effect } = await import("effect");

    const { actor, withActor, runClientOperation } = await memberContext();

    const view = await runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(RestaurantPhotoService, (service) => service.updateMetadata(data)),
          await photoServiceLayers(),
        ),
      ),
      null,
    );

    return restaurantPhotoAdminSchema.parse(view);
  });

/** Display-order rewrite. Must name every photo of the venue exactly once. */
export const reorderPhotos = createServerFn({ method: "POST" })
  .validator(reorderRestaurantPhotosSchema)
  .handler(async ({ data }) => {
    const { RestaurantPhotoService } =
      await import("@/modules/restaurant-discovery/server/operations/photos");

    const { Effect } = await import("effect");

    const { actor, withActor, runClientOperation } = await memberContext();

    const views = await runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(RestaurantPhotoService, (service) =>
            service.reorderPhotos({ venueId: data.venueId, orderedIds: [...data.orderedIds] }),
          ),
          await photoServiceLayers(),
        ),
      ),
      null,
    );

    return restaurantPhotoAdminListSchema.parse(views);
  });

/** Draft (or failed-processing retry) → review. Published photos return to draft first, never re-enter. */
export const submitPhotoForReview = createServerFn({ method: "POST" })
  .validator(restaurantPhotoIdInputSchema)
  .handler(async ({ data }) => {
    const { RestaurantPhotoService } =
      await import("@/modules/restaurant-discovery/server/operations/photos");

    const { Effect } = await import("effect");

    const { actor, withActor, runClientOperation } = await memberContext();

    const view = await runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(RestaurantPhotoService, (service) =>
            service.submitForReview(data.photoId),
          ),
          await photoServiceLayers(),
        ),
      ),
      null,
    );

    return restaurantPhotoAdminSchema.parse(view);
  });

/** Review → published. Requires resolved storage derivatives, real license, attribution, and alt text. */
export const publishPhoto = createServerFn({ method: "POST" })
  .validator(restaurantPhotoIdInputSchema)
  .handler(async ({ data }) => {
    const { RestaurantPhotoService } =
      await import("@/modules/restaurant-discovery/server/operations/photos");

    const { Effect } = await import("effect");

    const { actor, withActor, runClientOperation } = await memberContext();

    const view = await runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(RestaurantPhotoService, (service) => service.publishPhoto(data.photoId)),
          await photoServiceLayers(),
        ),
      ),
      null,
    );

    return restaurantPhotoAdminSchema.parse(view);
  });

/** Review/published → draft. Revokes the public delivery URL in the same transaction as the audit row. */
export const withdrawPhoto = createServerFn({ method: "POST" })
  .validator(restaurantPhotoIdInputSchema)
  .handler(async ({ data }) => {
    const { RestaurantPhotoService } =
      await import("@/modules/restaurant-discovery/server/operations/photos");

    const { Effect } = await import("effect");

    const { actor, withActor, runClientOperation } = await memberContext();

    const view = await runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(RestaurantPhotoService, (service) => service.returnToDraft(data.photoId)),
          await photoServiceLayers(),
        ),
      ),
      null,
    );

    return restaurantPhotoAdminSchema.parse(view);
  });

/** Row delete plus best-effort object cleanup. Deleting a published photo needs the review grant. */
export const deletePhoto = createServerFn({ method: "POST" })
  .validator(restaurantPhotoIdInputSchema)
  .handler(async ({ data }) => {
    const { RestaurantPhotoService } =
      await import("@/modules/restaurant-discovery/server/operations/photos");

    const { Effect } = await import("effect");

    const { actor, withActor, runClientOperation } = await memberContext();

    const removed = await runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(RestaurantPhotoService, (service) => service.removePhoto(data.photoId)),
          await photoServiceLayers(),
        ),
      ),
      null,
    );

    return restaurantPhotoRemovedSchema.parse(removed);
  });

export interface ServedRestaurantPhoto {
  readonly bytes: Uint8Array;
  readonly contentType: "image/webp";
  readonly etag: string;
  readonly byteSize: number;
}

/**
 * Binary image response for one stored derivative. Mirrors the dish-image
 * route contract: versioned URLs are immutable (year-long public cache for
 * published derivatives), previews are session-gated and never cached.
 * Eligibility always runs before the If-None-Match short-circuit — a
 * withdrawn photo 404s at origin even with a previously valid ETag.
 */
export const restaurantPhotoImageResponse = (
  derivative: ServedRestaurantPhoto,
  options: { readonly preview: boolean; readonly ifNoneMatch: string | null },
): Response => {
  const headers = new Headers();

  headers.set("Content-Type", derivative.contentType);
  headers.set("Content-Length", String(derivative.byteSize));
  headers.set("ETag", derivative.etag);
  headers.set(
    "Cache-Control",
    options.preview ? "private, no-store" : "public, max-age=31536000, immutable",
  );

  if (!options.preview && options.ifNoneMatch !== null && options.ifNoneMatch === derivative.etag) {
    return new Response(null, { status: 304, headers });
  }

  const body = new Uint8Array(derivative.byteSize);

  body.set(derivative.bytes);

  return new Response(body, { status: 200, headers });
};

/**
 * Session-gated derivative fetch. `preview: true` serves ready bytes of
 * drafts and review items to signed-in `restaurant:read` holders for
 * re-review; `preview: false` serves published derivatives. Guests use the
 * public delivery URLs, never this entry point.
 */
export const previewPhoto = createServerFn({ method: "GET" })
  .validator(previewRestaurantPhotoSchema)
  .handler(async ({ data }) => {
    const { RestaurantPhotoService } =
      await import("@/modules/restaurant-discovery/server/operations/photos");

    const { Effect } = await import("effect");
    const { getRequestHeaders } = await import("@tanstack/react-start/server");

    const { actor, withActor, runClientOperation } = await memberContext();

    const derivative = await runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(RestaurantPhotoService, (service) =>
            service.serveDerivative({
              photoId: data.photoId,
              version: data.version,
              width: data.width,
              preview: data.preview,
            }),
          ),
          await photoServiceLayers(),
        ),
      ),
      null,
    );

    const ifNoneMatch = data.preview ? null : getRequestHeaders().get("if-none-match");

    return restaurantPhotoImageResponse(derivative, { preview: data.preview, ifNoneMatch });
  });

export interface StageRestaurantPhotoUpload {
  readonly fields: StageRestaurantPhotoFields;
  readonly bytes: Uint8Array;
  readonly filename: string;
}

/** FormData text entries decode through Zod before any branching. */
const textFieldSchema = z.union([z.string(), z.null()]);

/**
 * Multipart upload boundary for `stageVenuePhoto`. Exactly one upload path:
 * a File part plus text fields — never base64-in-JSON. Client size/type
 * hints are immediate feedback only; the service validates actual bytes,
 * dimensions, venue existence, and the 5-photo cap. Exported for tests;
 * the admin UI calls `stageVenuePhoto`, not this parser.
 */
export const parseStageUploadForm = async (form: FormData): Promise<StageRestaurantPhotoUpload> => {
  const { MAX_RESTAURANT_PHOTO_BYTES, RestaurantPhotoValidationFailed } =
    await import("@/modules/restaurant-discovery/server/operations/photos");

  const fail = (reason: string): never => {
    throw new RestaurantPhotoValidationFailed({ reason });
  };

  // FormData entries decode through Zod first; only the parsed domain
  // values (string | null) branch below, never raw entry representations.
  const textField = (key: string): string | null => {
    const parsed = textFieldSchema.safeParse(form.get(key));

    if (!parsed.success) throw fail(`"${key}" must be text.`);

    const trimmed = parsed.data?.trim() ?? "";

    return trimmed.length === 0 ? null : trimmed;
  };

  const focalField = (key: string): number | null => {
    const raw = textField(key);

    if (raw === null) return null;

    const parsed = Number(raw);

    if (!Number.isFinite(parsed)) throw fail(`"${key}" must be a number between 0 and 1.`);

    return parsed;
  };

  const file = form.get("file");

  if (!(file instanceof File)) throw fail("Choose a photo to upload.");

  if (file.size === 0) throw fail("empty file: choose a photo to upload.");

  if (file.size > MAX_RESTAURANT_PHOTO_BYTES) throw fail("photos must be 8 MiB or smaller");

  if (file.name.trim().length === 0) throw fail("the upload is missing a filename");

  const fields = stageRestaurantPhotoFieldsSchema.safeParse({
    venueId: form.get("venueId"),
    altText: textField("altText"),
    attribution: textField("attribution"),
    license: textField("license") ?? "unknown",
    focalX: focalField("focalX"),
    focalY: focalField("focalY"),
    sourceUrl: textField("sourceUrl"),
    makePrimary: form.get("makePrimary") === "true" || form.get("makePrimary") === "1",
  });

  if (!fields.success) throw fail(fields.error.issues.map((issue) => issue.message).join("; "));

  let bytes: Uint8Array;

  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw fail("Cannot read this photograph.");
  }

  return { fields: fields.data, bytes, filename: file.name };
};

/**
 * Staged upload: multipart/form-data with a `file` part plus text fields.
 * The `z.instanceof(FormData)` validator is type-legal for POST (TanStack
 * skips the serializable constraint for FormData inputs) and runs before
 * any byte is read; the handler still decodes the multipart body explicitly
 * and rejects anything else (including JSON/base64 payloads).
 */
export const stageVenuePhoto = createServerFn({ method: "POST" })
  .validator(stageRestaurantPhotoFormSchema)
  .handler(async ({ data }) => {
    const { RestaurantPhotoService, RestaurantPhotoValidationFailed } =
      await import("@/modules/restaurant-discovery/server/operations/photos");

    const { Effect } = await import("effect");

    const form = stageRestaurantPhotoFormSchema.safeParse(data);

    if (!form.success) {
      throw new RestaurantPhotoValidationFailed({
        reason: "Upload one photo as multipart/form-data.",
      });
    }

    const { fields, bytes, filename } = await parseStageUploadForm(form.data);
    const { actor, withActor, runClientOperation } = await memberContext();

    const view = await runClientOperation(
      withActor(
        actor,
        Effect.provide(
          Effect.flatMap(RestaurantPhotoService, (service) =>
            service.stagePhoto({ ...fields, bytes, filename }),
          ),
          await photoServiceLayers(),
        ),
      ),
      null,
    );

    return restaurantPhotoAdminSchema.parse(view);
  });
