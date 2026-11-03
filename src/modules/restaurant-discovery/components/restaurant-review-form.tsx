import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Star, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";

import {
  restaurantCopy,
  type RestaurantCopy,
} from "@/modules/restaurant-discovery/components/restaurant-copy";
import { CUSTOMER_REVIEW_BODY_MAX as CUSTOMER_REVIEW_BODY_MAX_LENGTH } from "@/modules/restaurant-discovery/restaurant-reviews.constants";
import {
  submitRestaurantCustomerReviewFn,
  updateOwnRestaurantCustomerReviewFn,
} from "@/modules/restaurant-discovery/restaurant-reviews.functions";
import type { SessionState } from "@/modules/user/session.functions";
import { clientFailureSchema } from "@/shared/client-failure";
import type { Locale } from "@/shared/i18n";

export interface CustomerReviewFormErrors {
  readonly rating?: string;
  readonly body?: string;
}

/** Pure client validation mirroring the server schema (rating 1–5, body 1–2000 chars). */
export function validateCustomerReviewForm(
  rating: number | null,
  body: string,
): CustomerReviewFormErrors {
  const ratingError =
    rating === null || !Number.isInteger(rating) || rating < 1 || rating > 5
      ? "Choose a rating from 1 to 5 stars."
      : undefined;

  const trimmed = body.trim();

  let bodyError: string | undefined;

  if (trimmed.length === 0) {
    bodyError = "Review text is required.";
  } else if (trimmed.length > CUSTOMER_REVIEW_BODY_MAX_LENGTH) {
    bodyError = "Review text must be at most 2000 characters.";
  }

  if (ratingError !== undefined && bodyError !== undefined) {
    return { rating: ratingError, body: bodyError };
  }

  if (ratingError !== undefined) {
    return { rating: ratingError };
  }

  if (bodyError !== undefined) {
    return { body: bodyError };
  }

  return {};
}

export interface CustomerReviewEditTarget {
  readonly reviewId: string;
  readonly rating: number;
  readonly body: string;
}

/** Thrown server failures are untrusted transport input; parse the tag at the boundary. */
const failureTag = (error: Error): string | null => {
  const parsed = clientFailureSchema.safeParse(error);

  return parsed.success ? parsed.data._tag : null;
};

const failureMessage = (error: Error, copy: RestaurantCopy): string => {
  const parsed = clientFailureSchema.safeParse(error);

  if (parsed.success && parsed.data.message !== "") {
    return parsed.data.message;
  }

  return copy.reviewsFormSaveFailed;
};

/**
 * Maps server failure tags to traveler-safe UI state. SignInRequired switches
 * the dialog to the sign-in prompt; every other tag keeps the draft and shows
 * the server message inline.
 */
export function reviewFailureKind(tag: string | null): "sign-in" | "message" {
  return tag === "SignInRequired" ? "sign-in" : "message";
}

/**
 * Pending write intent parked across the sign-in redirect. The reviews panel
 * keeps its selection in memory, so a full-page sign-in round-trip would
 * otherwise discard a guest's draft and write intent. The intent is stored
 * under a venue-scoped session key: the panel consumes it on its next
 * signed-in mount and reopens the dialog, while the form restores the draft
 * into write-mode fields and clears the entry on successful submit.
 */
export interface PendingReviewWriteIntent {
  readonly rating: number | null;
  readonly body: string;
}

export const reviewWriteIntentKey = (venueId: string): string => `rv-write-intent:${venueId}`;

const pendingReviewWriteIntentSchema = z.object({
  rating: z.number().int().min(1).max(5).nullable(),
  body: z.string().max(CUSTOMER_REVIEW_BODY_MAX_LENGTH + 1),
});

export const serializeReviewWriteIntent = (intent: PendingReviewWriteIntent): string =>
  JSON.stringify({ rating: intent.rating, body: intent.body });

