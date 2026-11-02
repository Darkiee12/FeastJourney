import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, PenLine } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { RestaurantReviewCard } from "@/modules/restaurant-discovery/components/restaurant-review-card";
import type { RestaurantCustomerReview } from "@/modules/restaurant-discovery/components/restaurant-review-card";
import {
  clearReviewWriteIntent,
  readReviewWriteIntent,
  RestaurantReviewFormDialog,
  writeReviewWriteIntent,
  type CustomerReviewEditTarget,
} from "@/modules/restaurant-discovery/components/restaurant-review-form";
import { RestaurantReviewSummary } from "@/modules/restaurant-discovery/components/restaurant-review-summary";
import type { CustomerReviewSortMode } from "@/modules/restaurant-discovery/restaurant-reviews.constants";
import {
  deleteOwnRestaurantCustomerReviewFn,
  getOwnRestaurantCustomerReviewFn,
  getRestaurantReviewSummaryFn,
  listRestaurantCustomerReviewsFn,
} from "@/modules/restaurant-discovery/restaurant-reviews.functions";
import type { CustomerReviewPublicPage } from "@/modules/restaurant-discovery/restaurant-reviews.schema";
import type { SessionState } from "@/modules/user/session.functions";
import { clientFailureSchema } from "@/shared/client-failure";
import type { Locale } from "@/shared/i18n";

export const CUSTOMER_REVIEW_PAGE_SIZE = 10;

/**
 * Server-driven list key: the sort rides in the key so switching sorts
 * builds a fresh cache instead of re-sorting (or mixing) another sort's
 * pages. All review queries share the ["customer-reviews", venueId] prefix
 * so one invalidation refreshes the list, summary, and own review together.
 */
export const customerReviewListKey = (
  venueId: string,
  sort: CustomerReviewSortMode,
): ReadonlyArray<string> => ["customer-reviews", venueId, sort];

/** Pure next-offset rule for the paged public list; extracted for unit tests. */
export const nextCustomerReviewPageParam = (
  lastPage: CustomerReviewPublicPage,
): number | undefined => {
  const consumed = lastPage.offset + lastPage.items.length;

  if (consumed >= lastPage.total) {
    return undefined;
  }

  return lastPage.offset + lastPage.limit;
};

