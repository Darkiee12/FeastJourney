import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { z } from "zod";

import {
  customerReviewIdSchema,
  customerReviewListSchema,
  customerReviewModerateSchema,
  customerReviewOwnRequestSchema,
  customerReviewOwnResponseSchema,
  customerReviewPublicPageSchema,
  customerReviewQueuePageSchema,
  customerReviewQueueSchema,
  customerReviewSubmitSchema,
  customerReviewUpdateSchema,
  customerReviewVenueSchema,
} from "@/modules/restaurant-discovery/restaurant-reviews.schema";
import type { Database } from "@/server/database/client";
import type { DatabaseError } from "@/server/database/query";

export const getRestaurantReviewSummaryFn = createServerFn({ method: "GET" })
  .validator(customerReviewVenueSchema)
  .handler(async ({ data }) => {
    const { getRestaurantReviewSummary } =
      await import("@/modules/restaurant-discovery/server/index");

    const { runClientOperation } = await import("@/server/http/run-client-operation");

    return runClientOperation(getRestaurantReviewSummary(data.venueId), "public");
  });

export const listRestaurantCustomerReviewsFn = createServerFn({ method: "GET" })
  .validator(customerReviewListSchema)
  .handler(async ({ data }) => {
    const { listRestaurantCustomerReviews } =
      await import("@/modules/restaurant-discovery/server/index");

    const { runClientOperation } = await import("@/server/http/run-client-operation");

    const page = await runClientOperation(listRestaurantCustomerReviews(data), "public");

    return customerReviewPublicPageSchema.parse(page);
  });

