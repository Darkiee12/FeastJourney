import { Data, Effect } from "effect";

import type { CustomerReviewSortMode } from "@/modules/restaurant-discovery/restaurant-reviews.constants";
import {
  CUSTOMER_REVIEW_BODY_MAX,
  CUSTOMER_REVIEW_PAGE_MAX,
} from "@/modules/restaurant-discovery/restaurant-reviews.constants";
import activeQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-active.sql";
import countQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-count.sql";
import deleteOwnQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-delete-own.sql";
import findQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-find.sql";
import insertQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-insert.sql";
import listQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-list.sql";
import lockQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-lock.sql";
import moderateQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-moderate.sql";
import ownQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-own.sql";
import queueCountQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-queue-count.sql";
import queueQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-queue.sql";
import summaryQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-summary.sql";
import updateOwnQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-update-own.sql";
import venueQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-venue.sql";
import { Authorization, recordAuditEvent } from "@/modules/user/server/index";
import { Actor } from "@/server/auth/actor";
import { CurrentActor } from "@/server/auth/current-actor";
import { SignInRequired } from "@/server/auth/errors";
import { withTransaction } from "@/server/database/client";
import { runQuery } from "@/server/database/query";

export class UnknownVenue extends Data.TaggedError("UnknownVenue")<{
  readonly venueId: string;
}> {}

export class NotReviewAuthor extends Data.TaggedError("NotReviewAuthor")<{
  readonly reviewId: string;
}> {}

export class CustomerReviewNotFound extends Data.TaggedError("CustomerReviewNotFound")<{
  readonly reviewId: string;
}> {}

export class CustomerReviewConflict extends Data.TaggedError("CustomerReviewConflict")<{
  readonly reason: string;
}> {}

export class CustomerReviewValidationFailed extends Data.TaggedError(
  "CustomerReviewValidationFailed",
)<{
  readonly reason: string;
}> {}

export type CustomerReviewRow = (typeof findQuery)["~reylo"]["element"];

export type CustomerReviewListRow = (typeof listQuery)["~reylo"]["element"];

/**
 * Public-safe write shape. Mutation SQL projections exclude `author_id`;
 * TypeScript mapping below strips it explicitly even when an internal
 * read (active/lock/find) still carries it for ownership checks.
 */
export type CustomerReviewMutationRow = (typeof insertQuery)["~reylo"]["element"];

export type CustomerReviewSummary = {
  readonly venueId: string;
  readonly total: number;
  readonly average: number;
  readonly distribution: ReadonlyArray<{ readonly stars: number; readonly count: number }>;
};

export type CustomerReviewSubmitOutcome = Data.TaggedEnum<{
  Created: { readonly review: CustomerReviewMutationRow };
  Updated: { readonly review: CustomerReviewMutationRow };
}>;

export const CustomerReviewSubmitOutcome = Data.taggedEnum<CustomerReviewSubmitOutcome>();

export type CustomerReviewModerateOutcome = Data.TaggedEnum<{
  Applied: { readonly review: CustomerReviewMutationRow };
  Repeated: { readonly review: CustomerReviewMutationRow };
}>;

export const CustomerReviewModerateOutcome = Data.taggedEnum<CustomerReviewModerateOutcome>();

export type CustomerReviewModerationStatus = "published" | "rejected" | "removed";

export interface CustomerReviewSubmitInput {
  readonly venueId: string;
  readonly rating: number;
  readonly body: string;
}

export interface CustomerReviewPageInput {
  readonly venueId: string;
  readonly sort: CustomerReviewSortMode;
  readonly limit: number;
  readonly offset: number;
}

export interface CustomerReviewUpdateInput {
  readonly reviewId: string;
  readonly rating: number;
  readonly body: string;
}

export interface CustomerReviewModerateInput {
  readonly reviewId: string;
  readonly status: CustomerReviewModerationStatus;
}

export { CUSTOMER_REVIEW_BODY_MAX };

export type CustomerReviewOwnRow = (typeof ownQuery)["~reylo"]["element"];

export interface CustomerReviewOwnInput {
  readonly venueId: string;
}

const allowedModeration: ReadonlyMap<
  string,
  ReadonlyArray<CustomerReviewModerationStatus>
> = new Map([
  ["pending", ["published", "rejected"]],
  ["published", ["removed"]],
  ["rejected", ["published"]],
]);

/**
 * Explicit public-safe projection. Internal reads (active/lock/find) still
 * select `author_id` for ownership checks; mutation responses never carry
 * it. Mirrors the published-only list projection which already excludes
 * author identity, venue redundancy, and moderation internals.
 */
