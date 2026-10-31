import { Data, Effect } from "effect";

import { RestaurantInputError } from "@/modules/restaurant-discovery/server/operations/discovery";
import approveItem from "@/modules/restaurant-discovery/server/repository/sql/review-approve-item.sql";
import approveVariant from "@/modules/restaurant-discovery/server/repository/sql/review-approve-variant.sql";
import contributionsQuery from "@/modules/restaurant-discovery/server/repository/sql/review-contributions.sql";
import decidePrice from "@/modules/restaurant-discovery/server/repository/sql/review-decide-price.sql";
import decideServing from "@/modules/restaurant-discovery/server/repository/sql/review-decide-serving.sql";
import itemPriceQuery from "@/modules/restaurant-discovery/server/repository/sql/review-item-price.sql";
import itemServingQuery from "@/modules/restaurant-discovery/server/repository/sql/review-item-serving.sql";
import lockPrice from "@/modules/restaurant-discovery/server/repository/sql/review-lock-price.sql";
import lockServing from "@/modules/restaurant-discovery/server/repository/sql/review-lock-serving.sql";
import queueQuery from "@/modules/restaurant-discovery/server/repository/sql/review-queue.sql";
import { Authorization, recordAuditEvent } from "@/modules/user/server/index";
import { Actor } from "@/server/auth/actor";
import { CurrentActor } from "@/server/auth/current-actor";
import { withTransaction } from "@/server/database/client";
import { runQuery } from "@/server/database/query";

export class ReviewNotFound extends Data.TaggedError("ReviewNotFound")<{
  readonly id: string;
}> {}

export class ReviewConflict extends Data.TaggedError("ReviewConflict")<{
  readonly reason: string;
}> {}

export type ReviewQueueRow = (typeof queueQuery)["~reylo"]["element"];

export type ReviewPriceDetail = (typeof itemPriceQuery)["~reylo"]["element"];

export type ReviewServingDetail = (typeof itemServingQuery)["~reylo"]["element"];

export type ReviewContributionRow = (typeof contributionsQuery)["~reylo"]["element"];

/** Review decisions need only `restaurant:review`. Management alone never authorizes a decision. */
const authorizeReviewer = Effect.gen(function* () {
  const actor = yield* CurrentActor;
  const authorization = yield* Authorization;
  yield* authorization.require(actor, { resource: "restaurant", actions: ["review"] });

  return Actor.$match(actor, {
    Guest: () => Effect.fail(new RestaurantInputError({ reason: "A verified member is required" })),
    Member: ({ userId }) => Effect.succeed(userId),
  });
}).pipe(Effect.flatten);

export interface ReviewQueueFilters {
  readonly venue: string;
  readonly kind: "all" | "price" | "serving";
  readonly status: "all" | "pending" | "approved" | "rejected";
  readonly from: string | null;
  readonly to: string | null;
  readonly limit: number;
  readonly offset: number;
}

export interface ReviewContributionFilters {
  readonly venue: string;
  readonly status: "all" | "pending" | "approved" | "rejected";
  readonly from: string | null;
  readonly to: string | null;
  readonly limit: number;
  readonly offset: number;
}

export interface ObservationDecision {
  readonly kind: "price" | "serving";
  readonly id: string;
  readonly status: "approved" | "rejected";
}

const checkPage = (limit: number, offset: number) =>
  Effect.gen(function* () {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      yield* new RestaurantInputError({
        reason: "Review pages hold 1–100 rows",
      });
    } else if (!Number.isInteger(offset) || offset < 0) {
      yield* new RestaurantInputError({
        reason: "Review offsets start at zero",
      });
    }
  });

const checkBounds = (from: string | null, to: string | null) =>
  Effect.gen(function* () {
    if (from !== null && Number.isNaN(Date.parse(from))) {
      yield* new RestaurantInputError({
        reason: "Review date bounds must be ISO dates",
      });
    } else if (to !== null && Number.isNaN(Date.parse(to))) {
      yield* new RestaurantInputError({
        reason: "Review date bounds must be ISO dates",
      });
    } else if (from !== null && to !== null && Date.parse(from) > Date.parse(to)) {
      yield* new RestaurantInputError({
        reason: "The review date range ends before it starts",
      });
    }
  });

/**
 * Pending-first, filterable, server-paginated observation queue. The page
 * carries its own total; clients never page through an unbounded latest-N dump.
 */