const sortOptions: ReadonlyArray<{
  readonly value: CustomerReviewSortMode;
  readonly label: string;
}> = [
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
 * Self-fetching traveler reviews panel for one venue. The public list is
 * server-sorted (the sort rides in the query key) and never shows pending
 * rows — pending visibility is a server guarantee, not a client filter.
 * A signed-in traveler's own review renders in a private "Your review"
 * section with Edit instead of a duplicate Write call-to-action.
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
  const [sort, setSort] = useState<CustomerReviewSortMode>("recent");
  const [formOpen, setFormOpen] = useState(false);

  const [editTarget, setEditTarget] = useState<
    (CustomerReviewEditTarget & { readonly venueId: string }) | null
  >(null);

  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const signedIn = session.status === "signed-in";

  // Restore a write intent parked before the sign-in redirect with the
  // render-adjust pattern: opening the dialog is synchronous UI state, so an
  // effect would trip react/set-state-in-effect. One shot per venue — once
  // the signed-in traveler is back, the dialog reopens and the form restores
  // the parked draft from storage.
  const [intentVenue, setIntentVenue] = useState<string | null>(null);

  if (intentVenue !== venueId && signedIn && readReviewWriteIntent(venueId) !== null) {
    setIntentVenue(venueId);
    setEditTarget(null);
    setFormOpen(true);
  }

  // Consuming the intent is I/O rather than UI state, so the storage clear
  // stays in an effect with no setState inside.
  useEffect(() => {
    if (intentVenue === venueId) {
      clearReviewWriteIntent(venueId);
    }
  }, [intentVenue, venueId]);

  const summary = useQuery({
    queryKey: ["customer-reviews", venueId, "summary"],
    queryFn: () => getRestaurantReviewSummaryFn({ data: { venueId } }),
    retry: false,
  });

  const list = useInfiniteQuery({
    queryKey: customerReviewListKey(venueId, sort),
    queryFn: ({ pageParam }) =>
      listRestaurantCustomerReviewsFn({
        data: { venueId, sort, limit: CUSTOMER_REVIEW_PAGE_SIZE, offset: pageParam },
      }),
    initialPageParam: 0,
    getNextPageParam: nextCustomerReviewPageParam,
    retry: false,
  });

  // The author's own active review (pending included) resolves from the
  // verified session; browser input carries the venue only. Guests and
  // unavailable sessions skip the query: there is no own review to show.
  const own = useQuery({
    queryKey: ["customer-reviews", venueId, "own"],
    queryFn: () => getOwnRestaurantCustomerReviewFn({ data: { venueId } }),
    enabled: signedIn,
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

  const ownReview = own.data ?? null;
  const ownId = ownReview?.id ?? null;

  const fetched: ReadonlyArray<RestaurantCustomerReview> = useMemo(
    () => list.data?.pages.flatMap((page) => page.items) ?? [],
    [list.data],
  );

  const total = list.data?.pages[0]?.total ?? 0;

  // Relative venue path only: the sign-in route's safeReturnTo allowlist
  // rejects absolute and protocol-relative destinations, so this can only
  // ever land back on this site. The lang query preserves the locale across
  // the full-page sign-in round-trip; the draft and write intent travel via
  // session storage (see PendingReviewWriteIntent in the review form).
  const returnTo = `/restaurants/${venueId}?lang=${locale}`;

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

  const openOwnEdit = (): void => {
    if (ownReview === null) {
      return;
    }

    setEditTarget({
      venueId,
      reviewId: ownReview.id,
      rating: ownReview.rating,
      body: ownReview.body,
    });
    setFormOpen(true);
  };

  let ownBody: ReactNode = null;

  if (signedIn && own.isPending) {
    ownBody = (
      <div aria-busy="true" aria-label="Loading your review" className="rv-section">
        <div aria-hidden="true" className="rv-skeleton rv-skeleton-card" />
      </div>
    );
  } else if (signedIn && own.isError) {
    ownBody = (
      <p role="alert" className="rv-error">
        {failureText(own.error)}
      </p>
    );
  } else if (ownReview !== null) {
    ownBody = (
      <>
        <output className="rv-notice">
          {ownReview.status === "pending"
            ? "Your review was received and is awaiting moderation. It appears here once published; the shown average only counts published reviews."
            : "Your published review. The shown average counts published reviews only."}
        </output>
        <ol className="rv-list">
          <li key={ownReview.id}>
            <RestaurantReviewCard
              review={{
                id: ownReview.id,
                rating: ownReview.rating,
                body: ownReview.body,
                created_at: ownReview.created_at,
                published_at: ownReview.published_at,
              }}
              locale={locale}
              isAuthor
              actionPending={deletingId === ownReview.id || deletion.isPending}
              onEdit={openOwnEdit}
              onDelete={() => deletion.mutate(ownReview.id)}
            />
          </li>
        </ol>
      </>
    );
  }

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
  } else if (fetched.length === 0) {
    listBody = (
      <output className="rv-empty">
        <p>No reviews match yet. Be the first to share your experience.</p>
        {ownReview === null ? (
          <button type="button" className="rv-primary" onClick={openWrite}>
            <PenLine aria-hidden="true" />
            Write a review
          </button>
        ) : null}
      </output>
    );
  } else {
    const remaining = total - fetched.length;

    listBody = (
      <>
        <ol className="rv-list">
          {fetched.map((review) => (
            <li key={review.id}>
              <RestaurantReviewCard
                review={review}
                locale={locale}
                isAuthor={ownId !== null && review.id === ownId}
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

  let writeBody: ReactNode = null;

  if (ownReview === null) {
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
              search={{ lang: locale, returnTo }}
              className="rv-primary"
              onClick={() => {
                writeReviewWriteIntent(venueId, { rating: null, body: "" });
              }}
            >
              Sign in to continue
            </Link>
          ) : null}
        </div>
      );
    }
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

      {ownBody !== null ? (
        <section aria-label="Your review" className="rv-section">
          <h3>Your review</h3>
          {ownBody}
        </section>
      ) : null}

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

      {writeBody !== null ? (
        <section aria-label="Write a review" className="rv-section">
          {writeBody}
        </section>
      ) : null}

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
