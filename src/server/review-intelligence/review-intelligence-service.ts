import { createHash } from "node:crypto";

import { Context, Data, Effect, Layer, Match } from "effect";

import { fetchPublishedReviewsByIds } from "@/modules/restaurant-discovery/restaurant-reviews.functions";
import {
  getRestaurantReviewSummary,
  listRestaurantCustomerReviews,
} from "@/modules/restaurant-discovery/server/operations/customer-reviews";
import type { Database } from "@/server/database/client";
import type { DatabaseError } from "@/server/database/query";
import {
  ReviewIntelligenceClient,
  type ReviewIntelligenceClientService,
} from "@/server/review-intelligence/review-intelligence-client";
import {
  REVIEW_INTELLIGENCE_EXTREME_POOL,
  REVIEW_INTELLIGENCE_MAX_REVIEW_CHARS,
  REVIEW_INTELLIGENCE_MAX_SAMPLE,
  REVIEW_INTELLIGENCE_MIN_MEANINGFUL,
  REVIEW_INTELLIGENCE_MIN_MEANINGFUL_CHARS,
  REVIEW_INTELLIGENCE_PROMPT_VERSION,
  REVIEW_INTELLIGENCE_RECENT_POOL,
  REVIEW_HTML_TAG_PATTERN,
  UNSAFE_REVIEW_CLAIM_PATTERN,
  resolveReviewIntelligenceConfig,
  type ReviewIntelligenceConfig,
  type ReviewIntelligenceLanguage,
  type SupportingReview,
} from "@/server/review-intelligence/review-schemas";
import {
  defaultReviewSummaryCacheOptions,
  makeReviewSummaryCache,
  makeReviewTranslationCache,
  normalizeReviewSummaryCacheKey,
  normalizeReviewTranslationCacheKey,
  type ReviewSummaryCache,
  type ReviewTranslationCache,
} from "@/server/review-intelligence/review-summary-cache";

/**
 * Review-intelligence application service. Exactly one provider call per
 * cache miss; every provider or transport failure maps to a client-safe
 * outcome (Unavailable/Failed), never thrown and never cached as negative.
 * Budgets enforced here: bounded sampling pool, per-review character cap,
 * single call, response-byte cap (via the client). Structured logs carry
 * outcome/counts/duration only — never queries, PII, keys, prompts, or
 * review bodies.
 *
 * Sampling budget (honest by construction): the outcome carries both
 * sampleCount (reviews sent to the provider) and totalCount (all published
 * reviews for the venue), so callers can always state the coverage.
 */

export type ReviewHighlightsOutcome = Data.TaggedEnum<{
  Ready: {
    readonly overview: string;
    readonly positives: ReadonlyArray<string>;
    readonly cautions: ReadonlyArray<string>;
    readonly evidence: ReadonlyArray<{ readonly reviewId: string; readonly snippet: string }>;
    readonly sampleCount: number;
    readonly totalCount: number;
    readonly generatedAt: string;
  };
  Insufficient: {};
  Unavailable: {};
}>;

export const ReviewHighlightsOutcome = Data.taggedEnum<ReviewHighlightsOutcome>();

export type TranslateReviewOutcome = Data.TaggedEnum<{
  Done: { readonly translation: string; readonly sourceLang: string };
  Failed: {};
}>;

export const TranslateReviewOutcome = Data.taggedEnum<TranslateReviewOutcome>();

export class ReviewHighlightsInvalid extends Data.TaggedError("ReviewHighlightsInvalid")<{
  readonly reason: string;
}> {}

export interface ReviewHighlightsInput {
  readonly venueId: string;
  readonly language: ReviewIntelligenceLanguage;
}

export interface TranslateReviewInput {
  readonly reviewId: string;
  readonly target: ReviewIntelligenceLanguage;
}

export interface SupportingReviewsInput {
  readonly ids: ReadonlyArray<string>;
}

