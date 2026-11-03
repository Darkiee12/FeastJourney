import {
  CircleCheckIcon,
  LoaderCircle,
  SearchXIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ReactNode } from "react";

/**
 * Lifecycle of one user-triggered web-research run. `idle` renders only a
 * reserved placeholder (the caller owns the trigger button); `preparing`
 * covers synchronous setup, `searching` is entered only once the fetch is
 * actually in flight, and `reviewing` covers mapping the response.
 */
export type ResearchStatusState =
  | "idle"
  | "preparing"
  | "searching"
  | "reviewing"
  | "completed"
  | "no-evidence"
  | "failed";

export interface MuseResearchStatusProps {
  readonly state: ResearchStatusState;
  /** Caller-composed status line (from research-copy); the only user copy shown. */
  readonly contextLine?: string | undefined;
  /** Shown on `failed`; label via `retryLabel`. */
  readonly onRetry?: (() => void) | undefined;
  /** Shown on `no-evidence` and `failed`; label via `continueLabel`. */
  readonly onContinue?: (() => void) | undefined;
  /** Visible retry text (research-copy `retryAction`); English fallback. */
  readonly retryLabel?: string | undefined;
  /** Visible continue text (research-copy `continueCatalogAction`); English fallback. */
  readonly continueLabel?: string | undefined;
}

const FRAME =
  "flex min-h-28 w-full flex-col items-center justify-center gap-3 rounded-2xl border border-border-soft bg-white px-5 py-4 text-center shadow-[0_12px_28px_rgba(194,65,12,0.08)]";

const MEDALLION = "flex size-11 items-center justify-center rounded-full bg-space-deep text-cream";

const RETRY_BUTTON =
  "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full bg-food-orange-strong px-5 text-sm font-bold text-white transition hover:bg-food-orange-dark";

const CONTINUE_BUTTON =
  "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border-2 border-ink bg-white px-5 text-sm font-bold text-ink transition hover:bg-ink hover:text-white";

const isBusy = (state: ResearchStatusState): boolean =>
  state === "preparing" || state === "searching" || state === "reviewing";

/**
 * Compact research status card: indeterminate spinner while working (never
 * percentages, counts, or named stages), honest result lines with retry and
 * continue-with-catalog actions on terminal states. No modal, no chat
 * widget chrome — cream card, dark-navy medallion, orange accents matching
 * the discovery panels. Status text arrives via `contextLine`, so this
 * component holds no hardcoded user strings besides aria labels and the
 * English button fallbacks used when labels are omitted.
 */
export function MuseResearchStatus({
  continueLabel,
  contextLine,
  onContinue,
  onRetry,
  retryLabel,
  state,
}: MuseResearchStatusProps): ReactNode {
  if (state === "idle") {
    return (
      <div className={FRAME} aria-hidden="true">
        <span>{" "}</span>
      </div>
    );
  }

  if (isBusy(state)) {
    return (
      <div className={FRAME}>
        <output aria-live="polite" className="flex flex-col items-center gap-3">
          <span className={MEDALLION}>
            <LoaderCircle
              aria-hidden="true"
              className="size-5 animate-spin motion-reduce:animate-none"
            />
          </span>
          {contextLine === undefined || contextLine === "" ? null : (
            <span className="text-sm font-semibold text-muted">{contextLine}</span>
          )}
        </output>
      </div>
    );
  }

  if (state === "completed") {
    return (
      <div className={FRAME}>
        <output
          aria-live="polite"
          className="flex flex-col items-center gap-3"
          aria-label="Web research completed"
        >
          <span className={MEDALLION}>
            <CircleCheckIcon aria-hidden="true" className="size-5" />
          </span>
          {contextLine === undefined || contextLine === "" ? null : (
            <span className="text-sm font-semibold text-muted">{contextLine}</span>
          )}
        </output>
      </div>
    );
  }

  if (state === "no-evidence") {
    return (
      <div className={FRAME}>
        <output
          aria-live="polite"
          className="flex flex-col items-center gap-3"
          aria-label="Web research found nothing"
        >
          <span className={MEDALLION}>
            <SearchXIcon aria-hidden="true" className="size-5" />
          </span>
          {contextLine === undefined || contextLine === "" ? null : (
            <span className="text-sm font-semibold text-muted">{contextLine}</span>
          )}
        </output>
        {onContinue === undefined ? null : (
          <button type="button" onClick={onContinue} className={CONTINUE_BUTTON}>
            {continueLabel ?? "Continue with catalog"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div role="alert" className={FRAME}>
      <output
        aria-live="polite"
        className="flex flex-col items-center gap-3"
        aria-label="Web research failed"
      >
        <span className="flex size-11 items-center justify-center rounded-full bg-danger/10 text-danger">
          <TriangleAlertIcon aria-hidden="true" className="size-5" />
        </span>
        {contextLine === undefined || contextLine === "" ? null : (
          <span className="text-sm font-semibold text-muted">{contextLine}</span>
        )}
      </output>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {onRetry === undefined ? null : (
          <button type="button" onClick={onRetry} className={RETRY_BUTTON}>
            <SparklesIcon aria-hidden="true" className="size-4 flex-none" />
            {retryLabel ?? "Try again"}
          </button>
        )}
        {onContinue === undefined ? null : (
          <button type="button" onClick={onContinue} className={CONTINUE_BUTTON}>
            {continueLabel ?? "Continue with catalog"}
          </button>
        )}
      </div>
    </div>
  );
}