export const getOwnRestaurantCustomerReviewFn = createServerFn({ method: "GET" })
  .validator(customerReviewOwnRequestSchema)
  .handler(async ({ data }) => {
    const { getOwnRestaurantReview } = await import("@/modules/restaurant-discovery/server/index");

    const { actor, withActor, runClientOperation } = await memberContext();

    const review = await runClientOperation(withActor(actor, getOwnRestaurantReview(data)), null);

    return customerReviewOwnResponseSchema.nullable().parse(review);
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

export const submitRestaurantCustomerReviewFn = createServerFn({ method: "POST" })
  .validator(customerReviewSubmitSchema)
  .handler(async ({ data }) => {
    const { submitRestaurantCustomerReview } =
      await import("@/modules/restaurant-discovery/server/index");

    const { actor, withActor, runClientOperation } = await memberContext();

    return runClientOperation(withActor(actor, submitRestaurantCustomerReview(data)), null);
  });

export const updateOwnRestaurantCustomerReviewFn = createServerFn({ method: "POST" })
  .validator(customerReviewUpdateSchema)
  .handler(async ({ data }) => {
    const { updateOwnRestaurantCustomerReview } =
      await import("@/modules/restaurant-discovery/server/index");

    const { actor, withActor, runClientOperation } = await memberContext();

    return runClientOperation(withActor(actor, updateOwnRestaurantCustomerReview(data)), null);
  });

export const deleteOwnRestaurantCustomerReviewFn = createServerFn({ method: "POST" })
  .validator(customerReviewIdSchema)
  .handler(async ({ data }) => {
    const { deleteOwnRestaurantCustomerReview } =
      await import("@/modules/restaurant-discovery/server/index");

    const { actor, withActor, runClientOperation } = await memberContext();

    return runClientOperation(withActor(actor, deleteOwnRestaurantCustomerReview(data)), null);
  });

export const moderateRestaurantCustomerReviewFn = createServerFn({ method: "POST" })
  .validator(customerReviewModerateSchema)
  .handler(async ({ data }) => {
    const { moderateRestaurantCustomerReview } =
      await import("@/modules/restaurant-discovery/server/index");

    const { actor, withActor, runClientOperation } = await memberContext();

    return runClientOperation(withActor(actor, moderateRestaurantCustomerReview(data)), null);
  });

export const listCustomerReviewQueueFn = createServerFn({ method: "GET" })
  .validator(customerReviewQueueSchema)
  .handler(async ({ data }) => {
    const { listCustomerReviewQueue } = await import("@/modules/restaurant-discovery/server/index");

    const { actor, withActor, runClientOperation } = await memberContext();

    const page = await runClientOperation(withActor(actor, listCustomerReviewQueue(data)), null);

    return customerReviewQueuePageSchema.parse(page);
  });

// ---------------------------------------------------------------------------
// Review-intelligence query support (additive; existing moderation and audit
// semantics above are untouched).
//
// Published-only fetch-by-IDs plus fingerprint timestamps for the
// review-intelligence service (translation, cited evidence). Reads filter to
// status = 'published' rows of published venues server-side; the projection
// never carries author identity or moderation internals. updated_at is
// exposed so translation caches and summary fingerprints invalidate when a
// review's text lifecycle changes (edits always unpublish first).
// ---------------------------------------------------------------------------

/**
 * Published-only intelligence row: evidence-grade fields plus the row
 * clocks that fingerprint and translation-cache keys are built from.
 */
export interface PublishedIntelligenceReview {
  readonly id: string;
  readonly venue_id: string;
  readonly rating: number;
  readonly body: string;
  readonly updated_at: string | null;
  readonly published_at: string | null;
}

const reviewIntelligenceIdsSchema = z.object({
  ids: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
});

const publishedIntelligenceReviewSchema = z.object({
  id: z.string().min(1).max(120),
  venue_id: z.string().min(1).max(120),
  rating: z.number().int().min(1).max(5),
  body: z.string().min(1).max(2000),
  updated_at: z.string().nullable(),
  published_at: z.string().nullable(),
});

/**
 * Published-only fetch-by-IDs for review intelligence. Malformed UUIDs are
 * omitted (never sent to SQL); unpublished, missing, or venue-unpublished
 * rows are omitted (never leaked). Bounded to 20 ids per call.
 */
export const fetchPublishedReviewsByIds = (
  ids: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<PublishedIntelligenceReview>, DatabaseError, Database> =>
  Effect.gen(function* () {
    const [{ runQuery }, { default: findQuery }, { default: venueQuery }] = yield* Effect.promise(
      () =>
        Promise.all([
          import("@/server/database/query"),
          import("@/modules/restaurant-discovery/server/repository/sql/customer-review-find.sql"),
          import("@/modules/restaurant-discovery/server/repository/sql/customer-review-venue.sql"),
        ]),
    );

    const unique = [...new Set(ids)].filter((id) => z.uuid().safeParse(id).success).slice(0, 20);

    const found = yield* Effect.forEach(
      unique,
      (id) => runQuery("restaurants/customer-review-find", (sql) => findQuery.run(sql, { id })),
      { concurrency: 4 },
    );

    const published = found.filter(
      (row): row is Exclude<(typeof found)[number], null> & { readonly status: "published" } =>
        row !== null && row.status === "published",
    );

    if (published.length === 0) {
      return [];
    }

    const venueIds = [...new Set(published.map((row) => row.venue_id))];

    const venues = yield* Effect.forEach(
      venueIds,
      (venueId) =>
        runQuery("restaurants/customer-review-venue", (sql) =>
          venueQuery.run(sql, { id: venueId }),
        ),
      { concurrency: 4 },
    );

    const liveVenues = new Set(
      venues
        .filter(
          (
            venue,
          ): venue is Exclude<(typeof venues)[number], null> & {
            readonly status: "published";
          } => venue !== null && venue.status === "published",
        )
        .map((venue) => venue.id),
    );

    return published
      .filter((row) => liveVenues.has(row.venue_id))
      .map((row) => ({
        id: row.id,
        venue_id: row.venue_id,
        rating: row.rating,
        body: row.body,
        updated_at: row.updated_at,
        published_at: row.published_at,
      }));
  });

/**
 * Public: published-only reads for cited evidence, by IDs. Omitted rows
 * (unpublished, missing, venue-unpublished) stay omitted; the projection
 * carries no author identity or moderation internals.
 */
export const getPublishedReviewsByIdsFn = createServerFn({ method: "POST" })
  .validator(reviewIntelligenceIdsSchema)
  .handler(async ({ data }) => {
    const { runClientOperation } = await import("@/server/http/run-client-operation");

    const rows = await runClientOperation(fetchPublishedReviewsByIds(data.ids), "public");

    return z.array(publishedIntelligenceReviewSchema).parse(rows);
  });