export interface ReviewIntelligenceService {
  readonly getReviewHighlights: (
    input: ReviewHighlightsInput,
  ) => Effect.Effect<ReviewHighlightsOutcome, never, Database>;
  readonly translateReview: (
    input: TranslateReviewInput,
  ) => Effect.Effect<TranslateReviewOutcome, never, Database>;
  readonly getSupportingReviews: (
    input: SupportingReviewsInput,
  ) => Effect.Effect<ReadonlyArray<SupportingReview>, DatabaseError, Database>;
}

export class ReviewIntelligence extends Context.Service<
  ReviewIntelligence,
  ReviewIntelligenceService
>()("feastjourney/review-intelligence/ReviewIntelligence") {}

export interface ReviewIntelligenceDeps {
  readonly client: ReviewIntelligenceClientService;
  readonly config: ReviewIntelligenceConfig;
  readonly summaryCache: ReviewSummaryCache<ReviewHighlightsOutcome>;
  readonly translationCache: ReviewTranslationCache;
}

interface SampledReview {
  readonly id: string;
  readonly rating: number;
  readonly publishedAt: string | null;
  readonly body: string;
}

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

/**
 * Deterministic stratification across ratings and recency. The pool arrives
 * newest-first; buckets preserve that order and round-robin starts at five
 * stars, so the sample always mixes top praise with lower-rated concerns
 * instead of collapsing to the loudest recent mood. No section is ever
 * forced downstream: the prompt allows empty positives/cautions.
 */
export const stratifySample = (
  pool: ReadonlyArray<SampledReview>,
  maxSample: number,
): ReadonlyArray<SampledReview> => {
  const buckets: Array<Array<SampledReview>> = [[], [], [], [], []];

  for (const review of pool) {
    const bucket = buckets[review.rating - 1];

    if (bucket !== undefined) {
      bucket.push(review);
    }
  }

  const sampled: Array<SampledReview> = [];

  for (let round = 0; sampled.length < maxSample; round += 1) {
    let progressed = false;

    for (let stars = 5; stars >= 1; stars -= 1) {
      if (sampled.length >= maxSample) {
        break;
      }

      const bucket = buckets[stars - 1];
      const pick = bucket?.[round];

      if (pick !== undefined) {
        sampled.push(pick);
        progressed = true;
      }
    }

    if (!progressed) {
      break;
    }
  }

  return sampled;
};

/**
 * Content-aware fingerprint over the exact generation input. Sorted review
 * tuples (id, moderation clock, rating, full body) plus the published total
 * mean any moderation decision, edit, removal, or new review changes the
 * key; a bare count is never used alone. Edits always unpublish first
 * (update-own sets pending and clears published_at), so published_at plus
 * body text subsumes updated_at for published rows.
 */
export const fingerprintSample = (input: {
  readonly venueId: string;
  readonly language: string;
  readonly total: number;
  readonly promptVersion: string;
  readonly model: string;
  readonly sample: ReadonlyArray<SampledReview>;
}): string => {
  const tuples = input.sample
    .map((review) => [review.id, review.publishedAt ?? "", review.rating, review.body] as const)
    .toSorted((left, right) => {
      if (left[0] < right[0]) {
        return -1;
      }

      if (left[0] > right[0]) {
        return 1;
      }

      return 0;
    });

  return createHash("sha256")
    .update(
      JSON.stringify({
        venue: input.venueId,
        language: input.language,
        total: input.total,
        prompt: input.promptVersion,
        model: input.model,
        sample: tuples,
      }),
    )
    .digest("hex");
};

const failWith = (reason: string) => Effect.fail(new ReviewHighlightsInvalid({ reason }));

const logSourceFailure = (step: string) => (error: { readonly _tag: string }) =>
  Effect.logWarning("Review highlights source failed").pipe(
    Effect.annotateLogs({ step, failure: error._tag }),
  );

