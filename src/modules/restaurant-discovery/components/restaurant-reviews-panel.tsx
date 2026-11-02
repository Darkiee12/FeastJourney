import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, PenLine } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  RestaurantReviewCard,
  sortCustomerReviews,
  type RestaurantCustomerReview,
  type ReviewSortMode,
} from "@/modules/restaurant-discovery/components/restaurant-review-card";
import {
  RestaurantReviewFormDialog,
  type CustomerReviewEditTarget,
} from "@/modules/restaurant-discovery/components/restaurant-review-form";
import { RestaurantReviewSummary } from "@/modules/restaurant-discovery/components/restaurant-review-summary";
import {
  deleteOwnRestaurantCustomerReviewFn,
  getRestaurantReviewSummaryFn,
  listRestaurantCustomerReviewsFn,
} from "@/modules/restaurant-discovery/restaurant-reviews.functions";
import type { SessionState } from "@/modules/user/session.functions";
import { clientFailureSchema } from "@/shared/client-failure";
import type { Locale } from "@/shared/i18n";

export const CUSTOMER_REVIEW_PAGE_SIZE = 10;

const sortOptions: ReadonlyArray<{ readonly value: ReviewSortMode; readonly label: string }> = [
  { value: "recent", label: "Most recent" },
  { value: "highest", label: "Highest rated" },
  { value: "lowest", label: "Lowest rated" },
];

/** Thrown server failures are untrusted transport input; parse the message at the boundary. */
const failureText = (error: Error): string => {
  const parsed = clientFailureSchema.safeParse(error);

  if (parsed.success && parsed.data.message !== "") {
    return parsed.data.message;
  }

  return "Reviews are temporarily unavailable. Please retry.";
};

/**
 * Self-fetching traveler reviews panel for one venue. Query keys always start
 * with ["customer-reviews", venueId], so switching venues never shows stale
 * rows and the page can invalidate the whole prefix on moderation events.
 * Own writes invalidate the same prefix after submit, edit, or delete.
 */
