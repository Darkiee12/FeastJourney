import type { ReactNode } from "react";

import { DishCarouselCompactSkeleton, DishCarouselSkeleton } from "@/components/dish/dish-carousel";
import type { Messages } from "@/shared/i18n";

/**
 * Rail skeleton card-count bounds. The loaded rail renders one thumbnail
 * per dish (up to ten, horizontally scrolled); the skeleton shows a fixed
 * 3–5 placeholder cards with responsive visibility — never ten — so the
 * loading footprint stays shorter than any real result set without
 * implying a result count.
 */
export const RESULTS_LOADING_SKELETON_MIN_CARDS = 3;
export const RESULTS_LOADING_SKELETON_MAX_CARDS = 5;
export const RESULTS_LOADING_SKELETON_DEFAULT_CARDS = 4;

/**
 * Clamp a requested rail skeleton count into the 3–5 window. Missing,
 * non-finite, and out-of-range inputs resolve to the default or the
 * nearest bound; fractional inputs round down.
 */
export const clampResultsLoadingCount = (value: number | undefined): number => {
  if (value === undefined || Number.isNaN(value)) {
    return RESULTS_LOADING_SKELETON_DEFAULT_CARDS;
  }

  const floored = Math.floor(value);

  if (!Number.isFinite(floored)) {
    return RESULTS_LOADING_SKELETON_DEFAULT_CARDS;
  }

  if (floored < RESULTS_LOADING_SKELETON_MIN_CARDS) {
    return RESULTS_LOADING_SKELETON_MIN_CARDS;
  }

  if (floored > RESULTS_LOADING_SKELETON_MAX_CARDS) {
    return RESULTS_LOADING_SKELETON_MAX_CARDS;
  }

  return floored;
};

export interface ResultsLoadingSkeletonProps {
  /** Locale-resolved copy (already via `messagesFor(lang)` at the call site). */
  readonly copy: Messages;
  /** Rail placeholder cards to reserve; clamped to 3–5, defaults to 4. */
  readonly dishCount?: number | undefined;
  /**
   * Drawer-first footprint: the compact dish card only, no rail, so the
   * loading state reserves exactly the successful compact result's space.
   */
  readonly compact?: boolean | undefined;
}

/**
 * Visibility for the rail skeleton cards: the first three always show, the
 * fourth joins at `sm`, the fifth at `lg` — matching the loaded rail's
 * `w-36 sm:w-40` card geometry while keeping small screens to three cards.
 */
const railCardVisibility = (index: number): string => {
  if (index < RESULTS_LOADING_SKELETON_MIN_CARDS) {
    return "";
  }

  if (index === RESULTS_LOADING_SKELETON_MIN_CARDS) {
    return " hidden sm:block";
  }

  return " hidden lg:block";
};

/**
 * Single rail thumbnail placeholder. Geometry mirrors the loaded
 * `RecommendationRail` card one-to-one: `w-36 sm:w-40` item, `rounded-2xl
 * border-2` body, fixed `aspect-[4/3]` media block, `p-3` text block with
 * region / title / description bars at stable heights.
 */
function RailSkeletonCard({ visibility }: { readonly visibility: string }): ReactNode {
  return (
    <li className={`w-36 flex-none sm:w-40${visibility}`}>
      <div className="overflow-hidden rounded-2xl border-2 border-border-soft bg-white">
        <div className="aspect-[4/3] w-full animate-pulse bg-border-soft motion-reduce:animate-none" />
        <div className="flex flex-col gap-1.5 p-3">
          <div className="h-2.5 w-1/2 animate-pulse rounded bg-cream motion-reduce:animate-none" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-border-soft motion-reduce:animate-none" />
          <div className="h-3 w-full animate-pulse rounded bg-cream motion-reduce:animate-none" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-cream motion-reduce:animate-none" />
        </div>
      </div>
    </li>
  );
}

