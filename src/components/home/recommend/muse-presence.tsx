import { SparklesIcon } from "lucide-react";
import type { ReactNode } from "react";

import { isActiveProgressStage } from "@/components/home/recommend/agent-progress";
import type { ProgressStage } from "@/modules/food-discovery/server/agent/protocol";
import type { Messages } from "@/shared/i18n";

export interface MusePresenceProps {
  readonly copy: Messages;
  /** Latest backend stage, or null before the first real progress event. */
  readonly stage: ProgressStage | null;
  /**
   * True only after a genuine backend progress event applied for this
   * request. Deterministic, degraded, guest, and pre-stream states stay
   * neutral and never claim Muse curation.
   */
  readonly live: boolean;
  /** Compact drawer footprint: smaller badge and type, same behavior. */
  readonly compact?: boolean;
}

/**
 * Secondary line for one backend stage. Terminal stages never produce a
 * line — the outcome owns the UI from there — so the presence never
 * narrates a finished, degraded, or failed run as ongoing curation.
 * Driven ONLY by real backend state, never timers.
 */
export const agentStageLineFor = (stage: ProgressStage, copy: Messages): string | null => {
  switch (stage) {
    case "preparing": {
      return copy.recAgentPreparing;
    }
    case "searching-catalog": {
      return copy.recAgentSearching;
    }
    case "muse-curating": {
      return copy.recAgentCurating;
    }
    case "inspecting-dishes": {
      return copy.recAgentInspecting;
    }
    case "finalizing": {
      return copy.recAgentFinalizing;
    }
    case "completed":
    case "degraded":
    case "failed":
    default: {
      return null;
    }
  }
};

/**
 * Single screen-reader status line. Announced through the caller's
 * `aria-live` outcome wrapper (quiz-flow `renderOutcome`), so this adds no
 * live region of its own and never repeats: identical text across renders
 * is not re-announced.
 */
export const agentPresenceStatusText = (
  copy: Messages,
  stage: ProgressStage | null,
  live: boolean,
): string => {
  if (!live || stage === null || !isActiveProgressStage(stage)) {
    return copy.recLoading;
  }

  const line = agentStageLineFor(stage, copy);

  if (line === null) {
    return copy.recLoading;
  }

  return `${copy.recAgentTitle} ${line}`;
};

/**
 * Friendly Muse presence rendered INSIDE the existing featured-image
 * placeholder (the caller absolutely positions this over the skeleton
 * media frame). Native to FeastJourney: sparkle badge in cream/mango with
 * food-orange ink, extrabold ink title, muted secondary line.
 *
 * - Stable dimensions: the caller reserves the space; this is a centered
 *   column with no fixed heights of its own.
 * - Honest: renders nothing unless a real backend event made this run
 *   `live` on an active stage. Neutral (deterministic/degraded) runs keep
 *   the plain pulse skeleton with zero Muse branding.
 * - Accessible: fully `aria-hidden` (the sr-only status line carries the
 *   announcement exactly once per stage); motion collapses under
 *   `motion-reduce` via the shared `animate-pulse` convention — one speed,
 *   off when reduced. SSR-safe: no browser APIs, no effects, no timers.
 */
export function MusePresence({ copy, stage, live, compact = false }: MusePresenceProps): ReactNode {
  if (!live || stage === null || !isActiveProgressStage(stage)) {
    return null;
  }

  const line = agentStageLineFor(stage, copy);

  if (line === null) {
    return null;
  }

  return (
    <div aria-hidden="true" className="flex flex-col items-center px-4 text-center">
      <span
        className={
          compact
            ? "relative inline-flex size-9 items-center justify-center rounded-full border-2 border-mango bg-cream"
            : "relative inline-flex size-12 items-center justify-center rounded-full border-2 border-mango bg-cream"
        }
      >
        <span className="absolute inset-0 animate-pulse rounded-full bg-mango/30 motion-reduce:animate-none" />
        <SparklesIcon
          aria-hidden="true"
          className={
            compact
              ? "relative size-4 text-food-orange-strong"
              : "relative size-5 text-food-orange-strong"
          }
        />
        <span className="absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full bg-food-orange-strong [animation-delay:600ms] motion-reduce:animate-none" />
      </span>
      <p className={compact ? "mt-2 text-xs font-extrabold text-ink" : "mt-2.5 text-sm font-extrabold text-ink"}>
        {copy.recAgentTitle}
      </p>
      <p
        key={stage}
        className={
          compact
            ? "mt-1 text-xs font-semibold text-muted motion-safe:animate-rec-step-enter"
            : "mt-1 text-[13px] font-semibold text-muted motion-safe:animate-rec-step-enter"
        }
      >
        {line}
      </p>
    </div>
  );
}
