import { Context, Effect, Exit, Layer, Option, Schedule } from "effect";
import postgres from "postgres";

import { appConfig } from "@/server/config";
import {
  DatabaseUnavailable,
  TransactionConflict,
  TransactionFailed,
  describeCause,
  isConnectionFailure as isConnectionFailureShim,
} from "@/server/database/errors";

/** @deprecated Use `runQuery` instead; see `isConnectionFailure` in database/errors. */
export const isConnectionFailure = isConnectionFailureShim;

/**
 * Reylo-compatible PostgreSQL client. postgres.js pool clients and reserved
 * connections (which extend `Sql`) both satisfy Reylo's `UnsafeClient`
 * (`unsafe(text, params)`), so repository queries accept either.
 */
export type DbClient = postgres.Sql;

export class Database extends Context.Service<Database, { readonly sql: postgres.Sql }>()(
  "feastjourney/database/Database",
) {}

/**
 * Transaction-bound client. Repositories prefer it when present and fall back
 * to the pool otherwise, so single operations and transactional workflows share
 * the same query code without ever leaking a transaction client.
 */
export class TxSql extends Context.Service<TxSql, postgres.ReservedSql>()(
  "feastjourney/database/TxSql",
) {}

export const currentSql = Effect.gen(function* () {
  const override = yield* Effect.serviceOption(TxSql);

  if (Option.isSome(override)) {
    return override.value;
  }

  const db = yield* Database;

  return db.sql;
});

export const DatabaseLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    const config = yield* appConfig;

    const sql = postgres(config.databaseUrl, {
      max: config.poolMax,
      connect_timeout: 10,
      idle_timeout: 30,
      max_lifetime: 60 * 30,
      transform: { undefined: undefined },
      onnotice: () => {},
    });

    return yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const probe = yield* Effect.tryPromise({
          try: () => sql`SELECT 1 AS ok`,
          catch: () => new DatabaseUnavailable({ operation: "database/connect" }),
        });

        if (probe.length === 0) {
          return yield* new DatabaseUnavailable({ operation: "database/connect" });
        }

        return Database.of({ sql });
      }),
      (database) => Effect.promise(() => database.sql.end({ timeout: 5 })).pipe(Effect.ignore),
    );
  }),
);

/**
 * Serialization/deadlock retry budget: at most two retries with exponential
 * backoff (100ms, 200ms). Only TransactionConflict (40001/40P01) retries;
 * constraint violations, invalid SQL, and connection loss fail immediately.
 */
const TRANSACTION_RETRY_ATTEMPTS = 2;

const TRANSACTION_RETRY_SCHEDULE = Schedule.exponential("100 millis");

const releaseQuietly = (tx: postgres.ReservedSql): void => {
  try {
    tx.release();
  } catch {
    // The reservation is already being torn down; a release failure here
    // must not mask the original error, so it is deliberately dropped.
  }
};

/**
 * Reserves one connection and opens a transaction on it. A failed `BEGIN`
 * releases the reservation before propagating, so callers of
 * `Effect.acquireUseRelease` never receive a connection they must clean up
 * after a failed acquire. `release` is synchronous in postgres.js; the quiet
 * release above keeps a release failure from masking the BEGIN error.
 */
const beginTransaction = async (sql: postgres.Sql): Promise<postgres.ReservedSql> => {
  const tx = await sql.reserve();

  try {
    await tx.unsafe("BEGIN");
  } catch (beginCause: unknown) {
    releaseQuietly(tx);
    throw beginCause;
  }

  return tx;
};

/**
 * Runs `effect` inside a single postgres.js transaction on one reserved
 * connection. Participating repositories resolve the transaction client
 * through `currentSql`, so no statement silently uses the pool mid-transaction.
 *
 * Resource guarantees, per reserved connection:
 *
 * - Reservation failure: nothing is held; the attempt fails.
 * - `BEGIN` failure after reservation: the connection is released before
 *   the attempt fails, so a failed BEGIN cannot leak it.
 * - Query failure, typed Effect failure, defect, or interruption: `ROLLBACK`
 *   issues and the connection is released. A failed `ROLLBACK` (for example
 *   a dead connection) can never mask the original failure and the release
 *   is still attempted.
 * - `COMMIT` failure: the connection is still released, and the failure
 *   surfaces as `TransactionFailed`. Commit failures are never retried: the
 *   commit may have succeeded server-side, so retrying could double-apply.
 * - Successful `COMMIT` with a failed release surfaces as
 *   `TransactionFailed` rather than a silent success.
 * - Release runs as an uninterruptible finalizer, so interruption of the
 *   transaction body cannot strand the connection.
 *
 * A serialization conflict or deadlock aborts the whole transaction, so the
 * retry wraps the full acquire/use/release attempt: each attempt reserves a
 * fresh connection and issues a new BEGIN. Attempts are bounded
 * (TRANSACTION_RETRY_ATTEMPTS with exponential backoff); an exhausted conflict
 * propagates as `TransactionConflict`, which maps to 503 like other transient
 * database failures. Only `TransactionConflict` retries — constraint
 * violations, invalid SQL, connection loss, and `TransactionFailed` fail
 * immediately, and interruptions never retry.
 */
export const withTransaction = <A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R | TxSql>,
): Effect.Effect<A, E | TransactionFailed, R | Database> =>
  Effect.flatMap(Effect.serviceOption(TxSql), (existing) => {
    // A composed workflow owns the transaction; participating operations reuse it.
    if (Option.isSome(existing)) return Effect.provideService(effect, TxSql, existing.value);

    return Effect.flatMap(Database, (db) => {
      const attempt = Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => beginTransaction(db.sql),
          catch: (cause) =>
            new TransactionFailed({
              operation,
              cause: describeCause(cause),
            }),
        }),
        (tx) => Effect.provideService(effect, TxSql, tx),
        (tx, exit) =>
          Exit.isSuccess(exit)
            ? Effect.tryPromise({
                try: async () => {
                  try {
                    await tx.unsafe("COMMIT");
                  } finally {
                    tx.release();
                  }
                },
                catch: (cause) =>
                  new TransactionFailed({
                    operation,
                    cause: describeCause(cause),
                  }),
              })
            : Effect.promise(() =>
                tx
                  .unsafe("ROLLBACK")
                  .catch(() => undefined)
                  .then(() => tx.release())
                  .catch(() => undefined),
              ).pipe(Effect.ignore, Effect.andThen(Effect.void)),
      );

      return Effect.retry(attempt, {
        while: (error) => error instanceof TransactionConflict,
        times: TRANSACTION_RETRY_ATTEMPTS,
        schedule: TRANSACTION_RETRY_SCHEDULE,
      });
    });
  });

export const checkDatabaseHealth = Effect.gen(function* () {
  const db = yield* Database;

  const rows = yield* Effect.tryPromise({
    try: () => db.sql`SELECT 1 AS ok`,
    catch: () => new DatabaseUnavailable({ operation: "database/health" }),
  });

  if (rows.length === 0) {
    return yield* new DatabaseUnavailable({ operation: "database/health" });
  }

  return true as const;
});
