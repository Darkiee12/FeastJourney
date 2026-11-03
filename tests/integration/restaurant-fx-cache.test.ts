import { afterAll, describe, expect, test } from "bun:test";

import { Deferred, Effect, Fiber } from "effect";
import postgres from "postgres";

import {
  FxProvider,
  FxUnavailable,
  makeFxRates,
} from "@/modules/restaurant-discovery/server/operations/fx";
import saveCatalog from "@/modules/restaurant-discovery/server/repository/sql/fx-catalog-save.sql";
import claim from "@/modules/restaurant-discovery/server/repository/sql/fx-lease.sql";
import release from "@/modules/restaurant-discovery/server/repository/sql/fx-release.sql";
import save from "@/modules/restaurant-discovery/server/repository/sql/fx-save.sql";
import { Database } from "@/server/database/client";

const sql = postgres(process.env.DATABASE_URL ?? "", { max: 5 });
const providers: Array<string> = [];

const run = <A, E>(effect: Effect.Effect<A, E, Database>) =>
  Effect.runPromise(Effect.provideService(effect, Database, { sql }));

function fixture(options: { fail?: boolean; date?: string; delay?: boolean } = {}) {
  const id = `test-fx-${crypto.randomUUID()}`;
  providers.push(id);
  let calls = 0;
  let catalogCalls = 0;

  const provider = FxProvider.of({
    id,
    pair: (base, quote) =>
      Effect.gen(function* () {
        calls += 1;

        if (options.delay) yield* Effect.sleep("50 millis");

        if (options.fail) return yield* new FxUnavailable({ reason: "Synthetic provider outage" });

        return {
          base,
          quote,
          rate: "0.00004",
          effectiveDate: options.date ?? new Date().toISOString().slice(0, 10),
          provider: id,
        };
      }),
    currencies: Effect.sync(() => {
      catalogCalls += 1;

      return ["VND", "USD", "JPY"];
    }),
  });

  const fx = makeFxRates(provider, { provider: id, refreshMs: 86400000, maxAgeMs: 72 * 3600000 });

  return { id, fx, options, calls: () => calls, catalogCalls: () => catalogCalls };
}

afterAll(async () => {
  await sql`DELETE FROM feastjourney.currency_exchange_rates WHERE provider=ANY(${providers}::text[])`;
  await sql`DELETE FROM feastjourney.currency_provider_catalog WHERE provider=ANY(${providers}::text[])`;

  await Promise.all(
    providers.map(
      (id) => sql`DELETE FROM feastjourney.currency_refresh_leases WHERE key LIKE ${id + ":%"}`,
    ),
  );
  await sql.end();
});