const toMutationRow = (row: {
  readonly id: string;
  readonly venue_id: string;
  readonly rating: number;
  readonly body: string;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly published_at: string | null;
}): CustomerReviewMutationRow => {
  // SAFETY: mutation SQL projections already exclude `author_id`; this picks
  // exactly the safe columns (id, venue_id, rating, body, status, timestamps)
  // so internal reads carrying `author_id` can never leak through responses.
  // The status CHECK constraint guarantees a known value; anything else is
  // database corruption and must fail loud, never coerce.
  if (
    row.status !== "pending" &&
    row.status !== "published" &&
    row.status !== "rejected" &&
    row.status !== "removed"
  ) {
    throw new Error(`Unexpected customer review status: ${row.status}`);
  }

  return {
    id: row.id,
    venue_id: row.venue_id,
    rating: row.rating,
    body: row.body,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,
  };
};

const requireMember = Effect.gen(function* () {
  const actor = yield* CurrentActor;

  return Actor.$match(actor, {
    Guest: () => Effect.fail(new SignInRequired({ required: "member" })),
    Member: ({ userId }) => Effect.succeed(userId),
  });
}).pipe(Effect.flatten);

/** Customer-review moderation needs only `restaurant:review`. Management alone never authorizes it. */
const authorizeModerator = Effect.gen(function* () {
  const actor = yield* CurrentActor;
  const authorization = yield* Authorization;
  yield* authorization.require(actor, { resource: "restaurant", actions: ["review"] });

  return Actor.$match(actor, {
    Guest: () => Effect.fail(new SignInRequired({ required: "member" })),
    Member: ({ userId }) => Effect.succeed(userId),
  });
}).pipe(Effect.flatten);

const checkRatingBody = (rating: number, body: string) =>
  Effect.gen(function* () {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return yield* new CustomerReviewValidationFailed({
        reason: "Rating must be an integer from 1 to 5",
      });
    }

    const trimmed = body.trim();

    if (trimmed.length === 0) {
      return yield* new CustomerReviewValidationFailed({ reason: "Review text is required" });
    }

    if (trimmed.length > CUSTOMER_REVIEW_BODY_MAX) {
      return yield* new CustomerReviewValidationFailed({
        reason: "Review text must be at most 2000 characters",
      });
    }

    return trimmed;
  });

const checkPage = (limit: number, offset: number) =>
  Effect.gen(function* () {
    if (!Number.isInteger(limit) || limit < 1 || limit > CUSTOMER_REVIEW_PAGE_MAX) {
      yield* new CustomerReviewValidationFailed({
        reason: "Review pages hold 1–50 rows",
      });
    } else if (!Number.isInteger(offset) || offset < 0) {
      yield* new CustomerReviewValidationFailed({ reason: "Review offsets start at zero" });
    }
  });

const requirePublishedVenue = (venueId: string) =>
  Effect.gen(function* () {
    const venue = yield* runQuery("restaurants/customer-review-venue", (sql) =>
      venueQuery.run(sql, { id: venueId }),
    );

    if (venue === null || venue.status !== "published") return yield* new UnknownVenue({ venueId });

    return venue;
  });

/** Published-only aggregate. Pending rows never affect the public average. */
export const getRestaurantReviewSummary = Effect.fn("restaurants/get-customer-review-summary")(
  function* (venueId: string) {
    yield* requirePublishedVenue(venueId);

    const row = yield* runQuery("restaurants/customer-review-summary", (sql) =>
      summaryQuery.run(sql, { venue_id: venueId }),
    );

    const total = row?.total ?? 0;
    const ratingSum = row?.rating_sum ?? 0;

    return {
      venueId,
      total,
      average: total === 0 ? 0 : ratingSum / total,
      distribution: [
        { stars: 1, count: row?.stars_1 ?? 0 },
        { stars: 2, count: row?.stars_2 ?? 0 },
        { stars: 3, count: row?.stars_3 ?? 0 },
        { stars: 4, count: row?.stars_4 ?? 0 },
        { stars: 5, count: row?.stars_5 ?? 0 },
      ],
    };
  },
);

