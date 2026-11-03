import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MessageSquare, PenLine } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { SharedSelectField } from "@/components/ui/select";
import { MuseReviewHighlights } from "@/modules/restaurant-discovery/components/MuseReviewHighlights";
import {
  restaurantCopy,
  type RestaurantCopy,
} from "@/modules/restaurant-discovery/components/restaurant-copy";
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

const SORT_MODES: ReadonlyArray<CustomerReviewSortMode> = ["recent", "highest", "lowest"];

function sortLabelFor(mode: CustomerReviewSortMode, copy: RestaurantCopy): string {
  if (mode === "highest") {
    return copy.reviewsSortHighest;
  }

  if (mode === "lowest") {
    return copy.reviewsSortLowest;
  }

  return copy.reviewsSortRecent;
}

/** Thrown server failures are untrusted transport input; parse the message at the boundary. */
const failureText = (error: Error, copy: RestaurantCopy): string => {
  const parsed = clientFailureSchema.safeParse(error);

  if (parsed.success && parsed.data.message !== "") {
    return parsed.data.message;
  }

  return copy.reviewsUnavailable;
};

/**
 * Self-fetching traveler reviews panel for one venue, in workspace order:
 * header → summary → highlights → toolbar → list → single write action.
 * The public list is server-sorted (the sort rides in the query key) and
 * never shows pending rows — pending visibility is a server guarantee, not
 * a client filter. The optional rating filter narrows the loaded published
 * pages only; the server list schema carries no rating param, so the filter
 * state stays visible and clearable while load-more follows the server
 * pages. The toolbar owns the single Back; this panel renders none.
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
  const copy: RestaurantCopy = restaurantCopy(locale);
  const queryClient = useQueryClient();
  const [sort, setSort] = useState<CustomerReviewSortMode>("recent");
  const [ratingFilter, setRatingFilter] = useState<number | null>(null);
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
      setNotice(copy.reviewsRemoved);
      void queryClient.invalidateQueries({ queryKey: ["customer-reviews", venueId] });
    },
    onError: (error) => {
      setDeletingId(null);
      setFailure(failureText(error, copy));
    },
  });

  const ownReview = own.data ?? null;
  const ownId = ownReview?.id ?? null;

  const fetched: ReadonlyArray<RestaurantCustomerReview> = useMemo(
    () => list.data?.pages.flatMap((page) => page.items) ?? [],
    [list.data],
  );

  const total = list.data?.pages[0]?.total ?? 0;

  // The published own review appears exactly once: inside the public list
  // when its page is loaded, otherwise as a single "Your review" strip.
  // Pending never reaches the list (server excludes it), so pending renders
  // as a compact awaiting-approval strip with no card and no average impact.
  const ownInList = ownId !== null && fetched.some((review) => review.id === ownId);

  const visible =
    ratingFilter === null ? fetched : fetched.filter((review) => review.rating === ratingFilter);

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

  const sortOptions = SORT_MODES.map((mode) => ({
    value: mode,
    label: sortLabelFor(mode, copy),
  }));

  let ownStrip: ReactNode = null;

  if (signedIn && own.isPending) {
    ownStrip = (
      <div aria-busy="true" aria-label={copy.reviewsLoading} className="reviews-section">
        <div aria-hidden="true" className="reviews-skeleton reviews-skeleton-card" />
      </div>
    );
  } else if (signedIn && own.isError) {
    ownStrip = (
      <p role="alert" className="reviews-error">
        {failureText(own.error, copy)}
      </p>
    );
  } else if (ownReview !== null && ownReview.status === "pending") {
    ownStrip = (
      <output className="reviews-status">
        <span className="reviews-status-dot" aria-hidden="true" />
        {copy.reviewsAwaiting}
      </output>
    );
  } else if (ownReview !== null && ownReview.status === "published" && !ownInList) {
    ownStrip = (
      <section aria-label={copy.reviewsYourReview} className="reviews-section">
        <output className="reviews-notice">{copy.reviewsPublishedNote}</output>
        <ol className="reviews-list">
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
      </section>
    );
  }

  let listBody: ReactNode;

  if (list.isPending) {
    listBody = (
      <div aria-busy="true" aria-label={copy.reviewsLoading} className="reviews-section">
        <div aria-hidden="true" className="reviews-skeleton reviews-skeleton-card" />
        <div aria-hidden="true" className="reviews-skeleton reviews-skeleton-card" />
      </div>
    );
  } else if (list.isError) {
    listBody = (
      <div className="reviews-section">
        <p role="alert" className="reviews-error">
          {failureText(list.error, copy)}
        </p>
        <button type="button" className="reviews-ghost" onClick={onBackToOverview}>
          {copy.menuBackToOverview}
        </button>
      </div>
    );
  } else if (visible.length === 0) {
    listBody = (
      <output className="reviews-empty">
        <p>
          {ratingFilter === null
            ? copy.reviewsEmpty
            : copy.reviewsFilterShowing.replace("{stars}", String(ratingFilter))}
        </p>
        {ratingFilter !== null ? (
          <button
            type="button"
            className="reviews-ghost"
            onClick={() => {
              setRatingFilter(null);
            }}
          >
            {copy.reviewsFilterClear}
          </button>
        ) : null}
      </output>
    );
  } else {
    const remaining = total - fetched.length;

    listBody = (
      <>
        <ol className="reviews-list">
          {visible.map((review) => (
            <li key={review.id}>
              <RestaurantReviewCard
                review={review}
                locale={locale}
                isAuthor={ownId !== null && review.id === ownId}
                actionPending={deletingId === review.id || deletion.isPending}
                onEdit={() => {
                  if (ownId !== null && review.id === ownId) {
                    openOwnEdit();
                  } else {
                    openEdit(review);
                  }
                }}
                onDelete={() => deletion.mutate(review.id)}
              />
            </li>
          ))}
        </ol>
        {list.hasNextPage ? (
          <button
            type="button"
            className="reviews-ghost reviews-load-more"
            disabled={list.isFetchingNextPage}
            aria-busy={list.isFetchingNextPage}
            onClick={() => {
              void list.fetchNextPage();
            }}
          >
            {list.isFetchingNextPage
              ? copy.reviewsLoading
              : copy.reviewsLoadMoreLeft.replace("{remaining}", String(Math.max(remaining, 0)))}
          </button>
        ) : null}
      </>
    );
  }

  // Single write-review action at the foot of the workspace. The empty list
  // above carries no second button; travelers who already published edit
  // from their card instead.
  let writeBody: ReactNode = null;

  if (ownReview === null) {
    if (session.status === "signed-in") {
      writeBody = (
        <button type="button" className="reviews-primary" onClick={openWrite}>
          <PenLine aria-hidden="true" />
          {copy.reviewsWriteAction}
        </button>
      );
    } else {
      const paused =
        session.status === "unavailable" ? copy.reviewsSignInPaused : copy.reviewsSignInPrompt;

      writeBody = (
        <div className="reviews-signin">
          <p>{paused}</p>
          {session.status === "signed-out" ? (
            <Link
              to="/sign-in"
              search={{ lang: locale, returnTo }}
              className="reviews-primary"
              onClick={() => {
                writeReviewWriteIntent(venueId, { rating: null, body: "" });
              }}
            >
              {copy.reviewsSignInContinue}
            </Link>
          ) : null}
        </div>
      );
    }
  }

  return (
    <div className="reviews-panel">
      <div className="reviews-head">
        <h2>{copy.reviewsTitle}</h2>
      </div>

      <section aria-label={copy.reviewsSummaryTitle}>
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
          activeRating={ratingFilter}
          onSelectRating={setRatingFilter}
        />
        {summary.isError ? (
          <p role="alert" className="reviews-error">
            {failureText(summary.error, copy)}
          </p>
        ) : null}
      </section>

      <MuseReviewHighlights venueId={venueId} language={locale === "vi" ? "vi" : "en"} />

      {ownStrip}

      <section aria-label={copy.reviewsListHeading} className="reviews-section">
        <div className="reviews-toolbar">
          <h3>
            <MessageSquare aria-hidden="true" />
            {copy.reviewsListHeading}
          </h3>
          <SharedSelectField
            label={copy.reviewsSortLabel}
            value={sort}
            options={sortOptions}
            size="compact"
            onValueChange={(value) => {
              if (value === "highest" || value === "lowest" || value === "recent") {
                setSort(value);
              }
            }}
          />
        </div>
        {ratingFilter !== null ? (
          <p className="reviews-filter-chip">
            <span>{copy.reviewsFilterShowing.replace("{stars}", String(ratingFilter))}</span>
            <button
              type="button"
              className="reviews-link"
              onClick={() => {
                setRatingFilter(null);
              }}
            >
              {copy.reviewsFilterClear}
            </button>
          </p>
        ) : null}

        {listBody}
      </section>

      {writeBody !== null ? (
        <section aria-label={copy.reviewsWriteAction} className="reviews-section">
          {writeBody}
        </section>
      ) : null}

      {notice !== null ? <output className="reviews-notice">{notice}</output> : null}
      {failure !== null ? (
        <p role="alert" className="reviews-error">
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
          setNotice(editTarget !== null ? copy.reviewsEdited : copy.reviewsSubmitted);
          setEditTarget(null);
        }}
      />
    </div>
  );
}
