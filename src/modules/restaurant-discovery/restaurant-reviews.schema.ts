import { z } from "zod";

import { CUSTOMER_REVIEW_BODY_MAX } from "@/modules/restaurant-discovery/server/operations/customer-reviews";

export const customerReviewRatingSchema = z.number().int().min(1).max(5);

export const customerReviewBodySchema = z
  .string()
  .trim()
  .min(1, "Review text is required")
  .max(CUSTOMER_REVIEW_BODY_MAX, "Review text must be at most 2000 characters");

export const customerReviewVenueSchema = z.object({ venueId: z.uuid() });

export const customerReviewListSchema = z.object({
  venueId: z.uuid(),
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