/** Published-only, server-paginated page. Items match the public DTO; the page carries its own total. */
export const listRestaurantCustomerReviews = Effect.fn("restaurants/list-customer-reviews")(
  function* (input: CustomerReviewPageInput) {
    yield* checkPage(input.limit, input.offset);
    yield* requirePublishedVenue(input.venueId);

    // Defense in depth: the transport schema already defaults and validates
    // sort, but the operation must never interpolate an unchecked value into
    // ORDER BY when called directly.
    const sort: string = input.sort;

    if (sort !== "recent" && sort !== "highest" && sort !== "lowest") {
      return yield* new CustomerReviewValidationFailed({ reason: "Unknown review sort" });
    }

    const rows = yield* runQuery("restaurants/customer-review-list", (sql) =>
      listQuery.run(sql, {
        venue_id: input.venueId,
        sort: input.sort,
        limit: input.limit,
        offset: input.offset,
      }),
    );

    const counted = yield* runQuery("restaurants/customer-review-count", (sql) =>
      countQuery.run(sql, { venue_id: input.venueId }),
    );

    const items = rows.map((row) => ({
      id: row.id,
      rating: row.rating,
      body: row.body,
      created_at: row.created_at,
      published_at: row.published_at,
    }));

    return { items, total: counted?.total ?? 0, limit: input.limit, offset: input.offset };
  },
);

/**
 * Idempotent member submission with identical-content fast path and
 * concurrent-first-submit collapse.
 *
 * - First submission creates a new `pending` review.
 * - Identical resubmission (same rating+trimmed body, active row exists)
 *   returns the existing row unchanged: no status, timestamp, or
 *   publication churn. Pending stays pending, published stays published.
 * - Changed content updates the active row back to `pending` with
 *   `published_at` cleared, so published text can never be silently rewritten.
 * - Rejected rows are not active; a later submission after rejection creates
 *   a fresh `pending` row while the rejected row stays for audit. Explicit
 *   author revision of a rejected row goes through `updateOwn` instead.
 * - Removed rows are terminal; resubmission creates a fresh row only when no
 *   active row remains, respecting the partial unique index on
 *   (`venue_id`, `author_id`) WHERE status IN ('pending','published').
 * - Concurrency: two simultaneous first submissions race on the partial
 *   unique index. The loser translates its `PersistenceConflict`
 *   (23505 on `restaurant_customer_reviews_active_author_idx`) into the
 *   intentional outcome by re-reading the winner in a fresh transaction
 *   and applying the identical/changed rule above. No global mutex.
 * - Bounded retries apply to serialization conflicts only via
 *   `withTransaction` (TransactionConflict 40001/40P01, two retries);
 *   validation and auth failures never retry.
 *
 * Payloads never set author or status: both come from the verified session
 * and policy. Responses are public-safe (no `author_id`).
 */
export const submitRestaurantCustomerReview = Effect.fn("restaurants/submit-customer-review")(
  function* (input: CustomerReviewSubmitInput) {
    const authorId = yield* requireMember;
    const body = yield* checkRatingBody(input.rating, input.body);

    const firstAttempt = withTransaction(
      "restaurants/submit-customer-review",
      Effect.gen(function* () {
        yield* requirePublishedVenue(input.venueId);

        const activeRows = yield* runQuery("restaurants/customer-review-active", (sql) =>
          activeQuery.run(sql, { venue_id: input.venueId, author_id: authorId }),
        );

        const existing = activeRows[0] ?? null;

        if (existing === null) {
          const created = yield* runQuery("restaurants/customer-review-insert", (sql) =>
            insertQuery.run(sql, {
              venue_id: input.venueId,
              author_id: authorId,
              rating: input.rating,
              body,
            }),
          );

          if (created === null)
            return yield* new CustomerReviewConflict({
              reason: "The review could not be recorded. Please retry.",
            });

          return CustomerReviewSubmitOutcome.Created({ review: toMutationRow(created) });
        }

        if (existing.rating === input.rating && existing.body === body) {
          return CustomerReviewSubmitOutcome.Updated({ review: toMutationRow(existing) });
        }

        const updated = yield* runQuery("restaurants/customer-review-update-own", (sql) =>
          updateOwnQuery.run(sql, {
            id: existing.id,
            author_id: authorId,
            rating: input.rating,
            body,
          }),
        );

        if (updated === null)
          return yield* new CustomerReviewConflict({
            reason: "The review changed while submitting. Please retry.",
          });

        return CustomerReviewSubmitOutcome.Updated({ review: toMutationRow(updated) });
      }),
    );

    return yield* firstAttempt.pipe(
      Effect.catchTag("PersistenceConflict", () =>
        withTransaction(
          "restaurants/submit-customer-review-conflict",
          Effect.gen(function* () {
            yield* requirePublishedVenue(input.venueId);

            const reread = yield* runQuery("restaurants/customer-review-active", (sql) =>
              activeQuery.run(sql, { venue_id: input.venueId, author_id: authorId }),
            );

            const winner = reread[0] ?? null;

            if (winner === null)
              return yield* new CustomerReviewConflict({
                reason: "The review could not be recorded. Please retry.",
              });

            if (winner.rating === input.rating && winner.body === body) {
              return CustomerReviewSubmitOutcome.Updated({ review: toMutationRow(winner) });
            }

            const updated = yield* runQuery("restaurants/customer-review-update-own", (sql) =>
              updateOwnQuery.run(sql, {
                id: winner.id,
                author_id: authorId,
                rating: input.rating,
                body,
              }),
            );

            if (updated === null)
              return yield* new CustomerReviewConflict({
                reason: "The review changed while submitting. Please retry.",
              });

            return CustomerReviewSubmitOutcome.Updated({ review: toMutationRow(updated) });
          }),
        ),
      ),
    );
  },
);

