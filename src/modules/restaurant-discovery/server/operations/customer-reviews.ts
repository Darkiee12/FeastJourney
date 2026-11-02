import { Data, Effect } from "effect";

import activeQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-active.sql";
import deleteOwnQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-delete-own.sql";
import findQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-find.sql";
import insertQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-insert.sql";
import listQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-list.sql";
import lockQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-lock.sql";
import moderateQuery from "@/modules/restaurant-discovery/server/repository/sql/customer-review-moderate.sql";
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

export type CustomerReviewSummary = {
  readonly venueId: string;
  readonly total: number;
  readonly average: number;
  readonly distribution: ReadonlyArray<{ readonly stars: number; readonly count: number }>;
};

export type CustomerReviewSubmitOutcome = Data.TaggedEnum<{
  Created: { readonly review: CustomerReviewRow };
  Updated: { readonly review: CustomerReviewRow };
}>;

export const CustomerReviewSubmitOutcome = Data.taggedEnum<CustomerReviewSubmitOutcome>();

export type CustomerReviewModerateOutcome = Data.TaggedEnum<{
  Applied: { readonly review: CustomerReviewRow };
  Repeated: { readonly review: CustomerReviewRow };
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

export const CUSTOMER_REVIEW_BODY_MAX = 2000;

const CUSTOMER_REVIEW_PAGE_MAX = 50;

const allowedModeration: ReadonlyMap<
  string,
  ReadonlyArray<CustomerReviewModerationStatus>
> = new Map([
  ["pending", ["published", "rejected"]],
  ["published", ["removed"]],
  ["rejected", ["published"]],
]);

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

/** Published-only, server-paginated page. The page carries its own total. */
export const listRestaurantCustomerReviews = Effect.fn("restaurants/list-customer-reviews")(
  function* (input: CustomerReviewPageInput) {
    yield* checkPage(input.limit, input.offset);
    yield* requirePublishedVenue(input.venueId);

    const rows = yield* runQuery("restaurants/customer-review-list", (sql) =>
      listQuery.run(sql, {
        venue_id: input.venueId,
        limit: input.limit,
        offset: input.offset,
      }),
    );

    return { items: rows, total: rows[0]?.total ?? 0, limit: input.limit, offset: input.offset };
  },
);

/**
 * Idempotent member submission. The first active review per member per venue
 * is created into `pending`; resubmitting while an active review exists
 * revises that review (back to `pending`) instead of duplicating it. Payloads
 * never set author or status: both come from the verified session and policy.
 */
export const submitRestaurantCustomerReview = Effect.fn("restaurants/submit-customer-review")(
  function* (input: CustomerReviewSubmitInput) {
    const authorId = yield* requireMember;
    const body = yield* checkRatingBody(input.rating, input.body);

    return yield* withTransaction(
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

          return CustomerReviewSubmitOutcome.Created({ review: created });
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

        return CustomerReviewSubmitOutcome.Updated({ review: updated });
      }),
    );
  },
);

/**
 * Author revision. Any content change returns the review to `pending`, so
 * published text can never be silently rewritten. Rejected reviews may be
 * revised into a fresh `pending` submission.
 */
export const updateOwnRestaurantCustomerReview = Effect.fn("restaurants/update-own-review")(
  function* (input: CustomerReviewUpdateInput) {
    const authorId = yield* requireMember;
    const body = yield* checkRatingBody(input.rating, input.body);

    const updated = yield* runQuery("restaurants/customer-review-update-own", (sql) =>
      updateOwnQuery.run(sql, {
        id: input.reviewId,
        author_id: authorId,
        rating: input.rating,
        body,
      }),
    );

    if (updated !== null) return updated;

    const existing = yield* runQuery("restaurants/customer-review-find", (sql) =>
      findQuery.run(sql, { id: input.reviewId }),
    );

    if (existing === null) return yield* new CustomerReviewNotFound({ reviewId: input.reviewId });

    if (existing.author_id !== authorId)
      return yield* new NotReviewAuthor({ reviewId: input.reviewId });

    return yield* new CustomerReviewConflict({
      reason: "Removed reviews cannot be edited. Submit a new review instead.",
    });
  },
);

/**
 * Author removal. The row is anonymized (body cleared, status `removed`) and
 * stays for audit; it never appears in public reads or aggregates again.
 * Removing an already-removed own review succeeds without further change.
 */
export const deleteOwnRestaurantCustomerReview = Effect.fn("restaurants/delete-own-review")(
  function* (input: { readonly reviewId: string }) {
    const authorId = yield* requireMember;

    const removed = yield* runQuery("restaurants/customer-review-delete-own", (sql) =>
      deleteOwnQuery.run(sql, { id: input.reviewId, author_id: authorId }),
    );

    if (removed !== null) return removed;

    const existing = yield* runQuery("restaurants/customer-review-find", (sql) =>
      findQuery.run(sql, { id: input.reviewId }),
    );

    if (existing === null) return yield* new CustomerReviewNotFound({ reviewId: input.reviewId });

    if (existing.author_id !== authorId)
      return yield* new NotReviewAuthor({ reviewId: input.reviewId });

    return existing;
  },
);

/**
 * Grant-gated moderation with compare-and-set semantics. Repeating the
 * recorded status succeeds without side effects; an illegal transition fails
 * explicitly. The audit row is written in the same transaction as the decision.
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
        return CustomerReviewModerateOutcome.Repeated({ review: locked });

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

      return CustomerReviewModerateOutcome.Applied({ review: decided });
    }),
  );
});
