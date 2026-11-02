import { PenLine, Star, Trash2 } from "lucide-react";

/**
 * Client shape of one published customer review. Field names follow the
 * server SQL projection (snake_case); no mirror mapping is applied.
 * `authorId` is compared for ownership only and never rendered.
 */
export interface RestaurantCustomerReview {
  readonly id: string;
  readonly venue_id: string;
  readonly author_id: string;
  readonly rating: number;
  readonly body: string;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly published_at: string | null;
}

export type ReviewSortMode = "recent" | "highest" | "lowest";

/**
 * Client-side sort over one fetched page. "recent" keeps server order
 * (published first); rating sorts break ties by newest first for stability.
 */
export function sortCustomerReviews(
  reviews: ReadonlyArray<RestaurantCustomerReview>,
  mode: ReviewSortMode,
): ReadonlyArray<RestaurantCustomerReview> {
  if (mode === "recent") {
    return [...reviews];
  }

  const ranked = [...reviews];

  ranked.sort((left, right) => {
    if (left.rating !== right.rating) {
      return mode === "highest" ? right.rating - left.rating : left.rating - right.rating;
    }

    const leftDate = left.published_at ?? left.created_at;
    const rightDate = right.published_at ?? right.created_at;

    if (leftDate === rightDate) {
      return 0;
    }

    return leftDate < rightDate ? 1 : -1;
  });

  return ranked;
}

/** Locale-aware review date; never throws on malformed input. */
export function formatReviewDate(value: string, locale: string): string {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value.slice(0, 10);
  }

  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parsed);
}

/**
 * One published review. Identity is always the neutral "Fellow traveler"
 * label (plus "Your review" for the author); raw ids and emails never render.
 */
export function RestaurantReviewCard({
  review,
  locale,
  isAuthor,
  actionPending,
  onEdit,
  onDelete,
}: {
  readonly review: RestaurantCustomerReview;
  readonly locale: string;
  readonly isAuthor: boolean;
  readonly actionPending: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const shownDate = review.published_at ?? review.created_at;

  return (
    <article className="rv-card" aria-label={`Review rated ${review.rating} out of 5`}>
      <div className="rv-card-head">
        <span className="rv-stars rv-stars-small" aria-hidden="true">
          {[1, 2, 3, 4, 5].map((star) => (
            <Star
              key={star}
              aria-hidden="true"
              className="rv-star"
              data-filled={star <= review.rating}
              fill={star <= review.rating ? "currentColor" : "none"}
            />
          ))}
        </span>
        <span className="sr-only">Rated {review.rating} out of 5 stars</span>
        <p className="rv-card-meta">
          <span>Fellow traveler{isAuthor ? " · Your review" : ""}</span>
          <time dateTime={shownDate}>{formatReviewDate(shownDate, locale)}</time>
        </p>
      </div>
      <p className="rv-card-body">{review.body}</p>
      {isAuthor ? (
        <div className="rv-card-actions">
          <button
            type="button"
            className="rv-ghost"
            disabled={actionPending}
            aria-busy={actionPending}
            onClick={onEdit}
          >
            <PenLine aria-hidden="true" />
            Edit
          </button>
          <button
            type="button"
            className="rv-ghost rv-danger"
            disabled={actionPending}
            aria-busy={actionPending}
            onClick={onDelete}
          >
            <Trash2 aria-hidden="true" />
            Delete
          </button>
        </div>
      ) : null}
    </article>
  );
}