/**
 * Author revision with identical-content fast path.
 *
 * - Identical content (same rating+trimmed body) returns the locked row
 *   unchanged: no status, timestamp, or publication churn.
 * - Changed content returns the row to `pending` with `published_at` cleared,
 *   so published text can never be silently rewritten. Rejected rows revised
 *   here re-enter `pending` as a fresh moderation cycle.
 * - Removed rows are terminal and fail with `CustomerReviewConflict`.
 * - The row is locked (`FOR UPDATE`) inside a transaction; serialization
 *   conflicts retry at the transaction boundary only. Validation and auth
 *   failures never retry. Responses are public-safe (no `author_id`).
 */
export const updateOwnRestaurantCustomerReview = Effect.fn("restaurants/update-own-review")(
  function* (input: CustomerReviewUpdateInput) {
    const authorId = yield* requireMember;
    const body = yield* checkRatingBody(input.rating, input.body);

    return yield* withTransaction(
      "restaurants/update-own-review",
      Effect.gen(function* () {
        const locked = yield* runQuery("restaurants/customer-review-lock", (sql) =>
          lockQuery.run(sql, { id: input.reviewId }),
        );

        if (locked === null) return yield* new CustomerReviewNotFound({ reviewId: input.reviewId });

        if (locked.author_id !== authorId)
          return yield* new NotReviewAuthor({ reviewId: input.reviewId });

        if (locked.status === "removed")
          return yield* new CustomerReviewConflict({
            reason: "Removed reviews cannot be edited. Submit a new review instead.",
          });

        if (locked.rating === input.rating && locked.body === body) {
          return toMutationRow(locked);
        }

        const updated = yield* runQuery("restaurants/customer-review-update-own", (sql) =>
          updateOwnQuery.run(sql, {
            id: input.reviewId,
            author_id: authorId,
            rating: input.rating,
            body,
          }),
        );

        if (updated === null)
          return yield* new CustomerReviewConflict({
            reason: "The review changed while saving. Please retry.",
          });

        return toMutationRow(updated);
      }),
    );
  },
);

/**
 * Author removal with soft-delete-with-redaction retention.
 *
 * Retained for audit and moderation history: `author_id`, `venue_id`,
 * `rating`, `created_at`, `updated_at`, and `published_at`. Redacted:
 * `body` is cleared to `''`. The row keeps status `removed` and never
 * appears in public reads or aggregates again. This is not anonymization:
 * the author link stays so moderators can trace abuse and the partial
 * unique index can distinguish terminal rows from active ones.
 *
 * Removing an already-removed own review succeeds without further change
 * (no timestamp churn). Resubmission after removal creates a fresh row
 * only when no active row remains. Responses are public-safe
 * (no `author_id`).
 */
export const deleteOwnRestaurantCustomerReview = Effect.fn("restaurants/delete-own-review")(
  function* (input: { readonly reviewId: string }) {
    const authorId = yield* requireMember;

    const removed = yield* runQuery("restaurants/customer-review-delete-own", (sql) =>
      deleteOwnQuery.run(sql, { id: input.reviewId, author_id: authorId }),
    );

    if (removed !== null) return toMutationRow(removed);

    const existing = yield* runQuery("restaurants/customer-review-find", (sql) =>
      findQuery.run(sql, { id: input.reviewId }),
    );

    if (existing === null) return yield* new CustomerReviewNotFound({ reviewId: input.reviewId });

    if (existing.author_id !== authorId)
      return yield* new NotReviewAuthor({ reviewId: input.reviewId });

    return toMutationRow(existing);
  },
);