describe("PostgreSQL FX cache with mocked provider", () => {
  test("interruption stops the provider and leaves a bounded lease cooldown", async () => {
    const id = `test-fx-${crypto.randomUUID()}`;
    providers.push(id);
    const started = Deferred.makeUnsafe<void>();
    let finalized = false;

    const provider = FxProvider.of({
      id,
      pair: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
      currencies: Effect.succeed(["VND", "USD"]),
    });

    const fx = makeFxRates(provider, { provider: id, refreshMs: 86400000, maxAgeMs: 72 * 3600000 });
    await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(fx.rate("VND", "USD"));
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(finalized).toBe(true);

    const leases =
      await sql`SELECT expires_at>now() AS cooling_down, expires_at<now()+INTERVAL '6 minutes' AS bounded FROM feastjourney.currency_refresh_leases WHERE key=${id + ":VND:USD"}`;

    expect(leases[0]?.cooling_down).toBe(true);
    expect(leases[0]?.bounded).toBe(true);

    const rates =
      await sql`SELECT rate FROM feastjourney.currency_exchange_rates WHERE provider=${id}`;

    expect(rates).toHaveLength(0);
  });

  test("lease cleanup failure preserves the original provider failure", async () => {
    const id = `test-fx-${crypto.randomUUID()}`;
    providers.push(id);
    const isolated = postgres(process.env.DATABASE_URL ?? "", { max: 1 });

    const provider = FxProvider.of({
      id,
      pair: () =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => isolated.end(),
            catch: () => new FxUnavailable({ reason: "Synthetic test client teardown failure" }),
          });

          return yield* new FxUnavailable({ reason: "Original synthetic provider failure" });
        }),
      currencies: Effect.succeed(["VND", "USD"]),
    });

    const fx = makeFxRates(provider, { provider: id, refreshMs: 86400000, maxAgeMs: 72 * 3600000 });

    const failure = await Effect.runPromise(
      Effect.provideService(Effect.flip(fx.rate("VND", "USD")), Database, { sql: isolated }),
    );

    expect(failure._tag).toBe("FxUnavailable");

    if (failure instanceof FxUnavailable)
      expect(failure.reason).toBe("Original synthetic provider failure");
  });
  test("cold miss is persisted and a cache hit avoids provider HTTP", async () => {
    const fixtureFx = fixture();
    const first = await run(fixtureFx.fx.rate("VND", "USD"));
    const second = await run(fixtureFx.fx.rate("VND", "USD"));
    expect(first.rate).toBe("0.00004");
    expect(second.rate).toBe(first.rate);
    expect(fixtureFx.calls()).toBe(1);
  });
  test("currency catalog is cached across requests", async () => {
    const fixtureFx = fixture();
    expect(await run(fixtureFx.fx.supportedCurrencies)).toEqual(["VND", "USD", "JPY"]);
    await run(fixtureFx.fx.supportedCurrencies);
    expect(fixtureFx.catalogCalls()).toBe(1);
  });
  test("concurrent cold requests cause one provider refresh", async () => {
    const fixtureFx = fixture({ delay: true });

    const values = await run(
      Effect.all(
        Array.from({ length: 8 }, () => fixtureFx.fx.rate("VND", "USD")),
        { concurrency: 8 },
      ),
    );

    expect(values).toHaveLength(8);
    expect(fixtureFx.calls()).toBe(1);
  });
  test("stale-but-acceptable rates survive provider failure", async () => {
    const fixtureFx = fixture();
    await run(fixtureFx.fx.rate("VND", "USD"));
    await sql`UPDATE feastjourney.currency_exchange_rates SET fetched_at=now()-INTERVAL '25 hours' WHERE provider=${fixtureFx.id}`;
    await sql`UPDATE feastjourney.currency_refresh_leases SET expires_at=now()-INTERVAL '1 second' WHERE key=${fixtureFx.id + ":VND:USD"}`;
    fixtureFx.options.fail = true;
    const cached = await run(fixtureFx.fx.rate("VND", "USD"));
    expect(cached.rate).toBe("0.00004");
    expect(fixtureFx.calls()).toBe(2);
  });
  test("effective-date expiry cannot be disguised by a recent fetch timestamp", async () => {
    const fixtureFx = fixture();
    await run(fixtureFx.fx.rate("VND", "USD"));
    await sql`UPDATE feastjourney.currency_exchange_rates SET effective_date=current_date-10 WHERE provider=${fixtureFx.id}`;
    await sql`UPDATE feastjourney.currency_refresh_leases SET expires_at=now()-INTERVAL '1 second' WHERE key=${fixtureFx.id + ":VND:USD"}`;
    fixtureFx.options.fail = true;
    const failure = await run(Effect.flip(fixtureFx.fx.rate("VND", "USD")));
    expect(failure._tag).toBe("FxUnavailable");
  });
  test("provider timeout/outage without cache is a typed failure and has a cooldown", async () => {
    const fixtureFx = fixture({ fail: true });
    const failure = await run(Effect.flip(fixtureFx.fx.rate("JPY", "USD")));
    expect(failure._tag).toBe("FxUnavailable");
    const again = await run(Effect.flip(fixtureFx.fx.rate("JPY", "USD")));
    expect(again._tag).toBe("FxUnavailable");
    expect(fixtureFx.calls()).toBe(1);
  }, 7000);
  test("rejects unsupported or same-currency pairs before fetching", async () => {
    const fixtureFx = fixture();

    await Promise.all(
      [
        ["CNH", "USD"],
        ["XYZ", "USD"],
        ["USD", "USD"],
      ].map(async ([base, quote]) => {
        if (base === undefined || quote === undefined) throw new Error("Malformed test pair");
        expect((await run(Effect.flip(fixtureFx.fx.rate(base, quote))))._tag).toBe("FxUnavailable");
      }),
    );

    expect(fixtureFx.calls()).toBe(0);
  });
  test("an expired lease owner cannot overwrite a successor's rate or catalog, or release its lease", async () => {
    const fixtureFx = fixture();
    const key = `${fixtureFx.id}:takeover`;
    const oldToken = crypto.randomUUID();
    const newToken = crypto.randomUUID();
    expect(await claim.run(sql, { key, token: oldToken })).not.toBeNull();
    await sql`UPDATE feastjourney.currency_refresh_leases SET expires_at=now()-INTERVAL '1 second' WHERE key=${key}`;
    expect(await claim.run(sql, { key, token: newToken })).not.toBeNull();
    await release.run(sql, { key, token: oldToken });

    const stale = await save.run(sql, {
      base: "VND",
      quote: "USD",
      rate: "1",
      date: new Date().toISOString().slice(0, 10),
      provider: fixtureFx.id,
      key,
      token: oldToken,
    });

    expect(stale).toBeNull();

    const staleCatalog = await saveCatalog.run(sql, {
      provider: fixtureFx.id,
      codes: ["VND"],
      key,
      token: oldToken,
    });

    expect(staleCatalog).toBeNull();

    const current = await save.run(sql, {
      base: "VND",
      quote: "USD",
      rate: "0.00004",
      date: new Date().toISOString().slice(0, 10),
      provider: fixtureFx.id,
      key,
      token: newToken,
    });

    expect(current?.rate).toBe("0.00004");
  });
  test("a lease loser waits for the winner's refresh without a provider fetch", async () => {
    const fixtureFx = fixture();
    const key = `${fixtureFx.id}:VND:USD`;
    const foreignToken = crypto.randomUUID();
    expect(await claim.run(sql, { key, token: foreignToken })).not.toBeNull();

    const today = new Date().toISOString().slice(0, 10);

    const observed = await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(fixtureFx.fx.rate("VND", "USD"));
        yield* Effect.sleep("250 millis");
        yield* Effect.tryPromise({
          try: () =>
            sql`INSERT INTO feastjourney.currency_exchange_rates(provider,base_currency,quote_currency,rate,effective_date) VALUES(${fixtureFx.id},'VND','USD','0.00004',${today}::date)`,
          catch: () => new FxUnavailable({ reason: "test setup failed" }),
        });

        return yield* Fiber.join(fiber);
      }),
    );

    expect(observed.rate).toBe("0.00004");
    expect(fixtureFx.calls()).toBe(0);
  });
  test("an unrefreshed wait exhausts to retry-shortly without a provider fetch", async () => {
    const fixtureFx = fixture();
    const key = `${fixtureFx.id}:JPY:USD`;
    expect(await claim.run(sql, { key, token: crypto.randomUUID() })).not.toBeNull();

    const failure = await run(Effect.flip(fixtureFx.fx.rate("JPY", "USD")));
    expect(failure._tag).toBe("FxUnavailable");

    if (failure instanceof FxUnavailable)
      expect(failure.reason).toBe("Reference rate is refreshing; retry shortly");
    expect(fixtureFx.calls()).toBe(0);
  }, 10000);
});
