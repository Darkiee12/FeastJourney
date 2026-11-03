import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  isScanClientError,
  ownedScanIdFrom,
  scanEntrySearch,
  scanStatusText,
} from "@/modules/muse-copilot/flows/scan-return-adapter";
import type { WorkspacePanelApi } from "@/modules/muse-copilot/flows/task-panel";
import { menuScanClient } from "@/modules/restaurant-discovery/menu-scan-client";

/**
 * Scan handoff (plan §15). The canonical `/scan` route owns capture,
 * validation, persistence, extraction, and review — nothing is duplicated
 * here. Selecting the task navigates directly to `/scan` with locale,
 * validated venue scope, and the Muse return context; the manual button
 * below stays only as a fallback (blocked navigation, retry). Returning
 * with an owned scan id renders the continue-with-scan actions (ask,
 * explain, order, inspect, find similar); ownership and expiry re-verify
 * server-side on entry, mapping to actionable errors before any re-upload.
 * Only the owned scan id rides the link — no secrets, no revision
 * metadata in Muse UI.
 */
export function ScanPanel({
  context,
  copy,
  onUpdateContext,
  publishNote,
  selectTask,
  setDraft,
}: WorkspacePanelApi): ReactNode {
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);

  const ownedScanId = ownedScanIdFrom(context.scanId);

  // Direct entry: first mount without a return scan goes straight to the
  // canonical scanner. Runs once — an expired-scan clearing below must not
  // re-trigger navigation while the visitor reads the recovery guidance.
  const didEnter = useRef(false);

  useEffect(() => {
    if (didEnter.current || ownedScanId !== null) {
      return;
    }

    didEnter.current = true;
    setOpening(true);

    void navigate({
      to: "/scan",
      search: scanEntrySearch(context.language, context.venueId),
    });
  }, [context.language, context.venueId, navigate, ownedScanId]);

  // Return verification: the scan id re-authorizes server-side on entry.
  // Expired or foreign scans surface an actionable error and drop the id so
  // the entry state (with its scan-again path) returns. Runs once per id;
  // revision metadata is never rendered.
  const verifiedRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    if (ownedScanId !== null && verifiedRef.current !== ownedScanId) {
      verifiedRef.current = ownedScanId;

      void (async () => {
        try {
          await menuScanClient.get(ownedScanId);
        } catch (error) {
          if (cancelledRef.current) {
            return;
          }

          publishNote(
            isScanClientError(error) ? scanStatusText(copy, error) : copy.errorUnavailable,
          );
          onUpdateContext({ scanId: undefined });
        }
      })();
    }

    return () => {
      cancelledRef.current = true;
    };
  }, [copy, onUpdateContext, ownedScanId, publishNote]);

  const openScanner = (): void => {
    setOpening(true);

    void navigate({
      to: "/scan",
      search: scanEntrySearch(context.language, context.venueId),
    });
  };

  const inspectScan = (): void => {
    // Owned-scan branch only: ownedScanId is already a validated uuid
    // (ownedScanIdFrom rejects anything else). The canonical `/scan` route
    // carries no scan id in its search contract — it restores this exact
    // scan from session storage and offers the Muse return link — so entry
    // carries the same locale/venue scope plus return context, and the page
    // resumes the owned scan instead of starting a blank capture.
    if (ownedScanId === null) {
      openScanner();

      return;
    }

    setOpening(true);

    void navigate({
      to: "/scan",
      search: scanEntrySearch(context.language, context.venueId),
    });
  };

  if (ownedScanId !== null) {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-border-soft bg-white px-4 py-3 shadow-[0_8px_20px_rgba(3,10,30,0.08)]">
        <p className="text-sm font-bold text-ink">{copy.scanContextTitle}</p>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setDraft(copy.scanAskMenu);
              selectTask("ask");
            }}
            className="inline-flex min-h-9 cursor-pointer items-center rounded-full bg-food-orange-strong px-4 text-xs font-bold text-white transition hover:bg-food-orange-dark"
          >
            {copy.scanAskMenu}
          </button>

          <button
            type="button"
            onClick={() => {
              setDraft(copy.scanExplainItem);
              selectTask("ask");
            }}
            className="inline-flex min-h-9 cursor-pointer items-center rounded-full border border-border-soft bg-white px-4 text-xs font-bold text-ink transition hover:border-food-orange-strong"
          >
            {copy.scanExplainItem}
          </button>

          <button
            type="button"
            onClick={() => {
              selectTask("order");
            }}
            className="inline-flex min-h-9 cursor-pointer items-center rounded-full border border-border-soft bg-white px-4 text-xs font-bold text-ink transition hover:border-food-orange-strong"
          >
            {copy.scanBuildOrder}
          </button>

          <button
            type="button"
            onClick={inspectScan}
            disabled={opening}
            className="inline-flex min-h-9 cursor-pointer items-center rounded-full border border-border-soft bg-white px-4 text-xs font-bold text-ink transition hover:border-food-orange-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copy.orderOpenScan}
          </button>

          <button
            type="button"
            onClick={() => {
              setDraft(copy.scanFindSimilar);
              selectTask("find");
            }}
            className="inline-flex min-h-9 cursor-pointer items-center rounded-full border border-border-soft bg-white px-4 text-xs font-bold text-ink transition hover:border-food-orange-strong"
          >
            {copy.scanFindSimilar}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border-soft bg-white px-4 py-3 shadow-[0_8px_20px_rgba(3,10,30,0.08)]">
      <p className="text-sm leading-relaxed text-ink">
        {context.venueId === undefined ? copy.taskScanBlurb : copy.taskScanTitle}
      </p>

      <button
        type="button"
        onClick={openScanner}
        disabled={opening}
        className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full bg-food-orange-strong px-5 text-sm font-bold text-white transition hover:bg-food-orange-dark disabled:cursor-not-allowed disabled:opacity-50"
      >
        {opening ? copy.openingScanner : copy.openScanner}
      </button>
    </div>
  );
}

export default ScanPanel;
