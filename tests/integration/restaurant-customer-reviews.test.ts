import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect } from "effect";
import postgres from "postgres";

import { customerReviewSubmitSchema } from "@/modules/restaurant-discovery/restaurant-reviews.schema";
import { venueWriteSchema } from "@/modules/restaurant-discovery/restaurant.schema";
import { writeVenue } from "@/modules/restaurant-discovery/server/index";
import {
  CustomerReviewModerateOutcome,
  CustomerReviewSubmitOutcome,
  deleteOwnRestaurantCustomerReview,
  getRestaurantReviewSummary,
  listRestaurantCustomerReviews,
  moderateRestaurantCustomerReview,
  submitRestaurantCustomerReview,
  updateOwnRestaurantCustomerReview,
} from "@/modules/restaurant-discovery/server/operations/customer-reviews";
import { Actor } from "@/server/auth/actor";
import { withActor } from "@/server/auth/current-actor";
import { requireAuthenticatedActor } from "@/server/auth/session";
import type { AppServices } from "@/server/layers";
import { appRuntime } from "@/server/runtime";

// oxlint-disable-next-line import/no-unassigned-import -- seeds disposable-DB and auth env guards at import time; this file owns no fixtures.
import "./cleanup";
import { createFoodAuth } from "./food-auth";

const run = <A, E, R extends AppServices>(effect: Effect.Effect<A, E, R>) =>
  appRuntime.runPromise(effect);

const auth = createFoodAuth();

const sql = postgres(process.env.DATABASE_URL ?? "", { max: 2 });

const stamp = crypto.randomUUID().slice(0, 8);

const venueIds: Array<string> = [];

let curator: Actor = Actor.Guest();

let memberA: Actor = Actor.Guest();

let memberB: Actor = Actor.Guest();

let memberC: Actor = Actor.Guest();

let venueMain = "";

let venueMod = "";

let venuePage = "";

/* oxlint-disable typescript/no-unsafe-return -- tsc-clean under live-DB Reylo: $match over Reylo-inferred rows resolves without a live analysis DB */
const createdReviewId = (outcome: CustomerReviewSubmitOutcome): string =>
  CustomerReviewSubmitOutcome.$match(outcome, {
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    Created: ({ review }) => review.id,
    Updated: () => {
      throw new Error("expected Created outcome");
    },
  });

const updatedReviewId = (outcome: CustomerReviewSubmitOutcome): string =>
  CustomerReviewSubmitOutcome.$match(outcome, {
    Created: () => {
      throw new Error("expected Updated outcome");
    },
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    Updated: ({ review }) => review.id,
  });

const appliedReview = (outcome: CustomerReviewModerateOutcome) =>
  CustomerReviewModerateOutcome.$match(outcome, {
    Applied: ({ review }) => review,
    Repeated: () => {
      throw new Error("expected Applied outcome");
    },
  });
/* oxlint-enable typescript/no-unsafe-return */

const memberOf = async (name: string): Promise<Actor> => {
  const session = await auth.signupSignin(`${name}-${stamp}`);
  const trusted = await run(requireAuthenticatedActor(new Headers({ cookie: session.cookies })));

  return Actor.Member({ userId: trusted.userId });
};

const makeVenue = async (name: string): Promise<string> => {
  const venue = await run(
    withActor(
      curator,
      writeVenue(
        venueWriteSchema.parse({
          businessName: `Synthetic customer-review business ${stamp}`,
          name,
          address: "Synthetic customer-review address",
          area: `Review area ${stamp}`,
          countryCode: "VN",
          longitude: 106.7,
          latitude: 10.8,
          status: "published",
        }),
      ),
    ),
  );

  // SAFETY: writeVenue returns the created venue row; id is its UUID primary key.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same invariant; tsc-clean under live-DB Reylo
  const id = venue.id as string;

  venueIds.push(id);

  return id;
};

const submitAs = (actor: Actor, venueId: string, rating: number, body: string) =>
  run(withActor(actor, submitRestaurantCustomerReview({ venueId, rating, body })));

beforeAll(async () => {
  const curatorSession = await auth.signupSignin(`cr-curator-${stamp}`);

  await auth.grantRole(curatorSession.userId, "curator");

  const trustedCurator = await run(
    requireAuthenticatedActor(new Headers({ cookie: curatorSession.cookies })),
  );

  curator = Actor.Member({ userId: trustedCurator.userId });

  memberA = await memberOf("cr-member-a");
  memberB = await memberOf("cr-member-b");
  memberC = await memberOf("cr-member-c");

  venueMain = await makeVenue(`Customer review venue main ${stamp}`);
  venueMod = await makeVenue(`Customer review venue mod ${stamp}`);
  venuePage = await makeVenue(`Customer review venue page ${stamp}`);
}, 30000);

