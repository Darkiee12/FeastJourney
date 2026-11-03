import { Match } from "effect";
import { CalendarDays, ChevronDown, Languages, PenLine, Star, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { z } from "zod";

import {
  restaurantCopy,
  type RestaurantCopy,
} from "@/modules/restaurant-discovery/components/restaurant-copy";
import type { CustomerReviewPublic } from "@/modules/restaurant-discovery/restaurant-reviews.schema";
import { translateReviewFn } from "@/server/review-intelligence/review-intelligence.functions";

/**
 * Client shape of one published customer review. This is the public DTO:
 * the published-only server projection with no author identity, venue
 * redundancy, or moderation internals. Authorship is never derived here;
 * callers pass `isAuthor` from the own-review query. Sorting is server-side;
 * this component renders items in the order received.
 */
export type RestaurantCustomerReview = CustomerReviewPublic;

/** Locale-aware review date; never throws on malformed input. */
export function formatReviewDate(value: string, locale: string): string {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value.slice(0, 10);
  }

  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parsed);
}

/** Bodies longer than this collapse behind a Show more toggle. */
const REVIEW_TRUNCATE_AT = 280;

function truncateBody(body: string): string {
  if (body.length <= REVIEW_TRUNCATE_AT) {
    return body;
  }

  const cut = body.lastIndexOf(" ", REVIEW_TRUNCATE_AT);

  return cut > 0 ? body.slice(0, cut) : body.slice(0, REVIEW_TRUNCATE_AT);
}

/**
 * Tolerant client boundary over the peer outcome, mirroring the research
 * panel's peer-typed validation: the server already validates, this guards
 * transport drift. Failures keep the original text.
 */
const translateOutcomeSchema = z.discriminatedUnion("_tag", [
  z.object({
    _tag: z.literal("Done"),
    translation: z.string().min(1),
    sourceLang: z.string().optional(),
  }),
  z.object({ _tag: z.literal("Failed") }),
]);

type TranslateOutcome = z.infer<typeof translateOutcomeSchema>;

function translateResultText(result: TranslateOutcome): string | null {
  return Match.value(result).pipe(
    Match.tag("Done", (done): string | null => done.translation),
    Match.tag("Failed", (): string | null => null),
    Match.exhaustive,
  );
}

type TranslateState =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "shown"; readonly text: string }
  | { readonly kind: "failed" };

/**
 * One published review. Identity is always the neutral "Fellow traveler"
 * label (plus "Your review" for the author); raw ids and emails never render.
 * Owner-only Edit/Delete ride `isAuthor`; the Languages toggle translates
 * through the peer `translateReviewFn` contract, and a failure keeps the
 * original text with a compact note. Long bodies collapse behind a
 * ChevronDown toggle. Callers may inject `translationSlot` to replace the
 * built-in translate control.
 */
export function RestaurantReviewCard({
  review,
  locale,
  isAuthor,
  actionPending,
  onEdit,
  onDelete,
  translationSlot,
}: {
  readonly review: RestaurantCustomerReview;
  readonly locale: string;
  readonly isAuthor: boolean;
  readonly actionPending: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly translationSlot?: ReactNode | undefined;
}) {
  const copy: RestaurantCopy = restaurantCopy(locale);
  const shownDate = review.published_at ?? review.created_at;
  const long = review.body.length > REVIEW_TRUNCATE_AT;

  const [expanded, setExpanded] = useState(false);
  const [translate, setTranslate] = useState<TranslateState>({ kind: "idle" });

  const toggleTranslation = (): void => {
    if (translate.kind === "shown") {
      setTranslate({ kind: "idle" });

      return;
    }

    if (translate.kind === "busy") {
      return;
    }

    setTranslate({ kind: "busy" });

    void translateReviewFn({
      data: { reviewId: review.id, target: locale === "vi" ? "vi" : "en" },
    })
      .then((result) => {
        const parsed = translateOutcomeSchema.safeParse(result);
        const text = parsed.success ? translateResultText(parsed.data) : null;

        setTranslate(text === null ? { kind: "failed" } : { kind: "shown", text });
      })
      .catch(() => {
        setTranslate({ kind: "failed" });
      });
  };

  const body = translate.kind === "shown" ? translate.text : review.body;
  const visible = !long || expanded || translate.kind === "shown" ? body : truncateBody(body);

  let translateControl: ReactNode;

  if (translationSlot !== undefined) {
    translateControl = translationSlot;
  } else {
    translateControl = (
      <button
        type="button"
        className="reviews-ghost"
        aria-pressed={translate.kind === "shown"}
        aria-busy={translate.kind === "busy"}
        disabled={translate.kind === "busy"}
        onClick={toggleTranslation}
      >
        <Languages aria-hidden="true" />
        {translate.kind === "shown" ? copy.reviewsShowOriginal : copy.reviewsTranslate}
      </button>
    );
  }

  return (
    <article
      id={`review-${review.id}`}
      className="reviews-card"
      aria-label={`Review rated ${review.rating} out of 5`}
    >
      <div className="reviews-card-head">
        <span className="reviews-stars reviews-stars-small" aria-hidden="true">
          {[1, 2, 3, 4, 5].map((star) => (
            <Star
              key={star}
              aria-hidden="true"
              className="reviews-star"
              data-filled={star <= review.rating}
              fill={star <= review.rating ? "currentColor" : "none"}
            />
          ))}
        </span>
        <span className="sr-only">Rated {review.rating} out of 5 stars</span>
        <p className="reviews-card-meta">
          <span>
            {copy.reviewsAuthorLabel}
            {isAuthor ? ` · ${copy.reviewsYourReview}` : ""}
          </span>
          <span className="reviews-card-date">
            <CalendarDays aria-hidden="true" />
            <time dateTime={shownDate}>{formatReviewDate(shownDate, locale)}</time>
          </span>
        </p>
      </div>
      <p className="reviews-card-body">{visible}</p>
      {translate.kind === "failed" ? (
        <p role="alert" className="reviews-card-note">
          {copy.reviewsTranslationFailed}
        </p>
      ) : null}
      <div className="reviews-card-actions">
        {translateControl}
        {long && translate.kind !== "shown" ? (
          <button
            type="button"
            className="reviews-ghost"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((previous) => !previous);
            }}
          >
            <ChevronDown aria-hidden="true" data-open={expanded} className="reviews-chevron" />
            {expanded ? copy.reviewsShowLess : copy.reviewsShowMore}
          </button>
        ) : null}
        {isAuthor ? (
          <>
            <button
              type="button"
              className="reviews-ghost"
              disabled={actionPending}
              aria-busy={actionPending}
              onClick={onEdit}
            >
              <PenLine aria-hidden="true" />
              {copy.reviewsEditAction}
            </button>
            <button
              type="button"
              className="reviews-ghost reviews-danger"
              disabled={actionPending}
              aria-busy={actionPending}
              onClick={onDelete}
            >
              <Trash2 aria-hidden="true" />
              {actionPending ? copy.reviewsDeleteBusy : copy.reviewsDeleteAction}
            </button>
          </>
        ) : null}
      </div>
    </article>
  );
}