/** Parses untrusted storage input at the boundary; malformed entries are dropped. */
export const parseReviewWriteIntent = (raw: string | null): PendingReviewWriteIntent | null => {
  if (raw === null) {
    return null;
  }

  let parsed: unknown;

  try {
    // SAFETY: JSON.parse yields any; narrowing to unknown forces every use
    // through the zod safeParse below, so malformed storage never reaches state.
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  const result = pendingReviewWriteIntentSchema.safeParse(parsed);

  return result.success ? result.data : null;
};

export const readReviewWriteIntent = (venueId: string): PendingReviewWriteIntent | null => {
  if (typeof sessionStorage === "undefined") {
    return null;
  }

  try {
    return parseReviewWriteIntent(sessionStorage.getItem(reviewWriteIntentKey(venueId)));
  } catch {
    return null;
  }
};

/** Best-effort: private-mode quota errors never block the sign-in navigation. */
export const writeReviewWriteIntent = (venueId: string, intent: PendingReviewWriteIntent): void => {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  try {
    sessionStorage.setItem(reviewWriteIntentKey(venueId), serializeReviewWriteIntent(intent));
  } catch {
    // Storage stays best-effort so signing in always proceeds.
  }
};

export const clearReviewWriteIntent = (venueId: string): void => {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  try {
    sessionStorage.removeItem(reviewWriteIntentKey(venueId));
  } catch {
    // Storage stays best-effort so the dialog always opens.
  }
};

/**
 * Accessible star-rating dialog for creating or editing one customer review.
 * Simple stars plus concise text with a friendly moderation helper; a saved
 * review shows the pending-moderation state with Done because new and edited
 * reviews always re-enter the moderation queue.
 */
export function RestaurantReviewFormDialog({
  open,
  onOpenChange,
  venueId,
  session,
  initial,
  locale,
  onSubmitted,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly venueId: string;
  readonly session: SessionState;
  readonly initial: CustomerReviewEditTarget | null;
  readonly locale: Locale;
  readonly onSubmitted: () => void;
}) {
  const queryClient = useQueryClient();
  const openerRef = useRef<Element | null>(null);
  const copy: RestaurantCopy = restaurantCopy(locale);

  const [rating, setRating] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [touched, setTouched] = useState(false);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  const [succeeded, setSucceeded] = useState(false);

  // The dialog stays mounted while the panel swaps write/edit targets, but
  // state seeds only once. Each new target syncs here with the render-adjust
  // pattern (an effect would trip react/set-state-in-effect): opening Edit
  // after Write shows the stored review, opening Write shows this venue's
  // parked draft or empty fields. Typing never retriggers this because keys
  // only change when the target or venue changes.
  const writeKey = `${venueId}:${initial?.reviewId ?? "new"}`;
  const [syncedWriteKey, setSyncedWriteKey] = useState("");

  if (syncedWriteKey !== writeKey) {
    setSyncedWriteKey(writeKey);

    if (initial !== null) {
      setRating(initial.rating);
      setBody(initial.body);
    } else {
      const stored = readReviewWriteIntent(venueId);
      setRating(stored?.rating ?? null);
      setBody(stored?.body ?? "");
    }

    setTouched(false);
    setServerMessage(null);
  }

  // Radix does not reliably restore focus from a controlled dialog opened by
  // a list action (same pattern as the restaurant filters sheet), so the
  // opener is remembered while the dialog is up and restored on close.
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    openerRef.current = document.activeElement;

    return () => {
      const opener = openerRef.current;

      openerRef.current = null;

      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [open]);

  const editing = initial !== null;
  const signedIn = session.status === "signed-in";

  const mutation = useMutation({
    mutationFn: async (input: { rating: number; body: string }): Promise<void> => {
      if (initial !== null) {
        await updateOwnRestaurantCustomerReviewFn({
          data: { reviewId: initial.reviewId, rating: input.rating, body: input.body },
        });

        return;
      }

      await submitRestaurantCustomerReviewFn({
        data: { venueId, rating: input.rating, body: input.body },
      });
    },
    onSuccess: () => {
      setServerMessage(null);
      setShowSignIn(false);
      setSucceeded(true);
      clearReviewWriteIntent(venueId);
      onSubmitted();
      void queryClient.invalidateQueries({ queryKey: ["customer-reviews", venueId] });
    },
    onError: (error) => {
      const tag = failureTag(error);

      if (reviewFailureKind(tag) === "sign-in") {
        setShowSignIn(true);
        setServerMessage(null);

        return;
      }

      setServerMessage(failureMessage(error, copy));
    },
  });

  const close = (next: boolean): void => {
    if (mutation.isPending) {
      return;
    }

    if (!next) {
      setTouched(false);
      setServerMessage(null);
      setShowSignIn(false);
      setSucceeded(false);
    }

    onOpenChange(next);
  };

  const submit = (): void => {
    setTouched(true);
    setServerMessage(null);

    const errors = validateCustomerReviewForm(rating, body);

    if (errors.rating !== undefined || errors.body !== undefined || rating === null) {
      return;
    }

    mutation.mutate({ rating, body: body.trim() });
  };

  const errors = touched ? validateCustomerReviewForm(rating, body) : {};
  const title = editing ? copy.reviewsFormEditTitle : copy.reviewsFormWriteTitle;
  // Relative venue path only: the sign-in route's safeReturnTo allowlist
  // rejects absolute and protocol-relative destinations, so this can only
  // ever land back on this site. The lang query preserves the locale across
  // the full-page sign-in round-trip; the draft and write intent travel via
  // session storage (see PendingReviewWriteIntent).
  const returnTo = `/restaurants/${venueId}?lang=${locale}`;

  let submitLabel = editing ? copy.reviewsFormSave : copy.reviewsFormSubmit;

  if (mutation.isPending) {
    submitLabel = copy.reviewsFormSaving;
  }

  let dialogBody: ReactNode;

  if (succeeded) {
    dialogBody = (
      <output className="reviews-notice">
        <p>{editing ? copy.reviewsEdited : copy.reviewsSubmitted}</p>
        <p>{copy.reviewsFormHelper}</p>
        <div className="reviews-dialog-foot">
          <button type="button" className="reviews-primary" onClick={() => close(false)}>
            {copy.reviewsFormDone}
          </button>
        </div>
      </output>
    );
  } else if (!signedIn || showSignIn) {
    const signInHint =
      session.status === "unavailable" ? copy.reviewsSignInPaused : copy.reviewsFormSignInHint;

    const offerSignIn = session.status === "signed-out" || showSignIn;

    dialogBody = (
      <div className="reviews-signin">
        <p>{signInHint}</p>
        {offerSignIn ? (
          <Link
            to="/sign-in"
            search={{ lang: locale, returnTo }}
            className="reviews-primary"
            onClick={() => {
              writeReviewWriteIntent(venueId, { rating, body });
            }}
          >
            {copy.reviewsSignInContinue}
          </Link>
        ) : null}
      </div>
    );
  } else {
    dialogBody = (
      <>
        <p className="reviews-helper">{copy.reviewsFormHelper}</p>
        <fieldset className="reviews-field">
          <legend>{copy.reviewsFormRating}</legend>
          <div className="reviews-rating" role="radiogroup" aria-label={copy.reviewsFormRating}>
            {[1, 2, 3, 4, 5].map((star) => (
              <label key={star} data-checked={rating !== null && star <= rating}>
                <input
                  type="radio"
                  name="customer-review-rating"
                  value={star}
                  checked={rating === star}
                  disabled={mutation.isPending}
                  aria-label={`${star} ${star === 1 ? "star" : "stars"}`}
                  onChange={() => {
                    setRating(star);
                  }}
                />
                <Star
                  aria-hidden="true"
                  fill={rating !== null && star <= rating ? "currentColor" : "none"}
                />
              </label>
            ))}
          </div>
          {errors.rating !== undefined ? (
            <p role="alert" className="reviews-field-error">
              {errors.rating}
            </p>
          ) : null}
        </fieldset>

        <div className="reviews-field">
          <label htmlFor="customer-review-body">{copy.reviewsFormBody}</label>
          <textarea
            id="customer-review-body"
            value={body}
            maxLength={CUSTOMER_REVIEW_BODY_MAX_LENGTH + 1}
            disabled={mutation.isPending}
            aria-invalid={errors.body !== undefined}
            aria-describedby="customer-review-count"
            placeholder={copy.reviewsFormPlaceholder}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
          <p id="customer-review-count" className="reviews-char-count" aria-live="polite">
            {copy.reviewsFormCharCount
              .replace("{count}", String(body.trim().length))
              .replace("{max}", String(CUSTOMER_REVIEW_BODY_MAX_LENGTH))}
          </p>
          {errors.body !== undefined ? (
            <p role="alert" className="reviews-field-error">
              {errors.body}
            </p>
          ) : null}
        </div>

        {serverMessage !== null ? (
          <p role="alert" className="reviews-error">
            {serverMessage}
          </p>
        ) : null}

        <div className="reviews-dialog-foot">
          <button
            type="button"
            className="reviews-ghost"
            disabled={mutation.isPending}
            onClick={() => close(false)}
          >
            {copy.reviewsFormCancel}
          </button>
          <button
            type="button"
            className="reviews-primary"
            disabled={mutation.isPending}
            aria-busy={mutation.isPending}
            onClick={submit}
          >
            {submitLabel}
          </button>
        </div>
      </>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={close} modal>
      <Dialog.Portal>
        <Dialog.Overlay className="reviews-dialog-overlay" />
        <Dialog.Content
          className="reviews-dialog"
          aria-describedby={undefined}
          // Custom opener restore (effect above) owns focus return: Radix
          // would otherwise restore to whatever it tracked, not the opener.
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div className="reviews-dialog-head">
            <Dialog.Title className="reviews-dialog-title">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={`Close ${title}`}
                className="reviews-icon-btn"
                disabled={mutation.isPending}
              >
                <X aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>

          {dialogBody}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