export function RestaurantReviewsPanel({
  venueId,
  session,
  locale,
  onBackToOverview,
}: {
  readonly venueId: string;
  readonly session: SessionState;
  readonly locale: Locale;
  readonly onBackToOverview: () => void;
}) {
  const queryClient = useQueryClient();
  const [sort, setSort] = useState<ReviewSortMode>("recent");
  const [formOpen, setFormOpen] = useState(false);

  const [editTarget, setEditTarget] = useState<
    (CustomerReviewEditTarget & { readonly venueId: string }) | null
  >(null);

  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const currentUserId = session.status === "signed-in" ? session.user.id : null;

  const summary = useQuery({
    queryKey: ["customer-reviews", venueId, "summary"],
    queryFn: () => getRestaurantReviewSummaryFn({ data: { venueId } }),
    retry: false,
  });

  const list = useInfiniteQuery({
    queryKey: ["customer-reviews", venueId, "list"],
    queryFn: ({ pageParam }) =>
      listRestaurantCustomerReviewsFn({
        data: { venueId, limit: CUSTOMER_REVIEW_PAGE_SIZE, offset: pageParam },
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const consumed = lastPage.offset + lastPage.items.length;

      if (consumed >= lastPage.total) {
        return undefined;
      }

      return lastPage.offset + lastPage.limit;
    },
    retry: false,
  });

  const deletion = useMutation({
    mutationFn: (reviewId: string) => deleteOwnRestaurantCustomerReviewFn({ data: { reviewId } }),
    onMutate: (reviewId) => {
      setDeletingId(reviewId);
      setFailure(null);
    },
    onSuccess: () => {
      setDeletingId(null);
      setNotice("Your review was removed.");
      void queryClient.invalidateQueries({ queryKey: ["customer-reviews", venueId] });
    },
    onError: (error) => {
      setDeletingId(null);
      setFailure(failureText(error));
    },
  });

  const fetched: ReadonlyArray<RestaurantCustomerReview> = useMemo(
    () => list.data?.pages.flatMap((page) => page.items) ?? [],
    [list.data],
  );

  const visible = useMemo(() => sortCustomerReviews(fetched, sort), [fetched, sort]);

  const total = list.data?.pages[0]?.total ?? 0;

  const openWrite = (): void => {
    setEditTarget(null);
    setFormOpen(true);
  };

  const openEdit = (review: RestaurantCustomerReview): void => {
    setEditTarget({
      venueId,
      reviewId: review.id,
      rating: review.rating,
      body: review.body,
    });
    setFormOpen(true);
  };

  let listBody: ReactNode;

  if (list.isPending) {
    listBody = (
      <div aria-busy="true" aria-label="Loading reviews" className="rv-section">
        <div aria-hidden="true" className="rv-skeleton rv-skeleton-card" />
        <div aria-hidden="true" className="rv-skeleton rv-skeleton-card" />
      </div>
    );
  } else if (list.isError) {
    listBody = (
      <p role="alert" className="rv-error">
        {failureText(list.error)}
      </p>
    );
  } else if (visible.length === 0) {
    listBody = (
      <output className="rv-empty">
        <p>No reviews match yet. Be the first to share your experience.</p>
        <button type="button" className="rv-primary" onClick={openWrite}>
          <PenLine aria-hidden="true" />
          Write a review
        </button>
      </output>
    );
  } else {
    const remaining = total - visible.length;

    listBody = (
      <>
        <ol className="rv-list">
          {visible.map((review) => (
            <li key={review.id}>
              <RestaurantReviewCard
                review={review}
                locale={locale}
                isAuthor={currentUserId !== null && review.author_id === currentUserId}
                actionPending={deletingId === review.id || deletion.isPending}
                onEdit={() => openEdit(review)}
                onDelete={() => deletion.mutate(review.id)}
              />
            </li>
          ))}
        </ol>
        {list.hasNextPage ? (
          <button
            type="button"
            className="rv-ghost rv-load-more"
            disabled={list.isFetchingNextPage}
            aria-busy={list.isFetchingNextPage}
            onClick={() => {
              void list.fetchNextPage();
            }}
          >
            {list.isFetchingNextPage ? "Loading…" : `Load more (${remaining} left)`}
          </button>
        ) : null}
      </>
    );
  }

  let writeBody: ReactNode;

  if (session.status === "signed-in") {
    writeBody = (
      <button type="button" className="rv-primary" onClick={openWrite}>
        <PenLine aria-hidden="true" />
        Write a review
      </button>
    );
  } else {
    const paused =
      session.status === "unavailable"
        ? "Sign-in status is unavailable right now, so reviews are paused. Discovery still works — try again shortly."
        : "Sign in to share your experience at this restaurant.";

    writeBody = (
      <div className="rv-signin">
        <p>{paused}</p>
        {session.status === "signed-out" ? (
          <Link
            to="/sign-in"
            search={{ lang: locale, returnTo: `/restaurants/${venueId}` }}
            className="rv-primary"
          >
            Sign in to continue
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rv-panel">
      <div className="rv-head">
        <button type="button" className="rv-back" onClick={onBackToOverview}>
          <ArrowLeft aria-hidden="true" />
          Back to overview
        </button>
        <h2>Reviews</h2>
      </div>

      <section aria-label="Review summary">
        <RestaurantReviewSummary
          summary={
            summary.data === undefined
              ? null
              : {
                  venueId: summary.data.venueId,
                  total: summary.data.total,
                  average: summary.data.average,
                  distribution: summary.data.distribution,
                }
          }
          isPending={summary.isPending}
          locale={locale}
        />
        {summary.isError ? (
          <p role="alert" className="rv-error">
            {failureText(summary.error)}
          </p>
        ) : null}
      </section>

      <section aria-label="Customer reviews" className="rv-section">
        <div className="rv-toolbar">
          <h3>What travelers say</h3>
          <label htmlFor="customer-review-sort">Sort</label>
          <select
            id="customer-review-sort"
            value={sort}
            onChange={(event) => {
              const next = event.target.value;

              if (next === "highest" || next === "lowest" || next === "recent") {
                setSort(next);
              }
            }}
          >
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {listBody}
      </section>

      <section aria-label="Write a review" className="rv-section">
        {writeBody}
      </section>

      {notice !== null ? <output className="rv-notice">{notice}</output> : null}
      {failure !== null ? (
        <p role="alert" className="rv-error">
          {failure}
        </p>
      ) : null}

      <RestaurantReviewFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        venueId={venueId}
        session={session}
        initial={editTarget !== null && editTarget.venueId === venueId ? editTarget : null}
        locale={locale}
        onSubmitted={() => {
          setNotice(
            editTarget !== null
              ? "Your changes were received and are awaiting moderation."
              : "Thanks — your review was received and is awaiting moderation.",
          );
          setEditTarget(null);
        }}
      />
    </div>
  );
}
