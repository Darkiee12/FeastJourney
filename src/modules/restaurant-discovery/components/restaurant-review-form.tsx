import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Star, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  submitRestaurantCustomerReviewFn,
  updateOwnRestaurantCustomerReviewFn,
} from "@/modules/restaurant-discovery/restaurant-reviews.functions";
import type { SessionState } from "@/modules/user/session.functions";
import { clientFailureSchema } from "@/shared/client-failure";
import type { Locale } from "@/shared/i18n";

export const CUSTOMER_REVIEW_BODY_MAX_LENGTH = 2000;

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

const failureMessage = (error: Error): string => {
  const parsed = clientFailureSchema.safeParse(error);

  if (parsed.success && parsed.data.message !== "") {
    return parsed.data.message;
  }

  return "Could not save your review. Please retry.";
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
 * Accessible star-rating dialog for creating or editing one customer review.
 * Drafts survive server errors; a saved review shows the pending-moderation
 * state because new and edited reviews always re-enter the moderation queue.
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
  const [rating, setRating] = useState<number | null>(initial?.rating ?? null);
  const [body, setBody] = useState(initial?.body ?? "");
  const [touched, setTouched] = useState(false);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  const [succeeded, setSucceeded] = useState(false);

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

      setServerMessage(failureMessage(error));
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
  const title = editing ? "Edit your review" : "Write a review";
  const returnTo = `/restaurants/${venueId}`;

  let submitLabel = "Submit review";

  if (editing) {
    submitLabel = "Save changes";
  }

  if (mutation.isPending) {
    submitLabel = "Saving…";
  }

  let dialogBody: ReactNode;

  if (succeeded) {
    dialogBody = (
      <output className="rv-notice">
        <p>Thanks — your review was received and is awaiting moderation.</p>
        <p>It will appear here once published; the shown average only counts published reviews.</p>
        <div className="rv-dialog-foot">
          <button type="button" className="rv-primary" onClick={() => close(false)}>
            Done
          </button>
        </div>
      </output>
    );
  } else if (!signedIn || showSignIn) {
    const signInHint =
      session.status === "unavailable"
        ? "Sign-in status is unavailable right now, so reviews are paused. Discovery still works — try again shortly."
        : "Sign in to write a review. Your place in this restaurant is kept.";

    const offerSignIn = session.status === "signed-out" || showSignIn;

    dialogBody = (
      <div className="rv-signin">
        <p>{signInHint}</p>
        {offerSignIn ? (
          <Link to="/sign-in" search={{ lang: locale, returnTo }} className="rv-primary">
            Sign in to continue
          </Link>
        ) : null}
      </div>
    );
  } else {
    dialogBody = (
      <>
        <fieldset className="rv-field">
          <legend>Your rating</legend>
          <div className="rv-rating" role="radiogroup" aria-label="Your rating">
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
            <p role="alert" className="rv-field-error">
              {errors.rating}
            </p>
          ) : null}
        </fieldset>

        <div className="rv-field">
          <label htmlFor="customer-review-body">Your review</label>
          <textarea
            id="customer-review-body"
            value={body}
            maxLength={CUSTOMER_REVIEW_BODY_MAX_LENGTH + 1}
            disabled={mutation.isPending}
            aria-invalid={errors.body !== undefined}
            aria-describedby="customer-review-count"
            placeholder="What did you enjoy? What should others know?"
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
          <p id="customer-review-count" className="rv-char-count" aria-live="polite">
            {body.trim().length} / {CUSTOMER_REVIEW_BODY_MAX_LENGTH} characters
          </p>
          {errors.body !== undefined ? (
            <p role="alert" className="rv-field-error">
              {errors.body}
            </p>
          ) : null}
        </div>

        {serverMessage !== null ? (
          <p role="alert" className="rv-error">
            {serverMessage}
          </p>
        ) : null}

        <div className="rv-dialog-foot">
          <button
            type="button"
            className="rv-ghost"
            disabled={mutation.isPending}
            onClick={() => close(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rv-primary"
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
        <Dialog.Overlay className="rv-dialog-overlay" />
        <Dialog.Content className="rv-dialog" aria-describedby={undefined}>
          <div className="rv-dialog-head">
            <Dialog.Title className="rv-dialog-title">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={`Close ${title}`}
                className="rv-icon-btn"
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
