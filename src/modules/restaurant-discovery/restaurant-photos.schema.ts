import { z } from "zod";

/**
 * Licenses the editor may attach. Single source of truth, kept in this
 * browser-safe module (zod only): the server service imports it from here
 * so the browser bundle never pulls in the server operation module
 * (sharp/postgres/S3) through this schema.
 */
export const SUPPORTED_PHOTO_LICENSES = [
  "own-work",
  "cc0",
  "cc-by",
  "cc-by-sa",
  "licensed",
] as const;

export type PhotoLicense = (typeof SUPPORTED_PHOTO_LICENSES)[number];

/**
 * Browser transport schemas for first-party venue photography.
 *
 * Pure module: no DB, no secrets, no object SDKs. Every server function in
 * `restaurant-photos.functions.ts` validates its input with these schemas
 * before touching the Effect service; the service re-validates actual image
 * bytes and dimensions server-side (Sharp) and enforces venue existence,
 * the 5-photo cap, and grant checks. Client limits here are immediate
 * feedback only — never the security boundary.
 */

export const restaurantPhotoIdSchema = z.uuid();

export const restaurantPhotoVenueSchema = z.object({ venueId: z.uuid() });

/** Licenses the editor may attach. `unknown` is storable at draft stage but never publishable. */
export const restaurantPhotoLicenseSchema = z.enum([...SUPPORTED_PHOTO_LICENSES, "unknown"]);

export type RestaurantPhotoLicense = z.infer<typeof restaurantPhotoLicenseSchema>;

const altTextSchema = z.string().trim().max(500, "Alt text must be at most 500 characters");

const attributionSchema = z.string().trim().max(500, "Attribution must be at most 500 characters");

const focalSchema = z.number().min(0).max(1);

const sourceUrlSchema = z
  .string()
  .trim()
  .max(2000, "Source URL must be at most 2000 characters")
  .refine((value) => value.startsWith("https://"), "Source URL must be an https URL");

/** Bounded editorial metadata shared by staged upload and metadata edits. */
export const restaurantPhotoMetadataFieldsSchema = z.object({
  altText: altTextSchema.nullable(),
  attribution: attributionSchema.nullable(),
  license: restaurantPhotoLicenseSchema,
  focalX: focalSchema.nullable(),
  focalY: focalSchema.nullable(),
  sourceUrl: sourceUrlSchema.nullable(),
});

export type RestaurantPhotoMetadataFields = z.infer<typeof restaurantPhotoMetadataFieldsSchema>;

/** Metadata edit: photo identity plus bounded fields. Author comes from the session, never input. */
export const updateRestaurantPhotoMetadataSchema = restaurantPhotoMetadataFieldsSchema.extend({
  photoId: restaurantPhotoIdSchema,
});

export type UpdateRestaurantPhotoMetadata = z.infer<typeof updateRestaurantPhotoMetadataSchema>;

/** Staged upload payload: the whole multipart body, gated to FormData before field parsing. */
export const stageRestaurantPhotoFormSchema = z.instanceof(FormData);

export type StageRestaurantPhotoForm = z.infer<typeof stageRestaurantPhotoFormSchema>;

/** Staged upload fields carried alongside the multipart file part. Bytes arrive as a File, never JSON. */
export const stageRestaurantPhotoFieldsSchema = restaurantPhotoMetadataFieldsSchema.extend({
  venueId: z.uuid(),
  makePrimary: z.boolean().default(false),
});

export type StageRestaurantPhotoFields = z.infer<typeof stageRestaurantPhotoFieldsSchema>;

/**
 * Full reorder contract: the service requires every photo of the venue
 * exactly once, so partial moves and cross-venue id lists conflict instead
 * of silently dropping rows.
 */
export const reorderRestaurantPhotosSchema = z.object({
  venueId: z.uuid(),
  orderedIds: z.array(z.uuid()).min(1).max(5),
});

export type ReorderRestaurantPhotos = z.infer<typeof reorderRestaurantPhotosSchema>;

export const restaurantPhotoIdInputSchema = z.object({ photoId: restaurantPhotoIdSchema });

/** Staff review queue page: pending-first, server-paginated, bounded like other review queues. */
export const restaurantPhotoReviewQueueSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type RestaurantPhotoReviewQueueInput = z.infer<typeof restaurantPhotoReviewQueueSchema>;

/** Derivative selector. Only stored WebP widths resolve; anything else 404s without probing storage. */
export const previewRestaurantPhotoSchema = z.object({
  photoId: restaurantPhotoIdSchema,
  version: z.coerce.number().int().min(1).default(1),
  width: z.coerce
    .number()
    .int()
    .default(800)
    .refine((width) => [400, 800, 1600].includes(width), {
      message: "Width must be one of 400, 800, 1600",
    }),
  preview: z.coerce.boolean().default(true),
});

export type PreviewRestaurantPhoto = z.infer<typeof previewRestaurantPhotoSchema>;

/**
 * Client-safe staff view of one venue photo. Exact keys (strict): storage
 * object keys and content checksums never cross this boundary — delivery
 * and preview resolve through same-origin versioned URLs only.
 */
export const restaurantPhotoAdminSchema = z.strictObject({
  id: z.uuid(),
  venueId: z.uuid(),
  status: z.enum(["draft", "review", "published"]),
  sortOrder: z.number().int().nonnegative(),
  isPrimary: z.boolean(),
  altText: z.string().nullable(),
  attribution: z.string().nullable(),
  license: z.string(),
  focalX: z.number().nullable(),
  focalY: z.number().nullable(),
  originalWidth: z.number().nullable(),
  originalHeight: z.number().nullable(),
  format: z.string().nullable(),
  byteSize: z.number().nullable(),
  processing: z.enum(["processing", "ready", "failed"]),
  variantVersion: z.number().int().min(1),
  uploadedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  deliveryUrl: z.string().nullable(),
  srcSet: z.string().nullable(),
  previewUrl: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export type RestaurantPhotoAdmin = z.infer<typeof restaurantPhotoAdminSchema>;

export const restaurantPhotoAdminListSchema = z.array(restaurantPhotoAdminSchema);

export type RestaurantPhotoAdminList = z.infer<typeof restaurantPhotoAdminListSchema>;

/** Delete outcome: row identity only. Object cleanup is best-effort server-side, never client-driven. */
export const restaurantPhotoRemovedSchema = z.strictObject({
  id: z.uuid(),
  venueId: z.uuid(),
});

export type RestaurantPhotoRemoved = z.infer<typeof restaurantPhotoRemovedSchema>;
