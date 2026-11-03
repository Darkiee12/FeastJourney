import { Deferred, Effect, Match } from "effect";

import { ResearchOutcome } from "@/server/web-research/research-types";

/**
 * In-memory TTL cache for web-research outcomes, keyed by normalized intent.
 * Positive results and empty/skipped results use separate TTLs; provider
 * failures (ResearchUnavailable) are never stored. Simultaneous identical
 * requests share one in-flight computation via a Deferred map. Bounded to a
 * fixed entry count with oldest-first eviction.
 */

export const RESEARCH_CACHE_DEFAULT_MAX_ENTRIES = 200;

export interface ResearchCacheIntent {
  readonly kind: "dishes" | "restaurants" | "prices";
  readonly dish?: string | undefined;
  readonly city: string;
  readonly country: string;
  readonly portion?: string | undefined;
  readonly channel?: string | undefined;
  readonly language?: string | undefined;
}

export interface ResearchCacheOptions {
  readonly maxEntries: number;
  readonly positiveTtlMs: number;
  readonly negativeTtlMs: number;
}

export interface ResearchCacheResult {
  readonly outcome: ResearchOutcome;
  readonly cacheHit: boolean;
}

export interface ResearchCache {
  readonly lookup: (key: string, now?: number) => ResearchOutcome | undefined;
  readonly store: (key: string, outcome: ResearchOutcome, now?: number) => void;
  readonly getOrCompute: (
    key: string,
    compute: Effect.Effect<ResearchOutcome>,
  ) => Effect.Effect<ResearchCacheResult>;
}

const normalizeField = (value: string | undefined): string | null => {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim().toLowerCase();

  return trimmed.length === 0 ? null : trimmed;
};

/** Stable key for a research intent: trimmed, lowercased, fixed field order. */
export const normalizeResearchCacheKey = (intent: ResearchCacheIntent): string =>
  JSON.stringify({
    kind: intent.kind,
    dish: normalizeField(intent.dish),
    city: normalizeField(intent.city),
    country: normalizeField(intent.country),
    portion: normalizeField(intent.portion),
    channel: normalizeField(intent.channel),
    language: normalizeField(intent.language),
  });

export const makeResearchCache = (options: ResearchCacheOptions): ResearchCache => {
  const entries = new Map<
    string,
    { readonly outcome: ResearchOutcome; readonly expiresAt: number }
  >();

  const inflight = new Map<string, Deferred.Deferred<ResearchOutcome>>();

  const lookup = (key: string, now: number = Date.now()): ResearchOutcome | undefined => {
    const entry = entries.get(key);

    if (entry === undefined) {
      return undefined;
    }

    if (entry.expiresAt <= now) {
      entries.delete(key);

      return undefined;
    }

    return entry.outcome;
  };

  const store = (key: string, outcome: ResearchOutcome, now: number = Date.now()): void => {
    const ttlMs = ResearchOutcome.$match(outcome, {
      ResearchFound: () => options.positiveTtlMs,
      ResearchEmpty: () => options.negativeTtlMs,
      ResearchSkipped: () => options.negativeTtlMs,
      // Provider failures are transient: never cached, positive or negative.
      ResearchUnavailable: () => null,
    });

    if (ttlMs === null) {
      return;
    }

    if (!entries.has(key) && entries.size >= options.maxEntries) {
      const oldest = entries.keys().next();

      if (!oldest.done) {
        entries.delete(oldest.value);
      }
    }

    entries.set(key, { outcome, expiresAt: now + ttlMs });
  };

  const getOrCompute = (
    key: string,
    compute: Effect.Effect<ResearchOutcome>,
  ): Effect.Effect<ResearchCacheResult> =>
    Effect.gen(function* () {
      const cached = lookup(key);

      if (cached !== undefined) {
        return { outcome: cached, cacheHit: true };
      }

      const ongoing = inflight.get(key);

      if (ongoing !== undefined) {
        const outcome = yield* Deferred.await(ongoing);

        return { outcome, cacheHit: true };
      }

      const deferred = yield* Deferred.make<ResearchOutcome>();

      inflight.set(key, deferred);

      const exit = yield* Effect.exit(compute);

      inflight.delete(key);

      return yield* Match.value(exit).pipe(
        Match.tag("Success", (success) =>
          Effect.gen(function* () {
            store(key, success.value);
            yield* Deferred.succeed(deferred, success.value);

            return { outcome: success.value, cacheHit: false };
          }),
        ),
        // Compute is infallible by type; reaching here means interruption
        // or defect. Joiners receive a safe fallback while the requester
        // observes the original interruption.
        Match.tag("Failure", () =>
          Effect.gen(function* () {
            const fallback = ResearchOutcome.ResearchUnavailable({
              reason: "Web research was interrupted before completion.",
            });

            yield* Deferred.succeed(deferred, fallback);

            return yield* Effect.interrupt;
          }),
        ),
        Match.exhaustive,
      );
    });

  return { lookup, store, getOrCompute };
};