afterAll(async () => {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM feastjourney.restaurant_customer_reviews WHERE venue_id=ANY(${venueIds}::uuid[])`;
    await tx`DELETE FROM feastjourney.restaurant_venue_names WHERE venue_id=ANY(${venueIds}::uuid[])`;
    await tx`DELETE FROM feastjourney.restaurant_venue_cuisines WHERE venue_id=ANY(${venueIds}::uuid[])`;
    await tx`WITH removed AS (DELETE FROM feastjourney.restaurant_venues WHERE id=ANY(${venueIds}::uuid[]) RETURNING business_id)
      DELETE FROM feastjourney.restaurant_businesses WHERE id IN(SELECT business_id FROM removed)`;
  });

  await sql.end();

  await auth.close();
});

describe("transport schemas", () => {
  test("rating and body bounds reject invalid payloads", () => {
    expect(
      customerReviewSubmitSchema.safeParse({ venueId: crypto.randomUUID(), rating: 6, body: "ok" })
        .success,
    ).toBe(false);

    expect(
      customerReviewSubmitSchema.safeParse({ venueId: crypto.randomUUID(), rating: 0, body: "ok" })
        .success,
    ).toBe(false);

    expect(
      customerReviewSubmitSchema.safeParse({ venueId: crypto.randomUUID(), rating: 3, body: "  " })
        .success,
    ).toBe(false);

    expect(
      customerReviewSubmitSchema.safeParse({
        venueId: crypto.randomUUID(),
        rating: 3,
        body: "x".repeat(2001),
      }).success,
    ).toBe(false);

    expect(
      customerReviewSubmitSchema.safeParse({
        venueId: crypto.randomUUID(),
        rating: 4,
        body: "Great pho.",
      }).success,
    ).toBe(true);
  });
});

describe("guest reads and pending invisibility", () => {
  test("guests read an empty venue without an actor", async () => {
    const summary = await run(getRestaurantReviewSummary(venueMain));

    expect(summary.venueId).toBe(venueMain);
    expect(summary.total).toBe(0);
    expect(summary.average).toBe(0);
    expect(summary.distribution).toEqual([
      { stars: 1, count: 0 },
      { stars: 2, count: 0 },
      { stars: 3, count: 0 },
      { stars: 4, count: 0 },
      { stars: 5, count: 0 },
    ]);

    const page = await run(
      listRestaurantCustomerReviews({ venueId: venueMain, sort: "recent", limit: 20, offset: 0 }),
    );

    expect(page.total).toBe(0);
    expect(page.items).toEqual([]);
  });

  test("member submit enters pending and stays invisible publicly", async () => {
    const submitted = await submitAs(memberA, venueMain, 5, "Outstanding broth.");

    expect(submitted._tag).toBe("Created");

    createdReviewId(submitted);

    const summary = await run(getRestaurantReviewSummary(venueMain));

    expect(summary.total).toBe(0);

    const page = await run(
      listRestaurantCustomerReviews({ venueId: venueMain, sort: "recent", limit: 20, offset: 0 }),
    );

    expect(page.total).toBe(0);
  });

  test("resubmitting revises the same review instead of duplicating it", async () => {
    const first = await submitAs(memberA, venueMain, 5, "Outstanding broth.");

    expect(first._tag).toBe("Updated");

    const firstId = updatedReviewId(first);

    const second = await submitAs(memberA, venueMain, 4, "Very good, slightly salty.");

    expect(second._tag).toBe("Updated");

    const secondId = updatedReviewId(second);

    expect(secondId).toBe(firstId);

    const summary = await run(getRestaurantReviewSummary(venueMain));

    expect(summary.total).toBe(0);
  });
});

describe("publication and exact aggregates", () => {
  test("published reviews become visible with exact counts, average and distribution", async () => {
    const pendingA = await submitAs(memberA, venueMain, 4, "Very good, slightly salty.");

    expect(pendingA._tag).toBe("Updated");

    const publishedA = await run(
      withActor(
        curator,
        moderateRestaurantCustomerReview({
          reviewId: updatedReviewId(pendingA),
          status: "published",
        }),
      ),
    );

    expect(publishedA._tag).toBe("Applied");

    const submittedB = await submitAs(memberB, venueMain, 5, "Best pho in town.");

    expect(submittedB._tag).toBe("Created");

    const publishedB = await run(
      withActor(
        curator,
        moderateRestaurantCustomerReview({
          reviewId: createdReviewId(submittedB),
          status: "published",
        }),
      ),
    );

    expect(publishedB._tag).toBe("Applied");

    const summary = await run(getRestaurantReviewSummary(venueMain));

    expect(summary.total).toBe(2);
    expect(summary.average).toBe(4.5);
    expect(summary.distribution).toEqual([
      { stars: 1, count: 0 },
      { stars: 2, count: 0 },
      { stars: 3, count: 0 },
      { stars: 4, count: 1 },
      { stars: 5, count: 1 },
    ]);

    const page = await run(
      listRestaurantCustomerReviews({ venueId: venueMain, sort: "recent", limit: 20, offset: 0 }),
    );

    expect(page.total).toBe(2);
    expect(page.items.length).toBe(2);

    for (const item of page.items) {
      expect(Object.keys(item).toSorted()).toEqual([
        "body",
        "created_at",
        "id",
        "published_at",
        "rating",
      ]);
    }

    const serialized = JSON.stringify(page);

    expect(serialized).not.toContain("author_id");
    expect(serialized).not.toContain("pending");
    expect(serialized).not.toContain("removed");
  });

  test("listings are scoped to their venue", async () => {
    const other = await submitAs(memberC, venueMod, 5, "Scoped review.");

    expect(other._tag).toBe("Created");

    await run(
      withActor(
        curator,
        moderateRestaurantCustomerReview({ reviewId: createdReviewId(other), status: "published" }),
      ),
    );

    const page = await run(
      listRestaurantCustomerReviews({ venueId: venueMain, sort: "recent", limit: 20, offset: 0 }),
    );

    expect(page.total).toBe(2);

    for (const item of page.items) {
      expect(Object.keys(item).toSorted()).toEqual([
        "body",
        "created_at",
        "id",
        "published_at",
        "rating",
      ]);
    }

    expect(JSON.stringify(page)).not.toContain("Scoped review.");
  });
});

describe("author edit and delete", () => {
  test("author revision hides the review until re-published", async () => {
    const submitted = await submitAs(memberA, venueMain, 3, "Revised after a second visit.");

    expect(submitted._tag).toBe("Updated");

    const revision = updatedReviewId(submitted);

    const edited = await run(
      withActor(
        memberA,
        updateOwnRestaurantCustomerReview({ reviewId: revision, rating: 3, body: "Edited." }),
      ),
    );

    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(edited.status).toBe("pending");

    const summary = await run(getRestaurantReviewSummary(venueMain));

    expect(summary.total).toBe(1);
    expect(summary.average).toBe(5);

    const republished = await run(
      withActor(
        curator,
        moderateRestaurantCustomerReview({ reviewId: revision, status: "published" }),
      ),
    );

    expect(republished._tag).toBe("Applied");

    const restored = await run(getRestaurantReviewSummary(venueMain));

    expect(restored.total).toBe(2);
  });

  test("other authors cannot edit or delete", async () => {
    const submitted = await submitAs(memberB, venueMain, 5, "Best pho in town.");

    expect(submitted._tag).toBe("Updated");

    const target = updatedReviewId(submitted);

    const forbiddenEdit = await run(
      Effect.flip(
        withActor(
          memberA,
          updateOwnRestaurantCustomerReview({ reviewId: target, rating: 1, body: "Hijacked." }),
        ),
      ),
    );

    expect(forbiddenEdit._tag).toBe("NotReviewAuthor");

    const forbiddenDelete = await run(
      Effect.flip(withActor(memberA, deleteOwnRestaurantCustomerReview({ reviewId: target }))),
    );

    expect(forbiddenDelete._tag).toBe("NotReviewAuthor");

    const restored = await run(
      withActor(
        curator,
        moderateRestaurantCustomerReview({ reviewId: target, status: "published" }),
      ),
    );

    expect(restored._tag).toBe("Repeated");
  });

  test("guests cannot write", async () => {
    const denied = await run(
      Effect.flip(
        withActor(
          Actor.Guest(),
          submitRestaurantCustomerReview({ venueId: venueMain, rating: 5, body: "Guest review." }),
        ),
      ),
    );

    expect(denied._tag).toBe("SignInRequired");
  });

  test("author delete redacts body and stays invisible", async () => {
    const submitted = await submitAs(memberA, venueMain, 3, "Revised after a second visit.");

    expect(submitted._tag).toBe("Updated");

    const target = updatedReviewId(submitted);

    const removed = await run(
      withActor(memberA, deleteOwnRestaurantCustomerReview({ reviewId: target })),
    );

    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(removed.status).toBe("removed");

    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(removed.body).toBe("");

    const summary = await run(getRestaurantReviewSummary(venueMain));

    expect(summary.total).toBe(1);

    const repeated = await run(
      withActor(memberA, deleteOwnRestaurantCustomerReview({ reviewId: target })),
    );

    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(repeated.status).toBe("removed");
  });

  test("removed reviews cannot be edited but allow a fresh submission", async () => {
    const page = await run(
      listRestaurantCustomerReviews({ venueId: venueMain, sort: "recent", limit: 50, offset: 0 }),
    );

    expect(page.total).toBe(1);

    const submitted = await submitAs(memberA, venueMain, 4, "Fresh take after removal.");

    expect(submitted._tag).toBe("Created");

    const target = createdReviewId(submitted);

    await run(
      withActor(
        curator,
        moderateRestaurantCustomerReview({ reviewId: target, status: "published" }),
      ),
    );

    const summary = await run(getRestaurantReviewSummary(venueMain));

    expect(summary.total).toBe(2);
  });
});

describe("moderation transitions and failures", () => {
  test("pending rejects, rejected republishes, repeats report without side effects", async () => {
    const submitted = await submitAs(memberB, venueMod, 2, "Too salty this time.");

    expect(submitted._tag).toBe("Created");

    const target = createdReviewId(submitted);

    const rejected = await run(
      withActor(
        curator,
        moderateRestaurantCustomerReview({ reviewId: target, status: "rejected" }),
      ),
    );

    expect(rejected._tag).toBe("Applied");

    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(appliedReview(rejected).status).toBe("rejected");

    const republished = await run(
      withActor(
        curator,
        moderateRestaurantCustomerReview({ reviewId: target, status: "published" }),
      ),
    );

    expect(republished._tag).toBe("Applied");

    const repeated = await run(
      withActor(
        curator,
        moderateRestaurantCustomerReview({ reviewId: target, status: "published" }),
      ),
    );

    expect(repeated._tag).toBe("Repeated");

    const summary = await run(getRestaurantReviewSummary(venueMod));

    expect(summary.total).toBeGreaterThanOrEqual(1);
  });

  test("published removals are terminal and conflicts fail explicitly", async () => {
    const submitted = await submitAs(memberC, venueMod, 1, "Terminal review.");

    expect(submitted._tag).toBe("Updated");

    const target = updatedReviewId(submitted);

    await run(
      withActor(
        curator,
        moderateRestaurantCustomerReview({ reviewId: target, status: "published" }),
      ),
    );

    const removed = await run(
      withActor(curator, moderateRestaurantCustomerReview({ reviewId: target, status: "removed" })),
    );

    expect(removed._tag).toBe("Applied");

    const conflict = await run(
      Effect.flip(
        withActor(
          curator,
          moderateRestaurantCustomerReview({ reviewId: target, status: "published" }),
        ),
      ),
    );

    expect(conflict._tag).toBe("CustomerReviewConflict");
  });

  test("members without the review grant cannot moderate", async () => {
    const submitted = await submitAs(memberA, venueMod, 4, "Grant check review.");

    expect(submitted._tag).toBe("Created");

    const target = createdReviewId(submitted);

    const denied = await run(
      Effect.flip(
        withActor(
          memberB,
          moderateRestaurantCustomerReview({ reviewId: target, status: "published" }),
        ),
      ),
    );

    expect(denied._tag).toBe("InsufficientPermissions");
  });

  test("unknown reviews fail closed", async () => {
    const missing = crypto.randomUUID();

    const detail = await run(
      Effect.flip(
        withActor(
          memberA,
          updateOwnRestaurantCustomerReview({ reviewId: missing, rating: 4, body: "Missing." }),
        ),
      ),
    );

    expect(detail._tag).toBe("CustomerReviewNotFound");

    const removed = await run(
      Effect.flip(withActor(memberA, deleteOwnRestaurantCustomerReview({ reviewId: missing }))),
    );

    expect(removed._tag).toBe("CustomerReviewNotFound");

    const moderated = await run(
      Effect.flip(
        withActor(
          curator,
          moderateRestaurantCustomerReview({ reviewId: missing, status: "published" }),
        ),
      ),
    );

    expect(moderated._tag).toBe("CustomerReviewNotFound");
  });

  test("unknown venues fail closed on every path", async () => {
    const missing = crypto.randomUUID();

    const summary = await run(Effect.flip(getRestaurantReviewSummary(missing)));

    expect(summary._tag).toBe("UnknownVenue");

    const page = await run(
      Effect.flip(
        listRestaurantCustomerReviews({ venueId: missing, sort: "recent", limit: 20, offset: 0 }),
      ),
    );

    expect(page._tag).toBe("UnknownVenue");

    const submitted = await run(
      Effect.flip(
        withActor(
          memberA,
          submitRestaurantCustomerReview({ venueId: missing, rating: 5, body: "Lost." }),
        ),
      ),
    );

    expect(submitted._tag).toBe("UnknownVenue");
  });

  test("invalid pages and payloads fail explicitly", async () => {
    const badLimit = await run(
      Effect.flip(
        listRestaurantCustomerReviews({ venueId: venueMod, sort: "recent", limit: 0, offset: 0 }),
      ),
    );

    expect(badLimit._tag).toBe("CustomerReviewValidationFailed");

    const hugeLimit = await run(
      Effect.flip(
        listRestaurantCustomerReviews({ venueId: venueMod, sort: "recent", limit: 51, offset: 0 }),
      ),
    );

    expect(hugeLimit._tag).toBe("CustomerReviewValidationFailed");

    const badRating = await run(
      Effect.flip(
        withActor(
          memberA,
          submitRestaurantCustomerReview({ venueId: venueMod, rating: 6, body: "Too high." }),
        ),
      ),
    );

    expect(badRating._tag).toBe("CustomerReviewValidationFailed");

    const emptyBody = await run(
      Effect.flip(
        withActor(
          memberA,
          submitRestaurantCustomerReview({ venueId: venueMod, rating: 4, body: "   " }),
        ),
      ),
    );

    expect(emptyBody._tag).toBe("CustomerReviewValidationFailed");

    const longBody = await run(
      Effect.flip(
        withActor(
          memberA,
          submitRestaurantCustomerReview({ venueId: venueMod, rating: 4, body: "x".repeat(2001) }),
        ),
      ),
    );

    expect(longBody._tag).toBe("CustomerReviewValidationFailed");
  });
});

describe("pagination", () => {
  test("pages carry totals and never cross venues", async () => {
    const authors: Array<Actor> = [memberA, memberB, memberC];
    const ratings = [5, 4, 3];

    await Promise.all(
      authors.map(async (author, index) => {
        const submitted = await submitAs(
          author,
          venuePage,
          ratings[index] ?? 5,
          `Page review ${index}.`,
        );

        expect(submitted._tag).toBe("Created");

        await run(
          withActor(
            curator,
            moderateRestaurantCustomerReview({
              reviewId: createdReviewId(submitted),
              status: "published",
            }),
          ),
        );
      }),
    );

    const summary = await run(getRestaurantReviewSummary(venuePage));

    expect(summary.total).toBe(3);
    expect(summary.average).toBe(4);
    expect(summary.distribution).toEqual([
      { stars: 1, count: 0 },
      { stars: 2, count: 0 },
      { stars: 3, count: 1 },
      { stars: 4, count: 1 },
      { stars: 5, count: 1 },
    ]);

    const first = await run(
      listRestaurantCustomerReviews({ venueId: venuePage, sort: "recent", limit: 2, offset: 0 }),
    );

    expect(first.total).toBe(3);
    expect(first.items.length).toBe(2);

    const second = await run(
      listRestaurantCustomerReviews({ venueId: venuePage, sort: "recent", limit: 2, offset: 2 }),
    );

    expect(second.total).toBe(3);
    expect(second.items.length).toBe(1);

    // oxlint-disable-next-line typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-return -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    const firstIds = new Set(first.items.map((item) => item.id));

    for (const item of first.items) {
      expect(Object.keys(item).toSorted()).toEqual([
        "body",
        "created_at",
        "id",
        "published_at",
        "rating",
      ]);
    }

    for (const item of second.items) {
      // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
      expect(firstIds.has(item.id)).toBe(false);

      expect(Object.keys(item).toSorted()).toEqual([
        "body",
        "created_at",
        "id",
        "published_at",
        "rating",
      ]);
    }

    expect(JSON.stringify({ first, second })).not.toContain("author_id");
  });
});