export const makeReviewIntelligence = (deps: ReviewIntelligenceDeps): ReviewIntelligenceService => {
  const getReviewHighlights = (input: ReviewHighlightsInput) =>
    Effect.gen(function* () {
      if (!deps.config.enabled) {
        yield* Effect.logInfo("Review highlights skipped").pipe(
          Effect.annotateLogs({ reason: "disabled" }),
        );

        return ReviewHighlightsOutcome.Unavailable();
      }

      const startedAt = Date.now();

      const summary = yield* getRestaurantReviewSummary(input.venueId).pipe(
        Effect.tapError(logSourceFailure("summary")),
        Effect.catchTag("UnknownVenue", () => failWith("unknown-venue")),
        Effect.mapError(() => new ReviewHighlightsInvalid({ reason: "summary" })),
      );

      const recent = yield* listRestaurantCustomerReviews({
        venueId: input.venueId,
        sort: "recent",
        limit: REVIEW_INTELLIGENCE_RECENT_POOL,
        offset: 0,
      }).pipe(
        Effect.tapError(logSourceFailure("pool")),
        Effect.mapError(() => new ReviewHighlightsInvalid({ reason: "pool" })),
      );

      const highest = yield* listRestaurantCustomerReviews({
        venueId: input.venueId,
        sort: "highest",
        limit: REVIEW_INTELLIGENCE_EXTREME_POOL,
        offset: 0,
      }).pipe(
        Effect.tapError(logSourceFailure("pool")),
        Effect.mapError(() => new ReviewHighlightsInvalid({ reason: "pool" })),
      );

      const lowest = yield* listRestaurantCustomerReviews({
        venueId: input.venueId,
        sort: "lowest",
        limit: REVIEW_INTELLIGENCE_EXTREME_POOL,
        offset: 0,
      }).pipe(
        Effect.tapError(logSourceFailure("pool")),
        Effect.mapError(() => new ReviewHighlightsInvalid({ reason: "pool" })),
      );

      const byId = new Map<string, SampledReview>();

      for (const row of [...recent.items, ...highest.items, ...lowest.items]) {
        if (!byId.has(row.id)) {
          byId.set(row.id, {
            id: row.id,
            rating: row.rating,
            publishedAt: row.published_at,
            body: row.body,
          });
        }
      }

      const meaningful = [...byId.values()]
        .filter(
          (review) =>
            normalizeWhitespace(review.body).length >= REVIEW_INTELLIGENCE_MIN_MEANINGFUL_CHARS,
        )
        .toSorted((left, right) => {
          if (left.publishedAt === null && right.publishedAt === null) {
            return left.id < right.id ? -1 : 1;
          }

          if (left.publishedAt === null) {
            return 1;
          }

          if (right.publishedAt === null) {
            return -1;
          }

          return left.publishedAt < right.publishedAt ? 1 : -1;
        });

      if (meaningful.length < REVIEW_INTELLIGENCE_MIN_MEANINGFUL) {
        yield* Effect.logInfo("Review highlights insufficient").pipe(
          Effect.annotateLogs({
            sampleCount: meaningful.length,
            totalCount: summary.total,
            durationMs: Date.now() - startedAt,
          }),
        );

        return ReviewHighlightsOutcome.Insufficient();
      }

      const sampled = stratifySample(meaningful, REVIEW_INTELLIGENCE_MAX_SAMPLE);

      const fingerprint = fingerprintSample({
        venueId: input.venueId,
        language: input.language,
        total: summary.total,
        promptVersion: REVIEW_INTELLIGENCE_PROMPT_VERSION,
        model: deps.config.modelId,
        sample: sampled,
      });

      const key = normalizeReviewSummaryCacheKey({
        venueId: input.venueId,
        language: input.language,
        fingerprint,
        promptVersion: REVIEW_INTELLIGENCE_PROMPT_VERSION,
        model: deps.config.modelId,
      });

      const { value, cacheHit } = yield* deps.summaryCache.getOrCompute(
        key,
        Effect.gen(function* () {
          const draft = yield* deps.client
            .summarize({
              reviews: sampled.map((review) => ({
                id: review.id,
                rating: review.rating,
                publishedAt: review.publishedAt,
                body: review.body.slice(0, REVIEW_INTELLIGENCE_MAX_REVIEW_CHARS * 2),
              })),
              language: input.language,
            })
            .pipe(
              Effect.tapError((error) =>
                Effect.logWarning("Review highlights provider failed").pipe(
                  Effect.annotateLogs({ failure: error._tag }),
                ),
              ),
              Effect.mapError(() => new ReviewHighlightsInvalid({ reason: "provider" })),
            );

          const supplied = new Map(sampled.map((review) => [review.id, review] as const));

          for (const item of draft.evidence) {
            const source = supplied.get(item.reviewId);

            if (source === undefined) {
              return yield* failWith("evidence-membership");
            }

            if (!normalizeWhitespace(source.body).includes(normalizeWhitespace(item.snippet))) {
              return yield* failWith("evidence-verbatim");
            }
          }

          for (const text of [draft.overview, ...draft.positives, ...draft.cautions]) {
            if (UNSAFE_REVIEW_CLAIM_PATTERN.test(text) || REVIEW_HTML_TAG_PATTERN.test(text)) {
              return yield* failWith("generated-safety");
            }
          }

          return ReviewHighlightsOutcome.Ready({
            overview: draft.overview,
            positives: [...draft.positives],
            cautions: [...draft.cautions],
            evidence: draft.evidence.map((item) => ({
              reviewId: item.reviewId,
              snippet: item.snippet,
            })),
            sampleCount: sampled.length,
            totalCount: summary.total,
            generatedAt: new Date().toISOString(),
          });
        }).pipe(
          Effect.catchTag("ReviewHighlightsInvalid", () =>
            Effect.succeed(ReviewHighlightsOutcome.Unavailable()),
          ),
        ),
      );

      yield* Effect.logInfo("Review highlights completed").pipe(
        Effect.annotateLogs({
          outcome: value._tag,
          cacheHit,
          sampleCount: sampled.length,
          totalCount: summary.total,
          durationMs: Date.now() - startedAt,
        }),
      );

      return value;
    }).pipe(
      Effect.catchTag("ReviewHighlightsInvalid", (failure) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Review highlights unavailable").pipe(
            Effect.annotateLogs({ step: failure.reason }),
          );

          return ReviewHighlightsOutcome.Unavailable();
        }),
      ),
    );

  const translateReview = (input: TranslateReviewInput) =>
    Effect.gen(function* () {
      if (!deps.config.enabled) {
        yield* Effect.logInfo("Review translation skipped").pipe(
          Effect.annotateLogs({ reason: "disabled" }),
        );

        return TranslateReviewOutcome.Failed();
      }

      const startedAt = Date.now();

      const run = Effect.gen(function* () {
        const rows = yield* fetchPublishedReviewsByIds([input.reviewId]);
        const row = rows[0];

        if (row === undefined) {
          return TranslateReviewOutcome.Failed();
        }

        if (row.published_at === null) {
          return TranslateReviewOutcome.Failed();
        }

        const key = normalizeReviewTranslationCacheKey({
          reviewId: row.id,
          target: input.target,
          updatedAt: row.updated_at ?? row.published_at,
        });

        const cached = deps.translationCache.lookup(key);

        if (cached !== undefined) {
          return TranslateReviewOutcome.Done({
            translation: cached.translation,
            sourceLang: cached.sourceLang,
          });
        }

        const draft = yield* deps.client.translate({ body: row.body, target: input.target });
        const value = { translation: draft.translation, sourceLang: draft.sourceLang };

        deps.translationCache.store(key, value);

        return TranslateReviewOutcome.Done(value);
      });

      const outcome = yield* run.pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Review translation failed").pipe(
            Effect.annotateLogs({ failure: error._tag, target: input.target }),
          ),
        ),
        Effect.match({
          onFailure: () => TranslateReviewOutcome.Failed(),
          onSuccess: (value) => value,
        }),
      );

      yield* Effect.logInfo("Review translation completed").pipe(
        Effect.annotateLogs({
          outcome: outcome._tag,
          target: input.target,
          durationMs: Date.now() - startedAt,
        }),
      );

      return outcome;
    });

  return { getReviewHighlights, translateReview, getSupportingReviews: toSupportingReviews };
};

