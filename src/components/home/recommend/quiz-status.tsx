import { Match } from "effect";
import { SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { RankingProvenance } from "@/modules/food-discovery/server/operations/recommendation-service";
import type { Messages } from "@/shared/i18n";

/**
 * Status hierarchy for recommendation outcomes.
 *
 * - Errors (transport failure) are retryable alerts with a recovery action.
 * - Allergy limits are prominent: the backend refuses to rank when safety is
 *   unverifiable, so the refusal reads as a safety notice, never a warning.
 * - Deterministic-rank fallbacks are one discreet sidebar notice, never a
 *   dominant banner; dietary/unknown-dislike warnings keep the banner.
 * - Unknown-dislike warnings stay visible but secondary to results.
 */
export function QuizError({
  copy,
  onRetry,
}: {
  readonly copy: Messages;
  readonly onRetry: () => void;
}) {
  return (
    <div>
      <p
        role="alert"
        className="rounded-xl border-2 border-danger bg-white px-4 py-3 text-sm font-bold text-danger"
      >
        {copy.recError}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex min-h-11 cursor-pointer items-center rounded-full bg-ink px-6 text-sm font-bold text-white transition hover:opacity-90"
      >
        {copy.recRetry}
      </button>
    </div>
  );
}

export function ResultWarnings({
  copy,
  warnings,
}: {
  readonly copy: Messages;
  readonly warnings: ReadonlyArray<string>;
}) {
  // Ranking-availability fallbacks are status, not warnings: they render
  // once, discreetly, in the sidebar ranking card. The banner keeps only
  // user-actionable notes (dietary/unknown-dislike), which stay prominent.
  const visible = userWarningsFor(warnings);

  if (visible.length === 0) {
    return null;
  }

  return (
    <div className="rounded-2xl border-2 border-mango bg-cream px-4 py-3">
      <p className="text-sm font-extrabold text-ink">
        <TriangleAlertIcon aria-hidden="true" className="size-4" /> {copy.recWarningsLabel}
      </p>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-6 text-sm text-ink">
        {visible.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Ranking modes that carry a visible brand. Mirrors the wire outcome subset
 * that renders dishes; the value always comes straight from `outcome.mode`
 * (quiz-flow.tsx renderOutcome) — never inferred from config, warnings, or
 * any other client-side signal.
 */
export type RecommendationModeLabel = "ai" | "deterministic";

/**
 * Ranking-status markers. These server-English sentences are filtered out of
 * the banner (userWarningsFor): the degraded *variant* branches on the
 * structured `ranking` field, but warning strings still need markers to tell
 * ranking-availability notes (shown once, in the ranking card) apart from
 * dietary/unknown-dislike notes (shown in the banner).
 */
const RANKING_STATUS_MARKERS = [
  "AI ranking was",
  "Sign in for AI-ranked picks",
  "AI ranking is not configured",
] as const;

/** True for ranking-availability notes: ranking status, not warnings. */
export const isAiFallbackWarning = (warning: string): boolean =>
  RANKING_STATUS_MARKERS.some((marker) => warning.includes(marker));

/** Server note for a Surprise pick: expected behaviour, nothing to warn about. */
const SURPRISE_NOTE_MARKER = "Surprise variety applied";

/**
 * Banner-visible warnings: everything except AI-availability fallbacks and
 * the Surprise note. Dietary and unknown-dislike notes stay prominent in the
 * banner; the fallback renders once, discreetly, in the sidebar ranking card
 * instead of duplicating across both.
 */
export const userWarningsFor = (warnings: ReadonlyArray<string>): Array<string> =>
  warnings.filter(
    (warning) => !isAiFallbackWarning(warning) && !warning.includes(SURPRISE_NOTE_MARKER),
  );

/**
 * One coherent ranking status for both placements (inline note and sidebar
 * card). `mode` is the single branding source of truth — only `mode === "ai"`
 * renders Muse branding, with the ranking-only explainer. Deterministic
 * renders neutral catalog wording with no icon; a degraded AI attempt
 * (`ranking._tag === "DegradedMuse"`) says so honestly instead of silently
 * passing as catalog order. Warning text is never parsed to decide state.
 */
export type RankingVariant = "ai" | "degraded" | "catalog";

export const rankingVariantFor = (
  mode: RecommendationModeLabel,
  ranking: RankingProvenance,
): RankingVariant => {
  if (mode === "ai") {
    return "ai";
  }

  return Match.value(ranking).pipe(
    Match.tag("DegradedMuse", (): RankingVariant => "degraded"),
    Match.orElse((): RankingVariant => "catalog"),
  );
};

/**
 * Interim localized sentences for mode labels (see the TODO on
 * AI_FALLBACK_MARKER). One writer only: both RankingNote and
 * AiExplanationCard read these, so the inline note and the sidebar card can
 * never drift apart.
 */
const aiExplainerFor = (copy: Messages): string => copy.recAiExplainer;

const catalogNoteFor = (copy: Messages): string => copy.recCatalogNote;

const fallbackNoteFor = (copy: Messages): string => copy.recFallbackNote;

type RankingNoteModeProps = {
  readonly mode: RecommendationModeLabel;
  readonly ranking: RankingProvenance;
  readonly copy: Messages;
};

/**
 * Mode label for the results area. Thin inline placement over the shared
 * ranking core: AI shows a subtle sparkles icon, the localized AI title, and
 * a one-line explainer that credits Muse with ranking only — catalog names
 * and descriptions stay as curated and are never presented as AI-written.
 * Deterministic shows no icon and states the picks come from the food
 * catalog; a degraded AI attempt (fallback warning present) says so instead
 * of silently passing as catalog order.
 */
export function RankingNote(props: RankingNoteModeProps) {
  const variant = rankingVariantFor(props.mode, props.ranking);

  if (variant === "ai") {
    return (
      <div className="mb-3 flex flex-col gap-1">
        <p className="flex items-center gap-1.5 text-sm font-bold text-ink">
          <SparklesIcon aria-hidden="true" className="size-4 flex-none text-food-orange-strong" />
          {props.copy.recAiRankedTitle}
        </p>
        <p className="text-sm font-semibold text-muted">{aiExplainerFor(props.copy)}</p>
      </div>
    );
  }

  if (variant === "degraded") {
    return <p className="mb-3 text-sm font-semibold text-muted">{fallbackNoteFor(props.copy)}</p>;
  }

  return <p className="mb-3 text-sm font-semibold text-muted">{catalogNoteFor(props.copy)}</p>;
}

/**
 * Sidebar-ready ranking card over the same shared core as RankingNote, so
 * the inline note and the sidebar card can never drift apart. Explicit props
 * only: `mode` (straight from `outcome.mode`) is the single branding source
 * of truth — only `mode === "ai"` renders Muse branding, and only with the
 * ranking-only explainer (catalog names/descriptions are never presented as
 * AI-written, and no scores are shown or invented). Deterministic renders
 * neutral catalog wording with no icon; a degraded AI attempt (fallback
 * warning present) renders ONE discreet notice here — the banner no longer
 * repeats it (see userWarningsFor), and the fallback reason stays distinct
 * from dietary warnings. Empty and uncertain render explanatory states — the
 * panel owns those, so the card never renders dish content for them.
 */
export type AiCardMode = "ai" | "deterministic" | "uncertain" | "empty";

const NO_REASONS: ReadonlyArray<string> = [];

export function AiExplanationCard({
  mode,
  ranking,
  copy,
  reasons = NO_REASONS,
}: {
  readonly mode: AiCardMode;
  readonly ranking: RankingProvenance;
  readonly copy: Messages;
  readonly reasons?: ReadonlyArray<string>;
}) {
  if (mode === "ai") {
    return (
      <aside
        aria-label={copy.recAiRankedTitle}
        className="rounded-2xl border-2 border-mango bg-cream px-4 py-3"
      >
        <p className="flex items-center gap-1.5 text-sm font-extrabold text-ink">
          <SparklesIcon aria-hidden="true" className="size-4 flex-none text-food-orange-strong" />
          {copy.recAiRankedTitle}
        </p>
        <p className="mt-1 text-sm font-semibold text-ink">{aiExplainerFor(copy)}</p>
      </aside>
    );
  }

  if (mode === "deterministic") {
    const variant = rankingVariantFor(mode, ranking);

    return (
      <aside className="rounded-2xl border-2 border-border-soft bg-white px-4 py-3">
        <p className="text-sm font-semibold text-muted">
          {variant === "degraded" ? fallbackNoteFor(copy) : catalogNoteFor(copy)}
        </p>
      </aside>
    );
  }

  return (
    <aside className="rounded-2xl border-2 border-border-soft bg-white px-4 py-3">
      <p className="text-sm font-extrabold text-ink">{copy.recReasonsHeading}</p>
      {reasons.length > 0 ? (
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-6 text-sm text-ink">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {mode === "empty" ? (
        <p className="mt-2 text-sm font-semibold text-muted">{copy.recEmptySuggest}</p>
      ) : null}
    </aside>
  );
}

/** Display bound for a per-dish Muse reason (mirrors the server contract). */
export const MAX_DISPLAY_REASON_LENGTH = 340;

const CONTROL_CODE_POINTS: ReadonlySet<number> = new Set([0x2028, 0x2029]);

const isControlCodePoint = (code: number): boolean =>
  code <= 0x1f || code === 0x7f || CONTROL_CODE_POINTS.has(code);

/**
 * Clean one model reason for display: blanks and control characters never
 * render; output truncates to the server bound. Plain text only — callers
 * render it as a React string child, never as HTML. The input is already a
 * domain string: non-string model output is rejected at the service Schema
 * boundary, so this layer only trims and truncates validated text.
 */
export const cleanReasonForDisplay = (reason: string | null | undefined): string | null => {
  if (reason === null || reason === undefined) {
    return null;
  }

  const cleaned = Array.from(reason)
    .filter((ch) => !isControlCodePoint(ch.codePointAt(0) ?? 0))
    .join("")
    .trim();

  if (cleaned === "") {
    return null;
  }

  return cleaned.slice(0, MAX_DISPLAY_REASON_LENGTH);
};

/**
 * Selected-dish Muse explanation, rendered INSIDE the featured carousel
 * card as a full-width top strip (the card provides the cream background,
 * padding, and borders — this component renders label, text, and toggle
 * only). Provenance-gated: renders ONLY when `liveMuse` is true
 * (backend-confirmed live Muse ranking), so deterministic, degraded, and
 * stale/cross-identity payloads never present model text as personalization.
 * Collapsed to three lines with a compact expand toggle on mobile; the
 * toggle hides on desktop where the strip has a fixed height and scrolls.
 */
export function SelectedDishReason({
  aiReason,
  copy,
  liveMuse,
}: {
  readonly aiReason: string | null | undefined;
  readonly copy: Messages;
  readonly liveMuse: boolean;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);

  if (!liveMuse) {
    return null;
  }

  const reason = cleanReasonForDisplay(aiReason);

  if (reason === null) {
    return null;
  }

  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs font-extrabold tracking-wide text-food-orange-strong uppercase">
        <SparklesIcon aria-hidden="true" className="size-3.5 flex-none" />
        {copy.recWhyMusePicked}
      </p>
      <p
        className={
          expanded
            ? "mt-1 text-[13px] leading-relaxed text-ink"
            : "mt-1 line-clamp-3 text-[13px] leading-relaxed text-ink"
        }
      >
        {reason}
      </p>
      {reason.length > 120 ? (
        <button
          type="button"
          onClick={() => {
            setExpanded(!expanded);
          }}
          aria-expanded={expanded}
          className="mt-1 inline-flex min-h-8 cursor-pointer items-center rounded-full px-2 text-xs font-bold text-muted underline decoration-2 underline-offset-4 transition hover:text-ink md:hidden"
        >
          {expanded ? copy.recReasonLess : copy.recReasonMore}
        </button>
      ) : null}
    </div>
  );
}