/**
 * Grant-gated moderation with compare-and-set semantics.
 *
 * - Repeating the recorded status succeeds without side effects
 *   (`Repeated`, no timestamp or audit churn).
 * - Allowed transitions: pending→published/rejected, published→removed,
 *   rejected→published. Anything else fails with `CustomerReviewConflict`.
 * - Stale or concurrent decisions fail closed: the `UPDATE ... WHERE
 *   status = from_status` affects zero rows, so the loser observes
 *   `CustomerReviewConflict` ("Another moderator decided this review
 *   first.") with its audit trail intact (audit writes only on success,
 *   in the same transaction as the decision).
 * - Serialization conflicts retry at the transaction boundary only;
 *   validation and auth failures never retry. Responses are public-safe
 *   (no `author_id`).
 */
export const moderateRestaurantCustomerReview = Effect.fn("restaurants/moderate-review")(function* (
  input: CustomerReviewModerateInput,
) {
  const actorId = yield* authorizeModerator;

  return yield* withTransaction(
    "restaurants/moderate-review",
    Effect.gen(function* () {
      const locked = yield* runQuery("restaurants/customer-review-lock", (sql) =>
        lockQuery.run(sql, { id: input.reviewId }),
      );

      if (locked === null) return yield* new CustomerReviewNotFound({ reviewId: input.reviewId });

      if (locked.status === input.status)
        return CustomerReviewModerateOutcome.Repeated({ review: toMutationRow(locked) });

      const allowed = allowedModeration.get(locked.status);

      if (allowed === undefined || !allowed.includes(input.status))
        return yield* new CustomerReviewConflict({
          reason: `A ${locked.status} review cannot move to ${input.status}.`,
        });

      const decidedRows = yield* runQuery("restaurants/customer-review-moderate", (sql) =>
        moderateQuery.run(sql, {
          id: input.reviewId,
          status: input.status,
          from_status: locked.status,
        }),
      );

      const decided = decidedRows[0] ?? null;

      if (decided === null)
        return yield* new CustomerReviewConflict({
          reason: "Another moderator decided this review first.",
        });

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: `restaurant.customer-review.${input.status}`,
        outcome: "succeeded",
        resource: input.reviewId,
      });

      return CustomerReviewModerateOutcome.Applied({ review: toMutationRow(decided) });
    }),
  );
});

/**
 * Member's own active review for one venue, including `pending` rows that
 * never appear in public reads. The author resolves from the verified
 * session; browser input carries the venue only, so one member can never
 * address another member's review through this path. Guests fail with
 * `SignInRequired`; unknown venues fail with `UnknownVenue`.
 */
export const getOwnRestaurantReview = Effect.fn("restaurants/get-own-customer-review")(function* (
  input: CustomerReviewOwnInput,
) {
  const authorId = yield* requireMember;
  yield* requirePublishedVenue(input.venueId);

  return yield* runQuery("restaurants/customer-review-own", (sql) =>
    ownQuery.run(sql, { venue_id: input.venueId, author_id: authorId }),
  );
});

export interface CustomerReviewQueueInput {
  readonly venue: string;
  readonly status: "pending" | "published" | "rejected" | "removed" | "all";
  readonly limit: number;
  readonly offset: number;
}

/**
 * Staff moderation queue: cross-venue, pending-first, any single status or
 * all. Gated on `restaurant:review` — bodies are visible to moderators
 * only, never on public reads. Venue text matches name, area, or address.
 */
export const listCustomerReviewQueue = Effect.fn("restaurants/list-customer-review-queue")(
  function* (input: CustomerReviewQueueInput) {
    yield* authorizeModerator;
    yield* checkPage(input.limit, input.offset);

    // Defense in depth: the transport schema already constrains status, but
    // the operation must never interpolate an unchecked value into SQL.
    const status: string = input.status;

    if (
      status !== "pending" &&
      status !== "published" &&
      status !== "rejected" &&
      status !== "removed" &&
      status !== "all"
    ) {
      return yield* new CustomerReviewValidationFailed({ reason: "Unknown review status" });
    }

    const rows = yield* runQuery("restaurants/customer-review-queue", (sql) =>
      queueQuery.run(sql, {
        venue: input.venue,
        status,
        limit: input.limit,
        offset: input.offset,
      }),
    );

    const counted = yield* runQuery("restaurants/customer-review-queue-count", (sql) =>
      queueCountQuery.run(sql, { venue: input.venue, status }),
    );

    return {
      items: rows,
      total: counted?.total ?? 0,
      pending_count: counted?.pending_count ?? 0,
      limit: input.limit,
      offset: input.offset,
    };
  },
);
