import { Effect } from "effect";

import cleanupAsset from "@/modules/restaurant-discovery/server/repository/sql/scan-cleanup-asset.sql";
import cleanupAssets from "@/modules/restaurant-discovery/server/repository/sql/scan-cleanup-assets.sql";
import cleanupFailed from "@/modules/restaurant-discovery/server/repository/sql/scan-cleanup-failed.sql";
import cleanupFinish from "@/modules/restaurant-discovery/server/repository/sql/scan-cleanup-finish.sql";
import cleanupMark from "@/modules/restaurant-discovery/server/repository/sql/scan-cleanup-mark.sql";
import cleanupRevisions from "@/modules/restaurant-discovery/server/repository/sql/scan-cleanup-revisions.sql";
import { runQuery } from "@/server/database/query";
import { PrivateMenuStorage } from "@/server/integrations/private-menu-storage";

export interface MenuScanCleanupReport {
  readonly sessionsExpired: number;
  readonly objectsDeleted: number;
  readonly objectsFailed: number;
  readonly sessionsFinished: number;
}

/**
 * Retryable private-scan cleanup. Every stage is idempotent, so an
 * interrupted run resumes safely on the next schedule:
 *
 * 1. Expired sessions move to `deleting` (bounded batch, row-locked).
 * 2. Each expired or abandoned asset's Garage object is removed; a storage
 *    failure only bumps `delete_attempts` and is retried next run. Removal
 *    never blocks on one bad object.
 * 3. Sessions with no remaining assets move to `deleted`.
 * 4. Private revision JSON is erased after access and binary deletion. Minimal
 *    contribution attribution keeps its submitted revision number.
 *
 * Promoted facts retain the same registered assets and consented expiry.
 */
export const cleanupMenuScans = Effect.fn("menu.cleanup")(function* () {
  const marked = yield* runQuery("menu/cleanup-mark", (sql) => cleanupMark.run(sql));
  const storage = yield* PrivateMenuStorage;

  let objectsDeleted = 0;
  let objectsFailed = 0;

  const assets = yield* runQuery("menu/cleanup-assets", (sql) => cleanupAssets.run(sql));

  yield* Effect.forEach(
    assets,
    (asset) =>
      storage.remove(asset.object_key).pipe(
        Effect.tap(() =>
          runQuery("menu/cleanup-asset", (sql) => cleanupAsset.run(sql, { id: asset.id })),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            objectsDeleted += 1;
          }),
        ),
        Effect.catch(() =>
          runQuery("menu/cleanup-failed", (sql) => cleanupFailed.run(sql, { id: asset.id })).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                objectsFailed += 1;
              }),
            ),
            Effect.tapError(() =>
              Effect.logWarning("Menu scan cleanup storage failure", {
                assetId: asset.id,
              }),
            ),
          ),
        ),
      ),
    { concurrency: 4 },
  );

  const finished = yield* runQuery("menu/cleanup-finish", (sql) => cleanupFinish.run(sql));
  yield* runQuery("menu/cleanup-revisions", (sql) => cleanupRevisions.run(sql));

  return {
    sessionsExpired: marked.length,
    objectsDeleted,
    objectsFailed,
    sessionsFinished: finished.length,
  } satisfies MenuScanCleanupReport;
});
