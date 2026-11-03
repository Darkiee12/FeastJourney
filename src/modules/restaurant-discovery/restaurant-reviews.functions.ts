import { createServerFn } from "@tanstack/react-start";

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
