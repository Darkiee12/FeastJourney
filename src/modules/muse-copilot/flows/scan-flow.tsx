import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { z } from "zod";

import type { WorkspacePanelApi } from "@/modules/muse-copilot/flows/task-panel";

const uuidSchema = z.uuid();

/**
 * Scan handoff (plan §15). The canonical `/scan` route owns capture,
 * validation, persistence, extraction, and review — nothing is duplicated
 * here. Entry navigates directly to `/scan` with locale, verified venue
 * scope, and the Muse return context; no intermediate scanner form lives
 * in the workspace. Returning with an owned scan id renders the
 * continue-with-scan actions (ask, explain, order, find similar); ownership
 * re-verifies server-side on every use and no secrets ride the URL.
 *
 * Known gap: the scanner's "Continue with Muse" link does not yet carry
 * the owned scan id back (menu-scan-page is outside this lane), so returns
 * land without scan context until that link appends `scan=<id>`.
 */
export function ScanPanel({ context, copy, selectTask, setDraft }: WorkspacePanelApi): ReactNode {
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);

  const openScanner = (): void => {
    setOpening(true);

    const parsedVenue = uuidSchema.safeParse(context.venueId);

    void navigate({
      to: "/scan",
      search: parsedVenue.success
        ? {
            lang: context.language,
            venueId: parsedVenue.data,
            returnVenue: parsedVenue.data,
            returnView: "copilot" as const,
          }
        : { lang: context.language, returnView: "copilot" as const },
    });
  };

  if (context.scanId !== undefined) {
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