export const listReviewQueue = Effect.fn("restaurants/list-review-queue")(function* (
  input: ReviewQueueFilters,
) {
  yield* authorizeReviewer;
  yield* checkPage(input.limit, input.offset);
  yield* checkBounds(input.from, input.to);

  const rows = yield* runQuery("restaurants/review-queue", (sql) =>
    queueQuery.run(sql, {
      venue: input.venue,
      kind: input.kind,
      status: input.status,
      from: input.from,
      to: input.to,
      limit: input.limit,
      offset: input.offset,
    }),
  );

  return { items: rows, total: rows[0]?.total ?? 0, limit: input.limit, offset: input.offset };
});

/** One observation with its source, branch, reviewer trail and receipt evidence. */
export const getReviewItem = Effect.fn("restaurants/get-review-item")(function* (input: {
  readonly kind: "price" | "serving";
  readonly id: string;
}) {
  yield* authorizeReviewer;

  const row =
    input.kind === "price"
      ? yield* runQuery("restaurants/review-item-price", (sql) =>
          itemPriceQuery.run(sql, { id: input.id }),
        )
      : yield* runQuery("restaurants/review-item-serving", (sql) =>
          itemServingQuery.run(sql, { id: input.id }),
        );

  if (row === null) return yield* new ReviewNotFound({ id: input.id });

  return row;
});

/**
 * Review-gated observation decision with compare-and-set semantics. Repeating
 * the recorded decision succeeds without side effects; a conflicting
 * decision fails. Approval publishes eligible drafts without reviving
 * archived identities; photographs are never published by fact approval —
 * promotion only reuses registered private evidence keys. The audit row is
 * written in the same transaction as the decision.
 */
export const decideObservation = Effect.fn("restaurants/decide-observation")(function* (
  input: ObservationDecision,
) {
  const actorId = yield* authorizeReviewer;

  return yield* withTransaction(
    "restaurants/decide-observation",
    Effect.gen(function* () {
      const locked =
        input.kind === "price"
          ? yield* runQuery("restaurants/review-lock-price", (sql) =>
              lockPrice.run(sql, { id: input.id }),
            )
          : yield* runQuery("restaurants/review-lock-serving", (sql) =>
              lockServing.run(sql, { id: input.id }),
            );

      if (locked === null) return yield* new ReviewNotFound({ id: input.id });

      if (locked.review_status === input.status)
        return { id: locked.id, status: locked.review_status, repeated: true };

      if (locked.review_status !== "pending")
        return yield* new ReviewConflict({
          reason: "Another reviewer already recorded a different decision.",
        });

      const decided =
        input.kind === "price"
          ? yield* runQuery("restaurants/review-decide-price", (sql) =>
              decidePrice.run(sql, { id: input.id, actor: actorId, status: input.status }),
            )
          : yield* runQuery("restaurants/review-decide-serving", (sql) =>
              decideServing.run(sql, { id: input.id, actor: actorId, status: input.status }),
            );

      if (decided === null)
        return yield* new ReviewConflict({
          reason: "Another reviewer decided this observation first.",
        });

      if (input.status === "approved") {
        yield* runQuery("restaurants/review-approve-variant", (sql) =>
          approveVariant.run(sql, { id: input.id, kind: input.kind }),
        );
        yield* runQuery("restaurants/review-approve-item", (sql) =>
          approveItem.run(sql, { id: input.id, kind: input.kind }),
        );
      }

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: `restaurant.observation.${input.status}`,
        outcome: "succeeded",
        resource: input.id,
      });

      return { id: decided.id, status: decided.review_status, repeated: false };
    }),
  );
});

/**
 * Pending-first, filterable, server-paginated scan-contribution queue.
 * Photograph bytes and extracted drafts stay behind the contribution detail
 * path; this listing exposes only routing metadata and the review trail.
 */
export const listReviewContributions = Effect.fn("restaurants/list-review-contributions")(
  function* (input: ReviewContributionFilters) {
    yield* authorizeReviewer;
    yield* checkPage(input.limit, input.offset);
    yield* checkBounds(input.from, input.to);

    const rows = yield* runQuery("restaurants/review-contributions", (sql) =>
      contributionsQuery.run(sql, {
        venue: input.venue,
        status: input.status,
        from: input.from,
        to: input.to,
        limit: input.limit,
        offset: input.offset,
      }),
    );

    return { items: rows, total: rows[0]?.total ?? 0, limit: input.limit, offset: input.offset };
  },
);