/** Published-only rows mapped to the supporting contract; failures propagate typed. */
const fetchPublishedReviewRows = (
  ids: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<SupportingReview>, DatabaseError, Database> =>
  Effect.gen(function* () {
    const rows = yield* fetchPublishedReviewsByIds(ids);

    return rows.flatMap((row) =>
      row.published_at === null
        ? []
        : [
            {
              id: row.id,
              rating: row.rating,
              body: row.body,
              publishedAt: row.published_at,
            } satisfies SupportingReview,
          ],
    );
  });

const toSupportingReviews = (input: SupportingReviewsInput) => fetchPublishedReviewRows(input.ids);

const summaryTtlFor =
  (positiveTtlMs: number, negativeTtlMs: number) =>
  (value: ReviewHighlightsOutcome): number | null =>
    Match.value(value).pipe(
      Match.tag("Ready", () => positiveTtlMs),
      Match.tag("Insufficient", () => negativeTtlMs),
      Match.orElse(() => null),
    );

let sharedSummaryCache: ReviewSummaryCache<ReviewHighlightsOutcome> | undefined;

let sharedTranslationCache: ReviewTranslationCache | undefined;

const getSharedSummaryCache = (): ReviewSummaryCache<ReviewHighlightsOutcome> => {
  if (sharedSummaryCache === undefined) {
    const defaults = defaultReviewSummaryCacheOptions();

    sharedSummaryCache = makeReviewSummaryCache({
      maxEntries: defaults.maxEntries,
      ttlFor: summaryTtlFor(defaults.positiveTtlMs, defaults.negativeTtlMs),
    });
  }

  return sharedSummaryCache;
};

const getSharedTranslationCache = (): ReviewTranslationCache => {
  if (sharedTranslationCache === undefined) {
    sharedTranslationCache = makeReviewTranslationCache({
      maxEntries: 200,
      ttlMs: 24 * 60 * 60 * 1000,
    });
  }

  return sharedTranslationCache;
};

/** Test and lifecycle escape hatch: drop the process-shared caches. */
export const resetReviewIntelligenceCaches = (): void => {
  sharedSummaryCache = undefined;
  sharedTranslationCache = undefined;
};

export const makeReviewIntelligenceLive = (
  deps: ReviewIntelligenceDeps,
): Layer.Layer<ReviewIntelligence> =>
  Layer.succeed(ReviewIntelligence, makeReviewIntelligence(deps));

/**
 * Request-scoped wiring: resolves config from the process environment at
 * layer build and reuses the process-shared TTL caches. Database access
 * flows through the published restaurant-discovery operations at call time
 * and is provided by the application runtime, not this layer.
 */
export const ReviewIntelligenceLive: Layer.Layer<
  ReviewIntelligence,
  never,
  ReviewIntelligenceClient
> = Layer.effect(
  ReviewIntelligence,
  Effect.gen(function* () {
    const client = yield* ReviewIntelligenceClient;

    let config: ReviewIntelligenceConfig;

    try {
      config = resolveReviewIntelligenceConfig(process.env);
    } catch (error) {
      // Invalid operator configuration fails loudly in server logs (field
      // + reason, never values) and fail-closed at the transport.
      yield* Effect.logError("Review intelligence configuration invalid").pipe(
        Effect.annotateLogs({
          reason: error instanceof Error ? error.message : "unknown",
        }),
      );

      throw error;
    }

    return makeReviewIntelligence({
      client,
      config,
      summaryCache: getSharedSummaryCache(),
      translationCache: getSharedTranslationCache(),
    });
  }),
);
