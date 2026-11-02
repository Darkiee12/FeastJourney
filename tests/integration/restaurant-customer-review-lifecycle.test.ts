import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect } from "effect";
import postgres from "postgres";

import { venueWriteSchema } from "@/modules/restaurant-discovery/restaurant.schema";
import { writeVenue } from "@/modules/restaurant-discovery/server/index";
import {
  CustomerReviewModerateOutcome,
  CustomerReviewSubmitOutcome,
  deleteOwnRestaurantCustomerReview,
  getRestaurantReviewSummary,
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

let venueLife = "";

let venueConc = "";

let venueMod = "";

/* oxlint-disable typescript/no-unsafe-return -- tsc-clean under live-DB Reylo: $match over Reylo-inferred rows resolves without a live analysis DB */
const createdId = (outcome: CustomerReviewSubmitOutcome): string =>
  CustomerReviewSubmitOutcome.$match(outcome, {
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    Created: ({ review }) => review.id,
    Updated: () => {
      throw new Error("expected Created outcome");
    },
  });

const updatedId = (outcome: CustomerReviewSubmitOutcome): string =>
  CustomerReviewSubmitOutcome.$match(outcome, {
    Created: () => {
      throw new Error("expected Updated outcome");
    },
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    Updated: ({ review }) => review.id,
  });

/* oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here */
const anyId = (outcome: CustomerReviewSubmitOutcome): string =>
  CustomerReviewSubmitOutcome.$match(outcome, {
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    Created: ({ review }) => review.id,
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    Updated: ({ review }) => review.id,
  });

const appliedStatus = (outcome: CustomerReviewModerateOutcome): string =>
  CustomerReviewModerateOutcome.$match(outcome, {
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    Applied: ({ review }) => review.status,
    Repeated: () => {
      throw new Error("expected Applied outcome");
    },
  });
/* oxlint-enable typescript/no-unsafe-return */

const memberUserId = (actor: Actor): string =>
  Actor.$match(actor, {
    Guest: () => {
      throw new Error("expected member actor");
    },
    Member: ({ userId }) => userId,
  });

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
          businessName: `Synthetic lifecycle business ${stamp}`,
          name,
          address: "Synthetic lifecycle address",
          area: `Lifecycle area ${stamp}`,
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

interface ReviewRow {
  readonly id: string;
  readonly venue_id: string;
  readonly author_id: string;
  readonly rating: number;
  readonly body: string;
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly published_at: Date | null;
}

const readRow = async (reviewId: string): Promise<ReviewRow | null> => {
  const rows = await sql<ReviewRow[]>`
    SELECT id, venue_id, author_id, rating, body, status,
      created_at, updated_at, published_at
    FROM feastjourney.restaurant_customer_reviews
    WHERE id = ${reviewId}::uuid`;

  return rows[0] ?? null;
};

const countActive = async (venueId: string, authorId: string): Promise<number> => {
  const rows = await sql<{ readonly count: string }[]>`
    SELECT count(*)::text AS count
    FROM feastjourney.restaurant_customer_reviews
    WHERE venue_id = ${venueId}::uuid AND author_id = ${authorId}
      AND status IN ('pending', 'published')`;

  return Number(rows[0]?.count ?? "0");
};

const countAudit = async (reviewId: string): Promise<number> => {
  const rows = await sql<{ readonly count: string }[]>`
    SELECT count(*)::text AS count
    FROM feastjourney.security_audit_events
    WHERE resource = ${reviewId} AND event LIKE 'restaurant.customer-review.%'`;

  return Number(rows[0]?.count ?? "0");
};

beforeAll(async () => {
  const curatorSession = await auth.signupSignin(`lc-curator-${stamp}`);

  await auth.grantRole(curatorSession.userId, "curator");

  const trustedCurator = await run(
    requireAuthenticatedActor(new Headers({ cookie: curatorSession.cookies })),
  );

  curator = Actor.Member({ userId: trustedCurator.userId });

  memberA = await memberOf("lc-member-a");
  memberB = await memberOf("lc-member-b");

  venueLife = await makeVenue(`Lifecycle venue ${stamp}`);
  venueConc = await makeVenue(`Lifecycle concurrent venue ${stamp}`);
  venueMod = await makeVenue(`Lifecycle moderation venue ${stamp}`);
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

describe("first submission and identical fast path", () => {
  test("first submission creates pending with safe shape", async () => {
    const outcome = await submitAs(memberA, venueLife, 5, "Lifecycle first broth.");

    expect(outcome._tag).toBe("Created");
    expect(JSON.stringify(outcome)).not.toContain("author_id");

    const id = createdId(outcome);
    const row = await readRow(id);

    expect(row).not.toBeNull();
    expect(row?.status).toBe("pending");
    expect(row?.rating).toBe(5);
    expect(row?.body).toBe("Lifecycle first broth.");
    expect(row?.published_at).toBeNull();
    expect(row?.author_id).toBe(memberUserId(memberA));
  });

  test("identical pending resubmit leaves timestamps untouched", async () => {
    const first = await submitAs(memberA, venueLife, 5, "Lifecycle first broth.");

    expect(first._tag).toBe("Updated");

    const id = updatedId(first);
    const before = await readRow(id);

    expect(before?.status).toBe("pending");

    const beforeUpdated = before?.updated_at.getTime() ?? 0;

    const second = await submitAs(memberA, venueLife, 5, "Lifecycle first broth.");

    expect(second._tag).toBe("Updated");
    expect(updatedId(second)).toBe(id);
    expect(JSON.stringify(second)).not.toContain("author_id");

    const after = await readRow(id);

    expect(after?.status).toBe("pending");
    expect(after?.published_at).toBeNull();
    expect(after?.updated_at.getTime()).toBe(beforeUpdated);
  });

  test("identical published resubmit keeps publication", async () => {
    const pending = await submitAs(memberA, venueLife, 5, "Lifecycle first broth.");

    expect(pending._tag).toBe("Updated");

    const id = updatedId(pending);

    const published = await run(
      withActor(curator, moderateRestaurantCustomerReview({ reviewId: id, status: "published" })),
    );

    expect(published._tag).toBe("Applied");
    expect(JSON.stringify(published)).not.toContain("author_id");

    const before = await readRow(id);

    expect(before?.status).toBe("published");
    expect(before?.published_at).not.toBeNull();

    const beforePublished = before?.published_at?.getTime() ?? 0;
    const beforeUpdated = before?.updated_at.getTime() ?? 0;

    const repeat = await submitAs(memberA, venueLife, 5, "Lifecycle first broth.");

    expect(repeat._tag).toBe("Updated");
    expect(updatedId(repeat)).toBe(id);

    const after = await readRow(id);

    expect(after?.status).toBe("published");
    expect(after?.published_at?.getTime()).toBe(beforePublished);
    expect(after?.updated_at.getTime()).toBe(beforeUpdated);
  });
});

describe("changed content re-pends", () => {
  test("published change clears published_at and returns to pending", async () => {
    const changed = await submitAs(memberA, venueLife, 4, "Lifecycle revised flavor.");

    expect(changed._tag).toBe("Updated");

    const id = updatedId(changed);
    const row = await readRow(id);

    expect(row?.status).toBe("pending");
    expect(row?.rating).toBe(4);
    expect(row?.body).toBe("Lifecycle revised flavor.");
    expect(row?.published_at).toBeNull();

    const republished = await run(
      withActor(curator, moderateRestaurantCustomerReview({ reviewId: id, status: "published" })),
    );

    expect(republished._tag).toBe("Applied");
    expect(appliedStatus(republished)).toBe("published");

    const summary = await run(getRestaurantReviewSummary(venueLife));

    expect(summary.total).toBe(1);
  });

  test("author update with identical content is a no-op", async () => {
    const current = await submitAs(memberA, venueLife, 4, "Lifecycle revised flavor.");

    expect(current._tag).toBe("Updated");

    const id = updatedId(current);
    const before = await readRow(id);
    const beforeUpdated = before?.updated_at.getTime() ?? 0;

    const edited = await run(
      withActor(
        memberA,
        updateOwnRestaurantCustomerReview({
          reviewId: id,
          rating: 4,
          body: "Lifecycle revised flavor.",
        }),
      ),
    );

    expect(JSON.stringify(edited)).not.toContain("author_id");

    const after = await readRow(id);

    expect(after?.updated_at.getTime()).toBe(beforeUpdated);
    expect(after?.status).toBe(before?.status);
  });
});

describe("rejected and removed terminal states", () => {
  test("rejected revision re-enters pending via update", async () => {
    const submitted = await submitAs(memberB, venueMod, 2, "Lifecycle salty.");

    expect(submitted._tag).toBe("Created");

    const id = createdId(submitted);

    const rejected = await run(
      withActor(curator, moderateRestaurantCustomerReview({ reviewId: id, status: "rejected" })),
    );

    expect(rejected._tag).toBe("Applied");

    const rejectedRow = await readRow(id);

    expect(rejectedRow?.status).toBe("rejected");

    const revised = await run(
      withActor(
        memberB,
        updateOwnRestaurantCustomerReview({ reviewId: id, rating: 3, body: "Lifecycle improved." }),
      ),
    );

    expect(JSON.stringify(revised)).not.toContain("author_id");

    const pendingRow = await readRow(id);

    expect(pendingRow?.status).toBe("pending");
    expect(pendingRow?.body).toBe("Lifecycle improved.");
    expect(pendingRow?.published_at).toBeNull();

    const republished = await run(
      withActor(curator, moderateRestaurantCustomerReview({ reviewId: id, status: "published" })),
    );

    expect(republished._tag).toBe("Applied");
  });

  test("submit after rejection creates a fresh row; rejected stays for audit", async () => {
    const rejectedAgain = await submitAs(memberB, venueMod, 1, "Lifecycle fresh attempt.");

    expect(rejectedAgain._tag).toBe("Updated");

    const activeId = updatedId(rejectedAgain);

    const rejected = await run(
      withActor(
        curator,
        moderateRestaurantCustomerReview({ reviewId: activeId, status: "rejected" }),
      ),
    );

    expect(rejected._tag).toBe("Applied");

    const fresh = await submitAs(memberB, venueMod, 5, "Lifecycle brand new after rejection.");

    expect(fresh._tag).toBe("Created");

    const freshId = createdId(fresh);

    expect(freshId).not.toBe(activeId);

    const oldRow = await readRow(activeId);
    const newRow = await readRow(freshId);

    expect(oldRow?.status).toBe("rejected");
    expect(newRow?.status).toBe("pending");
    expect(newRow?.body).toBe("Lifecycle brand new after rejection.");
  });

  test("removed retains audit fields with redacted body; resubmission is fresh", async () => {
    const target = await submitAs(memberB, venueMod, 5, "Lifecycle brand new after rejection.");

    expect(target._tag).toBe("Updated");

    const id = updatedId(target);
    const authorId = memberUserId(memberB);

    const removed = await run(
      withActor(memberB, deleteOwnRestaurantCustomerReview({ reviewId: id })),
    );

    expect(JSON.stringify(removed)).not.toContain("author_id");

    const removedRow = await readRow(id);

    expect(removedRow?.status).toBe("removed");
    expect(removedRow?.body).toBe("");
    expect(removedRow?.author_id).toBe(authorId);
    expect(removedRow?.venue_id).toBe(venueMod);
    expect(removedRow?.rating).toBe(5);

    const beforeUpdated = removedRow?.updated_at.getTime() ?? 0;

    const repeated = await run(
      withActor(memberB, deleteOwnRestaurantCustomerReview({ reviewId: id })),
    );

    expect(JSON.stringify(repeated)).not.toContain("author_id");

    const after = await readRow(id);

    expect(after?.status).toBe("removed");
    expect(after?.updated_at.getTime()).toBe(beforeUpdated);

    const edited = await run(
      Effect.flip(
        withActor(
          memberB,
          updateOwnRestaurantCustomerReview({ reviewId: id, rating: 5, body: "No edit." }),
        ),
      ),
    );

    expect(edited._tag).toBe("CustomerReviewConflict");

    const fresh = await submitAs(memberB, venueMod, 4, "Lifecycle after removal.");

    expect(fresh._tag).toBe("Created");

    const freshId = createdId(fresh);

    expect(freshId).not.toBe(id);

    const stillRemoved = await readRow(id);
    const freshRow = await readRow(freshId);

    expect(stillRemoved?.status).toBe("removed");
    expect(freshRow?.status).toBe("pending");

    const active = await countActive(venueMod, authorId);

    expect(active).toBe(1);
  });
});

describe("concurrent first submissions collapse", () => {
  test("two simultaneous identical submits yield one active row", async () => {
    const authorId = memberUserId(memberA);

    const before = await countActive(venueConc, authorId);

    expect(before).toBe(0);

    const [first, second] = await Promise.all([
      submitAs(memberA, venueConc, 5, "Lifecycle concurrent broth."),
      submitAs(memberA, venueConc, 5, "Lifecycle concurrent broth."),
    ]);

    const firstId = anyId(first);
    const secondId = anyId(second);

    expect(firstId).toBe(secondId);
    expect(JSON.stringify({ first, second })).not.toContain("author_id");

    const active = await countActive(venueConc, authorId);

    expect(active).toBe(1);

    const row = await readRow(firstId);

    expect(row?.status).toBe("pending");
    expect(row?.body).toBe("Lifecycle concurrent broth.");
  });
});

describe("moderation state machine and audit", () => {
  test("illegal transitions fail and repeats leave audit intact", async () => {
    const submitted = await submitAs(memberB, venueLife, 5, "Lifecycle moderation probe.");

    expect(submitted._tag).toBe("Created");

    const id = createdId(submitted);
    const auditBefore = await countAudit(id);

    const published = await run(
      withActor(curator, moderateRestaurantCustomerReview({ reviewId: id, status: "published" })),
    );

    expect(published._tag).toBe("Applied");

    const auditAfterPublish = await countAudit(id);

    expect(auditAfterPublish).toBe(auditBefore + 1);

    const repeated = await run(
      withActor(curator, moderateRestaurantCustomerReview({ reviewId: id, status: "published" })),
    );

    expect(repeated._tag).toBe("Repeated");

    const auditAfterRepeat = await countAudit(id);

    expect(auditAfterRepeat).toBe(auditAfterPublish);

    const illegal = await run(
      Effect.flip(
        withActor(curator, moderateRestaurantCustomerReview({ reviewId: id, status: "rejected" })),
      ),
    );

    expect(illegal._tag).toBe("CustomerReviewConflict");

    const auditAfterIllegal = await countAudit(id);

    expect(auditAfterIllegal).toBe(auditAfterPublish);

    const removed = await run(
      withActor(curator, moderateRestaurantCustomerReview({ reviewId: id, status: "removed" })),
    );

    expect(removed._tag).toBe("Applied");

    const terminal = await run(
      Effect.flip(
        withActor(curator, moderateRestaurantCustomerReview({ reviewId: id, status: "published" })),
      ),
    );

    expect(terminal._tag).toBe("CustomerReviewConflict");

    const pendingToRemoved = await submitAs(
      memberA,
      venueMod,
      4,
      "Lifecycle pending remove probe.",
    );

    expect(pendingToRemoved._tag).toBe("Created");

    const pendingId = createdId(pendingToRemoved);

    const directRemove = await run(
      Effect.flip(
        withActor(
          curator,
          moderateRestaurantCustomerReview({ reviewId: pendingId, status: "removed" }),
        ),
      ),
    );

    expect(directRemove._tag).toBe("CustomerReviewConflict");
  });
});

describe("authorization denials", () => {
  test("guests cannot write and strangers cannot touch others reviews", async () => {
    const guestDenied = await run(
      Effect.flip(
        withActor(
          Actor.Guest(),
          submitRestaurantCustomerReview({ venueId: venueLife, rating: 5, body: "Guest." }),
        ),
      ),
    );

    expect(guestDenied._tag).toBe("SignInRequired");

    const probe = await submitAs(memberA, venueLife, 5, "Lifecycle auth probe.");

    const probeId = anyId(probe);

    const forgedEdit = await run(
      Effect.flip(
        withActor(
          memberB,
          updateOwnRestaurantCustomerReview({ reviewId: probeId, rating: 1, body: "Hijacked." }),
        ),
      ),
    );

    expect(forgedEdit._tag).toBe("NotReviewAuthor");

    const forgedDelete = await run(
      Effect.flip(withActor(memberB, deleteOwnRestaurantCustomerReview({ reviewId: probeId }))),
    );

    expect(forgedDelete._tag).toBe("NotReviewAuthor");

    const ungranted = await run(
      Effect.flip(
        withActor(
          memberB,
          moderateRestaurantCustomerReview({ reviewId: probeId, status: "published" }),
        ),
      ),
    );

    expect(ungranted._tag).toBe("InsufficientPermissions");

    const invalid = await run(
      Effect.flip(
        withActor(
          memberA,
          submitRestaurantCustomerReview({ venueId: venueLife, rating: 6, body: "Too high." }),
        ),
      ),
    );

    expect(invalid._tag).toBe("CustomerReviewValidationFailed");
  });
});
