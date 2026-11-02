import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect } from "effect";
import postgres from "postgres";

import {
  customerReviewQueuePageSchema,
  type CustomerReviewQueuePage,
} from "@/modules/restaurant-discovery/restaurant-reviews.schema";
import { venueWriteSchema } from "@/modules/restaurant-discovery/restaurant.schema";
import { writeVenue } from "@/modules/restaurant-discovery/server/index";
import {
  CustomerReviewSubmitOutcome,
  listCustomerReviewQueue,
  moderateRestaurantCustomerReview,
  submitRestaurantCustomerReview,
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

let plainMember: Actor = Actor.Guest();

let venueQueueA = "";

let venueQueueB = "";

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
          businessName: `Synthetic queue business ${stamp}`,
          name,
          address: "Synthetic queue address",
          area: `Queue area ${stamp}`,
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

const queueAs = async (
  actor: Actor,
  input: {
    venue: string;
    status: "pending" | "published" | "rejected" | "removed" | "all";
    limit: number;
    offset: number;
  },
): Promise<CustomerReviewQueuePage> => {
  const page = await run(withActor(actor, listCustomerReviewQueue(input)));

  return customerReviewQueuePageSchema.parse(page);
};

beforeAll(async () => {
  const curatorSession = await auth.signupSignin(`queue-curator-${stamp}`);

  await auth.grantRole(curatorSession.userId, "curator");

  const trustedCurator = await run(
    requireAuthenticatedActor(new Headers({ cookie: curatorSession.cookies })),
  );

  curator = Actor.Member({ userId: trustedCurator.userId });
  memberA = await memberOf("queue-member-a");
  plainMember = await memberOf("queue-member-plain");

  venueQueueA = await makeVenue(`Queue venue alpha ${stamp}`);
  venueQueueB = await makeVenue(`Queue venue beta ${stamp}`);
});

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

describe("customer review moderation queue", () => {
  test("pending reviews surface pending-first across venues with totals", async () => {
    await submitAs(memberA, venueQueueA, 5, "Queue alpha five star.");
    await submitAs(memberA, venueQueueB, 2, "Queue beta two star.");

    const page = await queueAs(curator, {
      venue: "",
      status: "pending",
      limit: 20,
      offset: 0,
    });

    expect(page.total).toBe(2);
    expect(page.pending_count).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.status).toBe("pending");
    expect(page.items[1]?.status).toBe("pending");
    // Newest first.
    expect(page.items[0]?.body).toBe("Queue beta two star.");
    expect(page.items[1]?.body).toBe("Queue alpha five star.");
    expect(page.items[0]?.venue_name).toContain("Queue venue beta");
  });

  test("status filter narrows to published after moderation", async () => {
    const submitted = await submitAs(memberA, venueQueueA, 4, "Queue alpha four star.");

    /* oxlint-disable typescript/no-unsafe-return, typescript/no-unsafe-assignment -- tsc-clean under live-DB Reylo: $match over Reylo-inferred rows resolves without a live analysis DB */
    const target = CustomerReviewSubmitOutcome.$match(submitted, {
      // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
      Created: ({ review }) => review.id,
      // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
      Updated: ({ review }) => review.id,
    });
    /* oxlint-enable typescript/no-unsafe-return, typescript/no-unsafe-assignment */

    await run(
      withActor(
        curator,
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- target is the $match-extracted review id above; tsc-clean under live-DB Reylo
        moderateRestaurantCustomerReview({ reviewId: target, status: "published" }),
      ),
    );

    const published = await queueAs(curator, {
      venue: "",
      status: "published",
      limit: 20,
      offset: 0,
    });

    expect(published.total).toBe(1);
    expect(published.items[0]?.body).toBe("Queue alpha four star.");

    const pending = await queueAs(curator, {
      venue: "",
      status: "pending",
      limit: 20,
      offset: 0,
    });

    expect(pending.items.every((entry) => entry.status === "pending")).toBe(true);
    expect(pending.pending_count).toBe(pending.total);
  });

  test("venue text filter matches venue names", async () => {
    const page = await queueAs(curator, {
      venue: "beta",
      status: "all",
      limit: 20,
      offset: 0,
    });

    expect(page.total).toBe(1);
    expect(page.items[0]?.venue_name).toContain("Queue venue beta");
  });

  test("guests and grantless members cannot read the queue", async () => {
    // authorizeModerator enforces the restaurant:review grant first, so
    // guests fail at the permission layer exactly like grantless members.
    const guestDenied = await run(
      Effect.flip(
        withActor(
          Actor.Guest(),
          listCustomerReviewQueue({ venue: "", status: "pending", limit: 20, offset: 0 }),
        ),
      ),
    );

    expect(guestDenied._tag).toBe("InsufficientPermissions");

    const memberDenied = await run(
      Effect.flip(
        withActor(
          plainMember,
          listCustomerReviewQueue({ venue: "", status: "pending", limit: 20, offset: 0 }),
        ),
      ),
    );

    expect(memberDenied._tag).toBe("InsufficientPermissions");
  });
});
