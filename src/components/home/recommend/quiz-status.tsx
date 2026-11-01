import { Match } from "effect";
import { SparklesIcon, TriangleAlertIcon } from "lucide-react";

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

/**
 * Banner-visible warnings: everything except AI-availability fallbacks.
 * Dietary and unknown-dislike notes stay prominent in the banner; the
 * fallback renders once, discreetly, in the sidebar ranking card instead of
 * duplicating across both.
 */
export const userWarningsFor = (warnings: ReadonlyArray<string>): Array<string> =>
  warnings.filter((warning) => !isAiFallbackWarning(warning));

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
