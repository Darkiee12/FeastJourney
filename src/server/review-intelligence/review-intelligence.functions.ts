import { createServerFn } from "@tanstack/react-start";

import {
  reviewHighlightsOutcomeSchema,
  reviewHighlightsRequestSchema,
  supportingReviewListSchema,
  supportingReviewsRequestSchema,
  translateReviewOutcomeSchema,
  translateReviewRequestSchema,
} from "@/server/review-intelligence/review-schemas";

/**
 * Review-intelligence transport: Zod 4.6 validation at the boundary,
 * content-aware cached highlights, on-demand cached translation, and
 * published-only supporting reads. The model choice, transport, and budgets
 * come from server configuration only — never from client input. Outcomes
 * are client-safe JSON. Public reads (guests allowed); abuse protection
 * runs before every call via the rate-limit bucket.
 */

const intelligenceLayers = async () => {
  const { Effect, Layer } = await import("effect");

  const { ReviewIntelligenceClientLive } =
    await import("@/server/review-intelligence/review-intelligence-client");

  const { ReviewIntelligence, ReviewIntelligenceLive } =
    await import("@/server/review-intelligence/review-intelligence-service");

  const { runClientOperation } = await import("@/server/http/run-client-operation");

  return {
    Effect,
    Layer,
    ReviewIntelligence,
    ReviewIntelligenceLive,
    ReviewIntelligenceClientLive,
    runClientOperation,
  };
};

/**
 * Public: cached AI highlights for one venue's published reviews. Returns
 * Ready (with honest sampleCount vs totalCount), Insufficient (fewer than
 * five meaningful published reviews), or Unavailable (disabled, provider,
 * or validation failure). Never exposes review bodies, prompts, or keys.
 */
export const reviewHighlightsFn = createServerFn({ method: "GET" })
  .validator(reviewHighlightsRequestSchema)
  .handler(async ({ data }) => {
    const {
      Effect,
      Layer,
      ReviewIntelligence,
      ReviewIntelligenceLive,
      ReviewIntelligenceClientLive,
      runClientOperation,
    } = await intelligenceLayers();

    const program = Effect.flatMap(ReviewIntelligence, (service) =>
      service.getReviewHighlights(data),
    );

    const outcome = await runClientOperation(
      Effect.provide(program, Layer.provide(ReviewIntelligenceLive, ReviewIntelligenceClientLive)),
      "search",
    );

    return reviewHighlightsOutcomeSchema.parse(outcome);
  });

/**
 * Public: on-demand translation of one published review. Returns Done with
 * the translation plus detected source language, or Failed (unknown,
 * unpublished, or untranslatable review; provider failure). The original
 * stored review is never overwritten; failures keep the original text.
 */
export const translateReviewFn = createServerFn({ method: "POST" })
  .validator(translateReviewRequestSchema)
  .handler(async ({ data }) => {
    const {
      Effect,
      Layer,
      ReviewIntelligence,
      ReviewIntelligenceLive,
      ReviewIntelligenceClientLive,
      runClientOperation,
    } = await intelligenceLayers();

    const program = Effect.flatMap(ReviewIntelligence, (service) => service.translateReview(data));

    const outcome = await runClientOperation(
      Effect.provide(program, Layer.provide(ReviewIntelligenceLive, ReviewIntelligenceClientLive)),
      "search",
    );

    return translateReviewOutcomeSchema.parse(outcome);
  });

/**
 * Public: published-only reads for cited evidence. Returns only reviews
 * that are still published at read time — unpublished, missing, or
 * venue-unpublished rows are omitted, never leaked. Server-authorized by
 * construction: the query filters status and venue server-side and the
 * projection carries no author identity or moderation internals.
 */
export const supportingReviewsFn = createServerFn({ method: "POST" })
  .validator(supportingReviewsRequestSchema)
  .handler(async ({ data }) => {
    const {
      Effect,
      Layer,
      ReviewIntelligence,
      ReviewIntelligenceLive,
      ReviewIntelligenceClientLive,
      runClientOperation,
    } = await intelligenceLayers();

    const program = Effect.flatMap(ReviewIntelligence, (service) =>
      service.getSupportingReviews(data),
    );

    const rows = await runClientOperation(
      Effect.provide(program, Layer.provide(ReviewIntelligenceLive, ReviewIntelligenceClientLive)),
      "public",
    );

    return supportingReviewListSchema.parse(rows);
  });
