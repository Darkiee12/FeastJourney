import { Star } from "lucide-react";
import type { ReactNode } from "react";

import {
  restaurantCopy,
  type RestaurantCopy,
} from "@/modules/restaurant-discovery/components/restaurant-copy";

export interface RestaurantReviewDistributionEntry {
  readonly stars: number;
  readonly count: number;
}

export interface RestaurantReviewSummaryData {
  readonly venueId: string;
  readonly total: number;
  readonly average: number;
  readonly distribution: ReadonlyArray<RestaurantReviewDistributionEntry>;
}

/** Share of one star row against the published total. Zero-total never divides. */
export function distributionPercent(count: number, total: number): number {
  if (total <= 0 || count <= 0) {
    return 0;
  }

  return Math.min(100, (count / total) * 100);
}

/** One-decimal locale-aware average. Only called when total > 0, so 0.0 never renders. */
export function formatReviewAverage(average: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(average);
}

/** Toggle helper for the server-backed rating filter: re-clicking clears. */
export function toggleRatingFilter(current: number | null, stars: number): number | null {
  return current === stars ? null : stars;
}

/** Decorative stars; every use pairs them with an adjacent sr-only text label. */
function reviewStars(rating: number): ReactNode {
  const filled = Math.round(rating);

  return (
    <span className="reviews-stars" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          aria-hidden="true"
          className="reviews-star"
          data-filled={star <= filled}
          fill={star <= filled ? "currentColor" : "none"}
        />
      ))}
    </span>
  );
}

/**
 * Published-only aggregate header. The server counts published rows only;
 * pending reviews never move this number. Empty stays an invitation, never 0.0.
 * Each distribution row is a toggle button driving the panel's rating filter;
 * the active row carries `aria-pressed` and the panel shows a clearable chip.
 */
export function RestaurantReviewSummary({
  summary,
  isPending,
  locale,
  activeRating = null,
  onSelectRating,
}: {
  readonly summary: RestaurantReviewSummaryData | null;
  readonly isPending: boolean;
  readonly locale: string;
  readonly activeRating?: number | null | undefined;
  readonly onSelectRating?: ((stars: number | null) => void) | undefined;
}) {
  const copy: RestaurantCopy = restaurantCopy(locale);

  if (isPending) {
    return (
      <div className="reviews-summary" aria-busy="true" aria-label="Loading review summary">
        <div aria-hidden="true" className="reviews-skeleton reviews-skeleton-average" />
        <div aria-hidden="true" className="reviews-skeleton reviews-skeleton-bar" />
        <div aria-hidden="true" className="reviews-skeleton reviews-skeleton-bar" />
      </div>
    );
  }

  if (summary === null || summary.total === 0) {
    return (
      <output className="reviews-summary">
        <h3>{copy.reviewsSummaryTitle}</h3>
        <p>{copy.reviewsEmpty}</p>
      </output>
    );
  }

  const counts: ReadonlyMap<number, number> = new Map(
    summary.distribution.map((entry) => [entry.stars, entry.count] as const),
  );

  const canFilter = onSelectRating !== undefined;

  return (
    <div className="reviews-summary">
      <h3>{copy.reviewsSummaryTitle}</h3>
      <p className="reviews-average-row">
        <strong className="reviews-average">{formatReviewAverage(summary.average, locale)}</strong>
        {reviewStars(summary.average)}
        <span className="sr-only">
          {formatReviewAverage(summary.average, locale)} out of 5 stars
        </span>
      </p>
      <p className="reviews-count">
        {summary.total === 1
          ? copy.reviewsBasedOnOne
          : copy.reviewsBasedOn.replace("{total}", String(summary.total))}
      </p>
      <ol className="reviews-bars">
        {[5, 4, 3, 2, 1].map((stars) => {
          const count = counts.get(stars) ?? 0;
          const active = activeRating === stars;

          const row = (
            <>
              <span className="reviews-bar-label">
                {stars} {stars === 1 ? "star" : "stars"}
              </span>
              <span className="reviews-bar-track" aria-hidden="true">
                <span
                  className="reviews-bar-fill"
                  style={{ width: `${distributionPercent(count, summary.total)}%` }}
                />
              </span>
              <span className="reviews-bar-count">
                {count}
                <span className="sr-only">
                  {" "}
                  of {summary.total} reviews gave {stars} stars
                </span>
              </span>
            </>
          );

          if (!canFilter) {
            return (
              <li key={stars} className="reviews-bar-row">
                {row}
              </li>
            );
          }

          return (
            <li key={stars} className="reviews-bar-row" data-active={active}>
              <button
                type="button"
                className="reviews-bar-button"
                aria-pressed={active}
                aria-label={copy.reviewsFilterShowing.replace("{stars}", String(stars))}
                onClick={() => {
                  onSelectRating(toggleRatingFilter(activeRating ?? null, stars));
                }}
              >
                {row}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
