import { Cause, Effect, Exit, Layer, ManagedRuntime, Result } from "effect";

import { cleanupMenuScans } from "@/modules/restaurant-discovery/server/operations/scan-cleanup";
import { DatabaseLive } from "@/server/database/client";
import { clientFailure } from "@/server/http/client-failure";
import { PrivateMenuStorageLive } from "@/server/integrations/private-menu-storage";

/**
 * Retryable private-scan maintenance. Run on a schedule outside request
 * traffic (cron, systemd timer, or deployment job):
 *
 *   bun scripts/cleanup-menu-scans.ts
 *
 * Every stage is idempotent: expired sessions are marked, Garage objects are
 * removed with per-object failure tracking, finished sessions close out, and
 * expired revision drafts are erased. Interrupted runs resume safely.
 * Only registered scan assets are touched, including reviewed contribution photos.
 */
const maintenanceRuntime = ManagedRuntime.make(Layer.merge(DatabaseLive, PrivateMenuStorageLive));

const exit = await maintenanceRuntime.runPromiseExit(
  cleanupMenuScans().pipe(Effect.annotateLogs({ operation: "menu-scans/cleanup" })),
);

if (Exit.isSuccess(exit)) {
  process.stdout.write(`menu scan cleanup: ${JSON.stringify(exit.value)}\n`);

  if (exit.value.objectsFailed > 0) process.exitCode = 1;
} else {
  const failure = Result.match(Cause.findError(exit.cause), {
    onSuccess: clientFailure,
    onFailure: () => clientFailure(undefined),
  });

  process.stderr.write(`menu scan cleanup failed: ${failure._tag}\n`);
  process.exitCode = 1;
}

await maintenanceRuntime.dispose();
