import { Star } from "lucide-react";
import type { ReactNode } from "react";

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

/** Decorative stars; every use pairs them with an adjacent sr-only text label. */
function reviewStars(rating: number): ReactNode {
  const filled = Math.round(rating);

  return (
    <span className="rv-stars" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          aria-hidden="true"
          className="rv-star"
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
 */
export function RestaurantReviewSummary({
  summary,
  isPending,
  locale,
}: {
  readonly summary: RestaurantReviewSummaryData | null;
  readonly isPending: boolean;
  readonly locale: string;
}) {
  if (isPending) {
    return (
      <div className="rv-summary" aria-busy="true" aria-label="Loading review summary">
        <div aria-hidden="true" className="rv-skeleton rv-skeleton-average" />
        <div aria-hidden="true" className="rv-skeleton rv-skeleton-bar" />
        <div aria-hidden="true" className="rv-skeleton rv-skeleton-bar" />
        <div aria-hidden="true" className="rv-skeleton rv-skeleton-bar" />
      </div>
    );
  }

  if (summary === null || summary.total === 0) {
    return (
      <output className="rv-summary">
        <h3>Guest reviews</h3>
        <p>No reviews yet. Be the first to share your experience.</p>
      </output>
    );
  }

  const counts: ReadonlyMap<number, number> = new Map(
    summary.distribution.map((entry) => [entry.stars, entry.count] as const),
  );

  return (
    <div className="rv-summary">
      <h3>Guest reviews</h3>
      <p className="rv-average-row">
        <strong className="rv-average">{formatReviewAverage(summary.average, locale)}</strong>
        {reviewStars(summary.average)}
        <span className="sr-only">
          {formatReviewAverage(summary.average, locale)} out of 5 stars
        </span>
      </p>
      <p className="rv-count">
        Based on {summary.total} {summary.total === 1 ? "published review" : "published reviews"}
      </p>
      <ol className="rv-bars">
        {[5, 4, 3, 2, 1].map((stars) => {
          const count = counts.get(stars) ?? 0;

          return (
            <li key={stars} className="rv-bar-row">
              <span className="rv-bar-label">
                {stars} {stars === 1 ? "star" : "stars"}
              </span>
              <span className="rv-bar-track" aria-hidden="true">
                <span
                  className="rv-bar-fill"
                  style={{ width: `${distributionPercent(count, summary.total)}%` }}
                />
              </span>
              <span className="rv-bar-count">
                {count}
                <span className="sr-only">
                  {" "}
                  of {summary.total} reviews gave {stars} stars
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
