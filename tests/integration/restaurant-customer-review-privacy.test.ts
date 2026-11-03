import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect } from "effect";
import postgres from "postgres";

import {
  customerReviewOwnRequestSchema,
  customerReviewPublicPageSchema,
  type CustomerReviewPublicPage,
} from "@/modules/restaurant-discovery/restaurant-reviews.schema";
import { venueWriteSchema } from "@/modules/restaurant-discovery/restaurant.schema";
import { writeVenue } from "@/modules/restaurant-discovery/server/index";
import {
  CustomerReviewSubmitOutcome,
  deleteOwnRestaurantCustomerReview,
  getOwnRestaurantReview,
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

let venuePrivacy = "";

let memberAReviewId = "";

const memberBBody = `Privacy probe published review ${stamp}.`;

const memberABody = `Privacy probe pending review ${stamp}.`;

/* oxlint-disable typescript/no-unsafe-return -- tsc-clean under live-DB Reylo: $match over Reylo-inferred rows resolves without a live analysis DB */
const createdReviewId = (outcome: CustomerReviewSubmitOutcome): string =>
  CustomerReviewSubmitOutcome.$match(outcome, {
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    Created: ({ review }) => review.id,
    Updated: () => {
      throw new Error("expected Created outcome");
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
          businessName: `Synthetic privacy business ${stamp}`,
          name,
          address: "Synthetic privacy address",
          area: `Privacy area ${stamp}`,
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

const PUBLIC_ITEM_KEYS = ["body", "created_at", "id", "published_at", "rating"];

const OWN_ROW_KEYS = [
  "body",
  "created_at",
  "id",
  "published_at",
  "rating",
  "status",
  "updated_at",
  "venue_id",
];

const assertPublicList = (page: CustomerReviewPublicPage): void => {
  const parsed = customerReviewPublicPageSchema.safeParse(page);

  expect(parsed.success).toBe(true);

  if (!parsed.success) return;

  expect(parsed.data.total).toBe(1);
  expect(parsed.data.items.length).toBe(1);

  for (const item of parsed.data.items) {
    expect(Object.keys(item).toSorted()).toEqual(PUBLIC_ITEM_KEYS);
  }

  const serialized = JSON.stringify(page);

  expect(serialized).not.toContain("author_id");
  expect(serialized).not.toContain("authorId");
  expect(serialized).not.toContain("Undisclosed");
  expect(serialized).not.toContain("@");
  expect(serialized).not.toContain("pending");
  expect(serialized).not.toContain("removed");
};

beforeAll(async () => {
  const curatorSession = await auth.signupSignin(`privacy-curator-${stamp}`);

  await auth.grantRole(curatorSession.userId, "curator");

  const trustedCurator = await run(
    requireAuthenticatedActor(new Headers({ cookie: curatorSession.cookies })),
  );

  curator = Actor.Member({ userId: trustedCurator.userId });

  memberA = await memberOf("privacy-member-a");
  memberB = await memberOf("privacy-member-b");

  venuePrivacy = await makeVenue(`Privacy venue ${stamp}`);

  const submittedA = await run(
    withActor(
      memberA,
      submitRestaurantCustomerReview({ venueId: venuePrivacy, rating: 4, body: memberABody }),
    ),
  );

  expect(submittedA._tag).toBe("Created");

  memberAReviewId = createdReviewId(submittedA);

  const submittedB = await run(
    withActor(
      memberB,
      submitRestaurantCustomerReview({ venueId: venuePrivacy, rating: 5, body: memberBBody }),
    ),
  );

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

describe("public list privacy", () => {
  test("guest list carries public columns only", async () => {
    const page = await run(
      listRestaurantCustomerReviews({
        venueId: venuePrivacy,
        sort: "recent",
        limit: 20,
        offset: 0,
      }),
    );

    assertPublicList(page);
  });

  test("signed-in list carries the same public columns", async () => {
    const page = await run(
      withActor(
        memberA,
        listRestaurantCustomerReviews({
          venueId: venuePrivacy,
          sort: "recent",
          limit: 20,
          offset: 0,
        }),
      ),
    );

    assertPublicList(page);
  });

  test("pending reviews stay invisible publicly", async () => {
    const page = await run(
      listRestaurantCustomerReviews({
        venueId: venuePrivacy,
        sort: "recent",
        limit: 20,
        offset: 0,
      }),
    );

    const serialized = JSON.stringify(page);

    expect(serialized).not.toContain(memberABody);
    expect(serialized).toContain(memberBBody);
  });
});

describe("my-review", () => {
  test("request schema cannot name an author", () => {
    const parsed = customerReviewOwnRequestSchema.safeParse({
      venueId: venuePrivacy,
      author_id: "someone-else",
      authorId: "someone-else",
    });

    expect(parsed.success).toBe(true);

    if (!parsed.success) return;

    expect("author_id" in parsed.data).toBe(false);
    expect("authorId" in parsed.data).toBe(false);
  });

  test("returns own pending review with status", async () => {
    const own = await run(withActor(memberA, getOwnRestaurantReview({ venueId: venuePrivacy })));

    expect(own).not.toBeNull();

    if (own === null) return;

    expect(Object.keys(own).toSorted()).toEqual(OWN_ROW_KEYS);
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(own.id).toBe(memberAReviewId);
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(own.status).toBe("pending");
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(own.body).toBe(memberABody);
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(own.rating).toBe(4);
    expect(JSON.stringify(own)).not.toContain("author_id");
  });

  test("another member sees only their own review", async () => {
    const own = await run(withActor(memberB, getOwnRestaurantReview({ venueId: venuePrivacy })));

    expect(own).not.toBeNull();

    if (own === null) return;

    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(own.id).not.toBe(memberAReviewId);
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(own.status).toBe("published");
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(own.body).toBe(memberBBody);
  });

  test("guests cannot read my-review", async () => {
    const denied = await run(
      Effect.flip(withActor(Actor.Guest(), getOwnRestaurantReview({ venueId: venuePrivacy }))),
    );

    expect(denied._tag).toBe("SignInRequired");
  });

  test("unknown venues fail closed", async () => {
    const missing = await run(
      Effect.flip(withActor(memberA, getOwnRestaurantReview({ venueId: crypto.randomUUID() }))),
    );

    expect(missing._tag).toBe("UnknownVenue");
  });
});

describe("forged ownership", () => {
  test("another member cannot edit through a forged review id", async () => {
    const denied = await run(
      Effect.flip(
        withActor(
          memberB,
          updateOwnRestaurantCustomerReview({
            reviewId: memberAReviewId,
            rating: 1,
            body: "Hijacked.",
          }),
        ),
      ),
    );

    expect(denied._tag).toBe("NotReviewAuthor");
  });

  test("another member cannot delete through a forged review id", async () => {
    const denied = await run(
      Effect.flip(
        withActor(memberB, deleteOwnRestaurantCustomerReview({ reviewId: memberAReviewId })),
      ),
    );

    expect(denied._tag).toBe("NotReviewAuthor");
  });

  test("the author can still edit their own review", async () => {
    const edited = await run(
      withActor(
        memberA,
        updateOwnRestaurantCustomerReview({
          reviewId: memberAReviewId,
          rating: 5,
          body: `Privacy probe revised ${stamp}.`,
        }),
      ),
    );

    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(edited.status).toBe("pending");
  });

  test("the author can delete their own review and my-review goes empty", async () => {
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- tsc-clean under live-DB Reylo: run() infers Effect success as error-typed without a live analysis DB
    const removed = await run(
      withActor(memberA, deleteOwnRestaurantCustomerReview({ reviewId: memberAReviewId })),
    );

    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(removed.status).toBe("removed");

    const own = await run(withActor(memberA, getOwnRestaurantReview({ venueId: venuePrivacy })));

    expect(own).toBeNull();

    const page = await run(
      listRestaurantCustomerReviews({
        venueId: venuePrivacy,
        sort: "recent",
        limit: 20,
        offset: 0,
      }),
    );

    assertPublicList(page);
  });
});
