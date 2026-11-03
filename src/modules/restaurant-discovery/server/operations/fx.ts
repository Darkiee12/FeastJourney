import { Clock, Config, Context, Effect, Exit, Layer, Schedule } from "effect";

import {
  acceptableRate,
  frankfurterProvider,
  FxProvider,
  FxUnavailable,
} from "@/modules/restaurant-discovery/server/operations/fx-provider";
import saveCatalog from "@/modules/restaurant-discovery/server/repository/sql/fx-catalog-save.sql";
import catalogQuery from "@/modules/restaurant-discovery/server/repository/sql/fx-catalog.sql";
import latest from "@/modules/restaurant-discovery/server/repository/sql/fx-latest.sql";
import claim from "@/modules/restaurant-discovery/server/repository/sql/fx-lease.sql";
import release from "@/modules/restaurant-discovery/server/repository/sql/fx-release.sql";
import save from "@/modules/restaurant-discovery/server/repository/sql/fx-save.sql";
import { runQuery } from "@/server/database/query";
import { isCurrency } from "@/shared/money";

export {
  acceptableRate,
  frankfurterProvider,
  FxProvider,
  FxUnavailable,
} from "@/modules/restaurant-discovery/server/operations/fx-provider";

export const fxSettings = Config.unwrap({
  endpoint: Config.String("FX_ENDPOINT").pipe(
    Config.withDefault("https://api.frankfurter.dev/v2/"),
  ),
  refreshHours: Config.Int("FX_REFRESH_HOURS").pipe(Config.withDefault(24)),
  maxAgeHours: Config.Int("FX_MAX_AGE_HOURS").pipe(Config.withDefault(72)),
});

export interface FxPolicy {
  readonly provider: string;
  readonly refreshMs: number;
  readonly maxAgeMs: number;
}

export function makeFxRates(provider: FxProvider["Service"], policy: FxPolicy) {
  const supportedCurrencies = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const cached = yield* runQuery("fx/catalog", (sql) =>
      catalogQuery.run(sql, { provider: policy.provider }),
    );

    const first = cached[0];
    const cachedCodes = cached.map((row) => row.code);

    if (first !== undefined && now - Date.parse(first.fetched_at) < policy.refreshMs)
      return cachedCodes;
    const key = `${policy.provider}:currencies`;
    const token = crypto.randomUUID();
    const lease = yield* runQuery("fx/catalog-claim", (sql) => claim.run(sql, { key, token }));

    if (lease === null) {
      if (first !== undefined) return cachedCodes;

      return yield* new FxUnavailable({ reason: "Currency catalog is refreshing; retry shortly" });
    }

    return yield* Effect.onExit(
      provider.currencies.pipe(
        Effect.tap((codes) =>
          Effect.gen(function* () {
            const saved = yield* runQuery("fx/catalog-save", (sql) =>
              saveCatalog.run(sql, { provider: policy.provider, codes: [...codes], key, token }),
            );

            if (saved === null)
              return yield* new FxUnavailable({ reason: "Currency catalog refresh lease expired" });

            return undefined;
          }),
        ),
        Effect.catchTag("FxUnavailable", (error) =>
          first === undefined ? Effect.fail(error) : Effect.succeed(cachedCodes),
        ),
      ),
      (exit) =>
        runQuery("fx/catalog-release", (sql) => release.run(sql, { key, token })).pipe(
          Effect.catch((error) => {
            if (Exit.isSuccess(exit)) return Effect.fail(error);

            return Effect.logWarning(
              "FX catalog lease cleanup failed; lease expires automatically",
              { tag: error._tag },
            );
          }),
        ),
    );
  });

  const rate = (base: string, quote: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      if (!isCurrency(base) || !isCurrency(quote) || base === quote) {
        return yield* new FxUnavailable({ reason: "Invalid currency pair" });
      }

      const params = { provider: policy.provider, base, quote };
      const cached = yield* runQuery("fx/latest", (sql) => latest.run(sql, params));
      const usable = cached !== null && acceptableRate(cached, now, policy.maxAgeMs);

      if (usable && now - Date.parse(cached.fetched_at) < policy.refreshMs) return cached;
      const key = `${policy.provider}:${base}:${quote}`;
      const token = crypto.randomUUID();
      const lease = yield* runQuery("fx/claim", (sql) => claim.run(sql, { key, token }));

      if (lease === null) {
        if (usable) return cached;

        // Another replica may own a cold refresh. Bound waiting below the HTTP request timeout.
        // The poll reports staleness as a typed FxUnavailable so Effect.retry only repeats
        // that case (Schedule.spaced("100 millis") x 29 retries = 30 freshness checks);
        // database failures propagate immediately, and interruption never retries.
        const poll = Effect.flatMap(
          Effect.zip(
            runQuery("fx/wait", (sql) => latest.run(sql, params)),
            Clock.currentTimeMillis,
          ),
          ([refreshed, refreshedAt]) =>
            refreshed !== null && acceptableRate(refreshed, refreshedAt, policy.maxAgeMs)
              ? Effect.succeed(refreshed)
              : Effect.fail(
                  new FxUnavailable({ reason: "Reference rate is refreshing; retry shortly" }),
                ),
        );

        return yield* Effect.retry(poll, {
          while: (error) => error instanceof FxUnavailable,
          times: 29,
          schedule: Schedule.spaced("100 millis"),
        });
      }

      return yield* Effect.onExit(
        Effect.gen(function* () {
          const result = yield* provider.pair(base, quote);
          const fetchedAt = yield* Clock.currentTimeMillis;

          if (
            result.base !== base ||
            result.quote !== quote ||
            result.provider !== policy.provider ||
            !acceptableRate(result, fetchedAt, policy.maxAgeMs)
          ) {
            return yield* new FxUnavailable({
              reason: "Reference rate is expired or has the wrong pair",
            });
          }

          const saved = yield* runQuery("fx/save", (sql) =>
            save.run(sql, {
              ...params,
              rate: result.rate,
              date: result.effectiveDate,
              key,
              token,
            }),
          );

          if (saved === null)
            return yield* new FxUnavailable({
              reason: "Conflicting reference rate or expired refresh lease",
            });

          return result;
        }).pipe(
          Effect.catchTag("FxUnavailable", (error) =>
            usable ? Effect.succeed(cached) : Effect.fail(error),
          ),
        ),
        (exit) =>
          runQuery("fx/release", (sql) => release.run(sql, { key, token })).pipe(
            Effect.catch((error) => {
              if (Exit.isSuccess(exit)) return Effect.fail(error);

              return Effect.logWarning("FX lease cleanup failed; lease expires automatically", {
                tag: error._tag,
              });
            }),
          ),
      );
    });

  return { rate, supportedCurrencies };
}

export class FxRates extends Context.Service<FxRates, ReturnType<typeof makeFxRates>>()(
  "feastjourney/restaurant/FxRates",
) {}

export const FxRatesLive = Layer.effect(
  FxRates,
  Effect.gen(function* () {
    const settings = yield* fxSettings;

    if (settings.refreshHours < 1 || settings.maxAgeHours < settings.refreshHours) {
      return yield* Effect.die(new Error("Invalid FX refresh/maximum-age policy"));
    }

    const provider = yield* FxProvider;

    return makeFxRates(provider, {
      provider: provider.id,
      refreshMs: settings.refreshHours * 3600000,
      maxAgeMs: settings.maxAgeHours * 3600000,
    });
  }),
);

export const FxProviderLive = Layer.effect(
  FxProvider,
  Effect.gen(function* () {
    const settings = yield* fxSettings;

    return frankfurterProvider(settings.endpoint);
  }),
);
