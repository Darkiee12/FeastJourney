import { z } from "zod";

import {
  CUSTOMER_REVIEW_BODY_MAX,
  CUSTOMER_REVIEW_SORT_MODES,
} from "@/modules/restaurant-discovery/restaurant-reviews.constants";

export const customerReviewRatingSchema = z.number().int().min(1).max(5);

export const customerReviewBodySchema = z
  .string()
  .trim()
  .min(1, "Review text is required")
  .max(CUSTOMER_REVIEW_BODY_MAX, "Review text must be at most 2000 characters");

export const customerReviewVenueSchema = z.object({ venueId: z.uuid() });

/**
 * Sort modes for server-side list ordering. The list validator defaults to
 * `recent`; the SQL orders by allowlisted CASE branch, never interpolation.
 */
export const customerReviewSortSchema = z.enum(CUSTOMER_REVIEW_SORT_MODES);

export type CustomerReviewSort = z.infer<typeof customerReviewSortSchema>;

export const customerReviewListSchema = z.object({
  venueId: z.uuid(),
  sort: customerReviewSortSchema.default("recent"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const customerReviewSubmitSchema = z.object({
  venueId: z.uuid(),
  rating: customerReviewRatingSchema,
  body: customerReviewBodySchema,
});

export const customerReviewUpdateSchema = z.object({
  reviewId: z.uuid(),
  rating: customerReviewRatingSchema,
  body: customerReviewBodySchema,
});

export const customerReviewIdSchema = z.object({ reviewId: z.uuid() });

export const customerReviewModerateSchema = z.object({
  reviewId: z.uuid(),
  status: z.enum(["published", "rejected", "removed"]),
});

/**
 * Public list item: the published-only SQL projection. No author identity,
 * venue redundancy, or moderation internals ever reach the browser.
 */
export const customerReviewPublicSchema = z.object({
  id: z.uuid(),
  rating: customerReviewRatingSchema,
  body: z.string(),
  created_at: z.string(),
  published_at: z.string().nullable(),
});

export type CustomerReviewPublic = z.infer<typeof customerReviewPublicSchema>;

/** Public page envelope: public items plus the windowed total. */
export const customerReviewPublicPageSchema = z.object({
  items: z.array(customerReviewPublicSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(50),
  offset: z.number().int().min(0),
});

export type CustomerReviewPublicPage = z.infer<typeof customerReviewPublicPageSchema>;

/**
 * My-review request: venue only. The author always resolves from the
 * verified session; browser input cannot name an author.
 */
export const customerReviewOwnRequestSchema = z.object({ venueId: z.uuid() });

export type CustomerReviewOwnRequest = z.infer<typeof customerReviewOwnRequestSchema>;

/** Own active review: editable fields plus moderation status, no author identity. */
export const customerReviewOwnResponseSchema = z.object({
  id: z.uuid(),
  venue_id: z.uuid(),
  rating: customerReviewRatingSchema,
  body: z.string(),
  status: z.enum(["pending", "published"]),
  created_at: z.string(),
  updated_at: z.string(),
  published_at: z.string().nullable(),
});

export type CustomerReviewOwnResponse = z.infer<typeof customerReviewOwnResponseSchema>;

/**
 * Staff moderation queue: cross-venue, any status, pending-first. Bodies
 * are visible to `restaurant:review` holders only — never on public reads.
 */
export const customerReviewQueueStatusSchema = z.enum([
  "pending",
  "published",
  "rejected",
  "removed",
  "all",
]);

export type CustomerReviewQueueStatus = z.infer<typeof customerReviewQueueStatusSchema>;

export const customerReviewQueueSchema = z.object({
  venue: z.string().trim().max(200).default(""),
  status: customerReviewQueueStatusSchema.default("pending"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CustomerReviewQueueInput = z.infer<typeof customerReviewQueueSchema>;

export const customerReviewQueueEntrySchema = z.object({
  id: z.uuid(),
  venue_id: z.uuid(),
  venue_name: z.string(),
  rating: customerReviewRatingSchema,
  body: z.string(),
  status: z.enum(["pending", "published", "rejected", "removed"]),
  submitted_at: z.string(),
});

export type CustomerReviewQueueEntry = z.infer<typeof customerReviewQueueEntrySchema>;

export const customerReviewQueuePageSchema = z.object({
  items: z.array(customerReviewQueueEntrySchema),
  total: z.number().int().nonnegative(),
  pending_count: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(50),
  offset: z.number().int().min(0),
});

export type CustomerReviewQueuePage = z.infer<typeof customerReviewQueuePageSchema>;