/**
 * Full results-loading composition for the recommendation outcome slot.
 * Reserves the loaded layout's footprint so resolving causes no shift:
 *
 * - featured carousel via the shared `DishCarouselSkeleton` (same
 *   responsive proportions as the real card — never a copied layout);
 * - carousel controls row at the real `mt-4` offset with prev/next, dots,
 *   and counter placeholders at button height;
 * - "More recommendations" heading (real text, stable across the swap)
 *   plus 3–5 rail thumbnail placeholders matching real card geometry;
 * - no mode/warning content: nothing renders an AI or deterministic label
 *   before the backend responds. No visible status line: the pulse
 *   skeletons carry the pending state visually, so the generic
 *   `recLoading` copy appears exactly once (sr-only).
 *
 * Accessibility: the composition adds no live region, status, alert, or
 * interactive element of its own. Everything decorative is `aria-hidden`;
 * the single `sr-only` status line reuses `recLoading` so the caller's
 * `aria-live="polite" aria-busy` wrapper (quiz-flow `renderOutcome`)
 * announces loading exactly once. All motion is the shared subtle
 * `animate-pulse` with `motion-reduce:animate-none` — one speed, off under
 * reduced motion. SSR-safe: no browser APIs, no effects, no timers.
 */
export function ResultsLoadingSkeleton({
  compact = false,
  copy,
  dishCount,
}: ResultsLoadingSkeletonProps): ReactNode {
  const count = clampResultsLoadingCount(dishCount);
  const cards = Array.from({ length: count }, (_, index) => index);

  if (compact) {
    return (
      <div>
        <p className="sr-only">{copy.recLoading}</p>
        <DishCarouselCompactSkeleton />
      </div>
    );
  }

  return (
    <div>
      <p className="sr-only">{copy.recLoading}</p>
      <DishCarouselSkeleton />
      <div aria-hidden="true" className="mt-4 flex flex-wrap items-center gap-3">
        <div className="h-11 w-11 animate-pulse rounded-full bg-border-soft motion-reduce:animate-none" />
        <div className="h-11 w-11 animate-pulse rounded-full bg-border-soft motion-reduce:animate-none" />
        <div className="flex items-center gap-1.5">
          <div className="size-3 animate-pulse rounded-full bg-border-soft motion-reduce:animate-none" />
          <div className="size-3 animate-pulse rounded-full bg-border-soft motion-reduce:animate-none" />
          <div className="size-3 animate-pulse rounded-full bg-border-soft motion-reduce:animate-none" />
        </div>
        <div className="h-4 w-24 animate-pulse rounded bg-cream motion-reduce:animate-none" />
      </div>
      <div className="mt-6">
        <h3 className="text-lg font-extrabold text-ink">{copy.recRailHeading}</h3>
        <ul aria-hidden="true" className="mt-3 flex gap-3 overflow-hidden pb-2">
          {cards.map((index) => (
            <RailSkeletonCard key={index} visibility={railCardVisibility(index)} />
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Sidebar explanation footprint for the AI-explanation slot. Mirrors the
 * neutral `AiExplanationCard` geometry (`rounded-2xl border-2 px-4 py-3`,
 * `border-border-soft bg-white`) with pulse bars only — no icon, no title,
 * no AI/deterministic/catalog wording before the backend responds, and no
 * empty bordered box: the bars make the pending state explicit.
 *
 * Lead wiring: render in the left-column explanation slot while
 * `recommend.isPending` (where quiz-flow renders `AiExplanationCard` once
 * the outcome arrives). Silent for assistive tech (`aria-hidden`); the
 * outcome slot's `recLoading` status line is the single announcement.
 */
export function ResultsExplanationSkeleton(): ReactNode {
  return (
    <div aria-hidden="true" className="rounded-2xl border-2 border-border-soft bg-white px-4 py-3">
      <div className="h-4 w-2/5 animate-pulse rounded bg-border-soft motion-reduce:animate-none" />
      <div className="mt-2 h-3.5 w-full animate-pulse rounded bg-cream motion-reduce:animate-none" />
      <div className="mt-1.5 h-3.5 w-4/5 animate-pulse rounded bg-cream motion-reduce:animate-none" />
    </div>
  );
}
