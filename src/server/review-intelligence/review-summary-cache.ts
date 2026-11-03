import { Deferred, Effect, Match } from "effect";

import {
  REVIEW_INTELLIGENCE_CACHE_MAX_ENTRIES,
  REVIEW_INTELLIGENCE_CACHE_TTL_MS,
  REVIEW_INTELLIGENCE_NEGATIVE_CACHE_TTL_MS,
} from "@/server/review-intelligence/review-schemas";

/**
 * Module-local in-memory caches for review intelligence.
 *
 * Production note: these caches live per server instance (one Nitro
 * process), exactly like the menu-localization in-flight gate and the
 * web-research shared cache. Keys are content-aware — venue plus language
 * plus a fingerprint over review IDs, timestamps, bodies, and totals plus
 * the prompt version and model — so moderation, edits, and removals change
 * the key and stale entries simply miss; a bare count is never a key.
 * Cross-replica divergence therefore self-heals on the next read. If the
 * deployment ever needs cross-instance sharing, replace these factories
 * with a shared store behind the same interfaces; callers only depend on
 * lookup/store/getOrCompute.
 */

export interface ReviewSummaryCacheKeyInput {
  readonly venueId: string;
  readonly language: string;
  readonly fingerprint: string;
  readonly promptVersion: string;
  readonly model: string;
}

/** Stable key: venue plus language plus content fingerprint plus contract version. */
export const normalizeReviewSummaryCacheKey = (input: ReviewSummaryCacheKeyInput): string =>
  JSON.stringify({
    venueId: input.venueId.trim().toLowerCase(),
    language: input.language.trim().toLowerCase(),
    fingerprint: input.fingerprint,
    promptVersion: input.promptVersion,
    model: input.model,
  });

export interface ReviewTranslationCacheValue {
  readonly translation: string;
  readonly sourceLang: string;
}

export interface ReviewTranslationCacheKeyInput {
  readonly reviewId: string;
  readonly target: string;
  /** updated_at of the published row: edits unpublish first, so any new text changes this clock. */
  readonly updatedAt: string;
}

/** Stable key: review plus target plus row clock, so edits invalidate. */
export const normalizeReviewTranslationCacheKey = (input: ReviewTranslationCacheKeyInput): string =>
  JSON.stringify({
    reviewId: input.reviewId,
    target: input.target.trim().toLowerCase(),
    updatedAt: input.updatedAt,
  });

export interface ReviewCacheResult<T> {
  readonly value: T;
  readonly cacheHit: boolean;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export interface EntryCache<T> {
  readonly lookup: (key: string, now?: number) => T | undefined;
  readonly store: (key: string, value: T, now?: number) => void;
  readonly getOrCompute: (
    key: string,
    compute: Effect.Effect<T>,
  ) => Effect.Effect<ReviewCacheResult<T>>;
}

const makeEntryCache = <T>(options: {
  readonly maxEntries: number;
  readonly ttlFor: (value: T) => number | null;
}): EntryCache<T> => {
  const entries = new Map<string, CacheEntry<T>>();
  const inflight = new Map<string, Deferred.Deferred<T>>();

  const lookup = (key: string, now: number = Date.now()): T | undefined => {
    const entry = entries.get(key);

    if (entry === undefined) {
      return undefined;
    }

    if (entry.expiresAt <= now) {
      entries.delete(key);

      return undefined;
    }

    return entry.value;
  };

  const store = (key: string, value: T, now: number = Date.now()): void => {
    const ttlMs = options.ttlFor(value);

    if (ttlMs === null) {
      return;
    }

    if (!entries.has(key) && entries.size >= options.maxEntries) {
      const oldest = entries.keys().next();

      if (!oldest.done) {
        entries.delete(oldest.value);
      }
    }

    entries.set(key, { value, expiresAt: now + ttlMs });
  };

  const getOrCompute = (
    key: string,
    compute: Effect.Effect<T>,
  ): Effect.Effect<ReviewCacheResult<T>> =>
    Effect.gen(function* () {
      const cached = lookup(key);

      if (cached !== undefined) {
        return { value: cached, cacheHit: true };
      }

      const ongoing = inflight.get(key);

      if (ongoing !== undefined) {
        const value = yield* Deferred.await(ongoing);

        return { value, cacheHit: true };
      }

      const deferred = yield* Deferred.make<T>();

      inflight.set(key, deferred);

      const exit = yield* Effect.exit(compute);

      inflight.delete(key);

      return yield* Match.value(exit).pipe(
        Match.tag("Success", (success) =>
          Effect.gen(function* () {
            store(key, success.value);
            yield* Deferred.succeed(deferred, success.value);

            return { value: success.value, cacheHit: false };
          }),
        ),
        // Compute is infallible by type; reaching here means interruption
        // or defect. Joiners observe the interruption while the requester
        // sees the original outcome.
        Match.tag("Failure", () =>
          Effect.gen(function* () {
            yield* Deferred.interrupt(deferred);

            return yield* Effect.interrupt;
          }),
        ),
        Match.exhaustive,
      );
    });

  return { lookup, store, getOrCompute };
};

export interface ReviewSummaryCache<T extends { readonly _tag: string }> {
  readonly lookup: (key: string, now?: number) => T | undefined;
  readonly store: (key: string, value: T, now?: number) => void;
  readonly getOrCompute: (
    key: string,
    compute: Effect.Effect<T>,
  ) => Effect.Effect<ReviewCacheResult<T>>;
}

export interface ReviewSummaryCacheOptions<T> {
  readonly maxEntries: number;
  readonly ttlFor: (value: T) => number | null;
}

/**
 * Highlights cache. The caller supplies ttlFor: Ready outcomes use the
 * positive TTL, Insufficient uses a short negative TTL so a new fifth
 * review is picked up promptly, and Unavailable (provider or transport
 * failure) is transient and never stored — every such failure retries the
 * provider on the next read.
 */
export const makeReviewSummaryCache = <T extends { readonly _tag: string }>(
  options: ReviewSummaryCacheOptions<T>,
): ReviewSummaryCache<T> =>
  makeEntryCache<T>({ maxEntries: options.maxEntries, ttlFor: options.ttlFor });

export interface ReviewTranslationCache {
  readonly lookup: (key: string, now?: number) => ReviewTranslationCacheValue | undefined;
  readonly store: (key: string, value: ReviewTranslationCacheValue, now?: number) => void;
  readonly getOrCompute: (
    key: string,
    compute: Effect.Effect<ReviewTranslationCacheValue>,
  ) => Effect.Effect<ReviewCacheResult<ReviewTranslationCacheValue>>;
}

export interface ReviewTranslationCacheOptions {
  readonly maxEntries: number;
  readonly ttlMs: number;
}

/** Translation cache: translations are pure functions of immutable published text, keyed by row clock. */
export const makeReviewTranslationCache = (
  options: ReviewTranslationCacheOptions,
): ReviewTranslationCache =>
  makeEntryCache<ReviewTranslationCacheValue>({
    maxEntries: options.maxEntries,
    ttlFor: () => options.ttlMs,
  });

export interface ReviewSummaryTtlOptions {
  readonly maxEntries: number;
  readonly positiveTtlMs: number;
  readonly negativeTtlMs: number;
}

export const defaultReviewSummaryCacheOptions = (): ReviewSummaryTtlOptions => ({
  maxEntries: REVIEW_INTELLIGENCE_CACHE_MAX_ENTRIES,
  positiveTtlMs: REVIEW_INTELLIGENCE_CACHE_TTL_MS,
  negativeTtlMs: REVIEW_INTELLIGENCE_NEGATIVE_CACHE_TTL_MS,
});
