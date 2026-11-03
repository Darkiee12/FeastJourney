import { Context, Duration, Effect, Layer, Match } from "effect";
import { RateLimiter } from "effect/persistence";

import { appConfig } from "@/server/config";
import { RateLimitExceeded, StoreUnavailable } from "@/server/http/api-error";

/**
 * Rate-limit buckets. `public` and `search` cover cheap catalog reads.
 *
 * Copilot splits into two independent budgets with identical default limits
 * (independent fixed-window counters, never weaker than the legacy `copilot`
 * budget they replace):
 * - `copilot-chat`: cheap deterministic catalog chat assembly, including its
 *   single bounded member-only synthesis call (at most one retry).
 * - `copilot-ai`: expensive vision/order calls — photo identification and
 *   order drafting.
 * Cheap catalog traffic must never starve — or be starved by — vision/draft
 * floods. `copilot` stays as a legacy alias with the same budget for compat.
 *
 * Replica caveat: `RateLimiterLive` below uses the in-memory store, so each
 * Swarm replica enforces its own counters. The bucket limits are per-replica,
 * not globally enforced. For global enforcement, replace
 * `RateLimiter.layerStoreMemory` with a shared store (e.g. Redis) via
 * `RateLimiter.layer` — recommended, deliberately not built here.
 */
export type RateLimitBucket =
  | "public"
  | "search"
  | "copilot"
  | "copilot-chat"
  | "copilot-ai"
  | "admin";

export class RateLimitPolicy extends Context.Service<
  RateLimitPolicy,
  {
    readonly check: (
      bucket: RateLimitBucket,
      identity: string,
    ) => Effect.Effect<void, RateLimitExceeded | StoreUnavailable, RateLimiter.RateLimiter>;
  }
>()("feastjourney/http/RateLimitPolicy") {}

export const RateLimitPolicyLive = Layer.effect(
  RateLimitPolicy,
  Effect.gen(function* () {
    const config = yield* appConfig;

    const budgets: Record<
      RateLimitBucket,
      { readonly limit: number; readonly windowSeconds: number }
    > = {
      public: { limit: config.publicRateLimit, windowSeconds: config.publicRateWindowSeconds },
      search: { limit: config.searchRateLimit, windowSeconds: config.searchRateWindowSeconds },
      copilot: {
        // Canonical defaults live in config.ts (withDefault); the ?? guards
        // literal-constructed configs (e.g. unit tests, which lanes must not edit).
        limit: config.copilotRateLimit ?? 10,
        windowSeconds: config.copilotRateWindowSeconds ?? 60,
      },
      // Independent counters sharing the copilot budget: same limits, separate
      // keys so cheap chat and expensive model/vision calls cannot starve
      // each other. Deliberately not weaker than the legacy `copilot` budget.
      "copilot-chat": {
        limit: config.copilotRateLimit ?? 10,
        windowSeconds: config.copilotRateWindowSeconds ?? 60,
      },
      "copilot-ai": {
        limit: config.copilotRateLimit ?? 10,
        windowSeconds: config.copilotRateWindowSeconds ?? 60,
      },
      admin: { limit: config.adminRateLimit, windowSeconds: config.adminRateWindowSeconds },
    };

    return RateLimitPolicy.of({
      check: (bucket, identity) =>
        Effect.gen(function* () {
          const limiter = yield* RateLimiter.RateLimiter;
          const budget = budgets[bucket];

          yield* Effect.mapError(
            limiter.consume({
              algorithm: "fixed-window",
              onExceeded: "fail",
              window: Duration.seconds(budget.windowSeconds),
              limit: budget.limit,
              key: `feastjourney:${bucket}:${identity}`,
            }),
            (failure): RateLimitExceeded | StoreUnavailable =>
              Match.value(failure.reason).pipe(
                Match.tag(
                  "RateLimitExceeded",
                  (reason) =>
                    new RateLimitExceeded({
                      retryAfterSeconds: Math.max(
                        1,
                        Math.ceil(Duration.toMillis(reason.retryAfter) / 1000),
                      ),
                      limit: reason.limit,
                    }),
                ),
                Match.orElse(() => new StoreUnavailable({ operation: `ratelimit/${bucket}` })),
              ),
          );
        }),
    });
  }),
);

export const RateLimiterLive = Layer.provide(RateLimiter.layer, RateLimiter.layerStoreMemory);
