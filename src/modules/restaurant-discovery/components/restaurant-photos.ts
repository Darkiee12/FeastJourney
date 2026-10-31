import { z } from "zod";

/**
 * Client-safe restaurant photo contract.
 *
 * Pure module: no React, no DOM, no secrets. Server operations
 * (`server/operations/photos.ts`) build these values; result cards, the
 * detail gallery, and Agent A's venue preview consume them. The venue
 * preview renders from fixtures until the search/detail loaders land the
 * real `photos` field, so every consumer must handle the empty set with a
 * branded fallback and never invent photos for real venues.
 */

/** One published venue photo with same-origin delivery variants. */
export interface PhotoRef {
  readonly assetId: string;
  readonly alt: string;
  readonly primary: boolean;
  readonly width: number;
  readonly height: number;
  readonly variants: ReadonlyArray<{ readonly width: number; readonly url: string }>;
}

/** Stored WebP derivative widths. Resizes never upscale. */
export const RESTAURANT_PHOTO_WIDTHS = [400, 800, 1600] as const;

export type RestaurantPhotoWidth = (typeof RESTAURANT_PHOTO_WIDTHS)[number];

/** Same-origin delivery URL for one stored derivative. Immutable per version. */
export const restaurantPhotoUrl = (assetId: string, version: number, width: number): string =>
  `/api/v1/restaurant-images/${assetId}/${version}/${width}`;

export const restaurantPhotoSrcSet = (assetId: string, version: number): string =>
  RESTAURANT_PHOTO_WIDTHS.map(
    (width) => `${restaurantPhotoUrl(assetId, version, width)} ${width}w`,
  ).join(", ");

/** Authorized (session-gated) preview URL for drafts and review items. */
export const restaurantPhotoPreviewUrl = (
  assetId: string,
  version: number,
  width: number,
): string => `${restaurantPhotoUrl(assetId, version, width)}?preview=1`;

const photoVariantSchema = z.object({ width: z.number(), url: z.string() });

export const photoRefSchema = z.object({
  assetId: z.string(),
  alt: z.string(),
  primary: z.boolean(),
  width: z.number(),
  height: z.number(),
  variants: z.array(photoVariantSchema),
});

export const photoRefsSchema = z.array(photoRefSchema);

/** Loader payload shape once photo delivery wires in. Until the
 *  search/detail loaders provide it, payloads without `photos` parse to
 *  the branded empty state instead of crashing. */
export const photoLoaderSchema = z.object({ photos: photoRefsSchema.optional() });
