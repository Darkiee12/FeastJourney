import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect } from "effect";
import postgres from "postgres";

import { DishService } from "@/modules/food-discovery/server/index";
import {
  menuImportSchema,
  venueWriteSchema,
} from "@/modules/restaurant-discovery/restaurant.schema";
import {
  importMenu,
  reviewObservation,
  writeVenue,
} from "@/modules/restaurant-discovery/server/index";
import {
  decideObservation,
  getReviewItem,
  listReviewContributions,
  listReviewQueue,
} from "@/modules/restaurant-discovery/server/operations/review";
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

const manageRole = `pr4-reviewq-manage-${stamp}`;

const reviewRole = `pr4-reviewq-review-${stamp}`;

let curator: Actor = Actor.Guest();

let manager: Actor = Actor.Guest();

let reviewer: Actor = Actor.Guest();

let member: Actor = Actor.Guest();

let reviewerUserId = "";

let priceIds: Array<string> = [];

let servingIds: Array<string> = [];

let itemIds: Array<string> = [];

let venueName = "";

const memberOf = async (name: string, roleId?: string): Promise<Actor> => {
  const session = await auth.signupSignin(`${name}-${stamp}`);

  if (roleId !== undefined) {
    await auth.grantRole(session.userId, roleId);
  }

  const trusted = await run(requireAuthenticatedActor(new Headers({ cookie: session.cookies })));

  return Actor.Member({ userId: trusted.userId });
};

beforeAll(async () => {
  await sql`INSERT INTO feastjourney.roles(id,slug,name) VALUES (${manageRole},${manageRole},'Synthetic review-queue manage-only role')`;

  await sql`INSERT INTO feastjourney.roles(id,slug,name) VALUES (${reviewRole},${reviewRole},'Synthetic review-queue review-only role')`;

  await sql`INSERT INTO feastjourney.role_permissions(role_id,permission_key) VALUES (${manageRole},'restaurant:manage')`;

  await sql`INSERT INTO feastjourney.role_permissions(role_id,permission_key) VALUES (${reviewRole},'restaurant:review')`;

  const curatorSession = await auth.signupSignin(`pr4-reviewq-curator-${stamp}`);

  await auth.grantRole(curatorSession.userId, "curator");

  const trustedCurator = await run(
    requireAuthenticatedActor(new Headers({ cookie: curatorSession.cookies })),
  );

  curator = Actor.Member({ userId: trustedCurator.userId });

  manager = await memberOf("pr4-reviewq-manager", manageRole);

  const reviewerSession = await auth.signupSignin(`pr4-reviewq-reviewer-${stamp}`);

  await auth.grantRole(reviewerSession.userId, reviewRole);

  const trustedReviewer = await run(
    requireAuthenticatedActor(new Headers({ cookie: reviewerSession.cookies })),
  );

  reviewer = Actor.Member({ userId: trustedReviewer.userId });
  reviewerUserId = trustedReviewer.userId;

  member = await memberOf("pr4-reviewq-member");

  const dish = await run(Effect.flatMap(DishService, (service) => service.getDish("pho-bo", "en")));

  venueName = `Review queue venue ${stamp}`;

  const venue = await run(
    withActor(
      curator,
      writeVenue(
        venueWriteSchema.parse({
          businessName: "Synthetic review-queue business",
          name: venueName,
          address: "Synthetic review-queue address",
          area: `Review area ${stamp}`,
          countryCode: "VN",
          longitude: 106.7,
          latitude: 10.8,
          status: "draft",
        }),
      ),
    ),
  );

  // oxlint-disable-next-line typescript/no-unsafe-argument -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here; identical pattern passes in restaurants.test.ts
  venueIds.push(venue.id);

  const imported = await run(
    withActor(
      curator,
      importMenu(
        menuImportSchema.parse({
          // oxlint-disable-next-line typescript/no-unsafe-assignment -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here; identical pattern passes in restaurants.test.ts
          venueId: venue.id,
          menuName: "Synthetic review-queue menu",
          source: {
            category: "official_menu",
            url: "https://example.com/synthetic-review-queue",
            deduplicationKey: `${stamp}:review-queue`,
            restaurantVerified: false,
            observedAt: new Date(Date.now() - 86400000).toISOString(),
            validUntil: new Date(Date.now() + 29 * 86400000).toISOString(),
          },
          items: [0, 1, 2].map((index) => ({
            name: `Synthetic queue offering ${index}`,
            dishId: dish.id,
            matchKind: "exact",
            variants: [
              {
                name: "Regular bowl",
                comparisonKey: "regular-bowl",
                price: {
                  amount: "55000",
                  currency: "VND",
                  kind: "listed",
                  channel: "dine_in",
                  taxTreatment: "included",
                  sourceLineKey: `queue-${index}`,
                },
              },
            ],
          })),
        }),
      ),
    ),
  );

  // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
  priceIds = imported.priceIds;
  // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
  servingIds = imported.evidenceIds;
  // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
  itemIds = imported.offeringIds.map((offering) => offering.itemId);

  expect(priceIds.length).toBe(3);
  expect(servingIds.length).toBe(3);
}, 30000);

afterAll(async () => {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM feastjourney.restaurant_receipt_lines WHERE observation_id IN(SELECT id FROM feastjourney.restaurant_price_observations WHERE venue_id=ANY(${venueIds}::uuid[]))`;

    await tx`DELETE FROM feastjourney.restaurant_price_observations WHERE venue_id=ANY(${venueIds}::uuid[])`;

    await tx`DELETE FROM feastjourney.restaurant_serving_evidence WHERE venue_id=ANY(${venueIds}::uuid[])`;

    await tx`DELETE FROM feastjourney.restaurant_sources WHERE venue_id=ANY(${venueIds}::uuid[])`;

    await tx`DELETE FROM feastjourney.restaurant_menu_item_variants WHERE venue_id=ANY(${venueIds}::uuid[])`;

    await tx`DELETE FROM feastjourney.restaurant_menu_items WHERE venue_id=ANY(${venueIds}::uuid[])`;

    await tx`DELETE FROM feastjourney.restaurant_menus WHERE venue_id=ANY(${venueIds}::uuid[])`;

    await tx`DELETE FROM feastjourney.restaurant_venue_names WHERE venue_id=ANY(${venueIds}::uuid[])`;

    await tx`DELETE FROM feastjourney.restaurant_venue_cuisines WHERE venue_id=ANY(${venueIds}::uuid[])`;

    await tx`WITH removed AS (DELETE FROM feastjourney.restaurant_venues WHERE id=ANY(${venueIds}::uuid[]) RETURNING business_id)
      DELETE FROM feastjourney.restaurant_businesses WHERE id IN(SELECT business_id FROM removed)`;

    await tx`DELETE FROM feastjourney.roles WHERE id IN(${manageRole},${reviewRole})`;
  });

  await sql.end();

  await auth.close();
});

describe("review queue pagination and search", () => {
  test("pages are pending-first with server-side totals", async () => {
    const first = await run(
      withActor(
        reviewer,
        listReviewQueue({
          venue: "",
          kind: "all",
          status: "pending",
          from: null,
          to: null,
          limit: 2,
          offset: 0,
        }),
      ),
    );

    expect(first.total).toBeGreaterThanOrEqual(6);
    expect(first.items.length).toBe(2);

    for (const entry of first.items) {
      // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
      expect(entry.review_status).toBe("pending");
    }

    const second = await run(
      withActor(
        reviewer,
        listReviewQueue({
          venue: "",
          kind: "all",
          status: "pending",
          from: null,
          to: null,
          limit: 2,
          offset: 2,
        }),
      ),
    );

    expect(second.total).toBe(first.total);

    // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    const firstIds = new Set(first.items.map((entry) => entry.id));

    for (const entry of second.items) {
      // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
      expect(firstIds.has(entry.id)).toBe(false);
    }
  });

  test("evidence-type and branch filters narrow the page", async () => {
    const prices = await run(
      withActor(
        reviewer,
        listReviewQueue({
          venue: "",
          kind: "price",
          status: "pending",
          from: null,
          to: null,
          limit: 100,
          offset: 0,
        }),
      ),
    );

    expect(prices.total).toBeGreaterThanOrEqual(3);

    for (const entry of prices.items) {
      // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
      expect(entry.kind).toBe("price");
    }

    const servings = await run(
      withActor(
        reviewer,
        listReviewQueue({
          venue: "",
          kind: "serving",
          status: "pending",
          from: null,
          to: null,
          limit: 100,
          offset: 0,
        }),
      ),
    );

    expect(servings.total).toBeGreaterThanOrEqual(3);

    for (const entry of servings.items) {
      // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
      expect(entry.kind).toBe("serving");
    }

    const branch = await run(
      withActor(
        reviewer,
        listReviewQueue({
          venue: venueName.slice(0, 12),
          kind: "all",
          status: "pending",
          from: null,
          to: null,
          limit: 100,
          offset: 0,
        }),
      ),
    );

    expect(branch.total).toBeGreaterThanOrEqual(6);

    for (const entry of branch.items) {
      // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
      expect(entry.venue).toContain("Review queue venue");
    }

    const missing = await run(
      withActor(
        reviewer,
        listReviewQueue({
          venue: "no-such-branch-anywhere",
          kind: "all",
          status: "pending",
          from: null,
          to: null,
          limit: 25,
          offset: 0,
        }),
      ),
    );

    expect(missing.total).toBe(0);
    expect(missing.items).toEqual([]);
  });

  test("observation-date bounds filter the page", async () => {
    const future = await run(
      withActor(
        reviewer,
        listReviewQueue({
          venue: "",
          kind: "all",
          status: "pending",
          from: new Date(Date.now() + 86400000).toISOString(),
          to: null,
          limit: 25,
          offset: 0,
        }),
      ),
    );

    expect(future.total).toBe(0);

    const windowed = await run(
      withActor(
        reviewer,
        listReviewQueue({
          venue: "",
          kind: "all",
          status: "pending",
          from: new Date(Date.now() - 2 * 86400000).toISOString(),
          to: new Date(Date.now()).toISOString(),
          limit: 100,
          offset: 0,
        }),
      ),
    );

    expect(windowed.total).toBeGreaterThanOrEqual(6);
  });

  test("invalid pages and bounds fail explicitly", async () => {
    const badLimit = await run(
      Effect.flip(
        withActor(
          reviewer,
          listReviewQueue({
            venue: "",
            kind: "all",
            status: "pending",
            from: null,
            to: null,
            limit: 0,
            offset: 0,
          }),
        ),
      ),
    );

    expect(badLimit._tag).toBe("RestaurantInputError");

    const badRange = await run(
      Effect.flip(
        withActor(
          reviewer,
          listReviewQueue({
            venue: "",
            kind: "all",
            status: "pending",
            from: new Date(Date.now()).toISOString(),
            to: new Date(Date.now() - 86400000).toISOString(),
            limit: 25,
            offset: 0,
          }),
        ),
      ),
    );

    expect(badRange._tag).toBe("RestaurantInputError");
  });
});

const probeReviewReads = async (actor: Actor) => {
  const queue = await run(
    Effect.flip(
      withActor(
        actor,
        listReviewQueue({
          venue: "",
          kind: "all",
          status: "pending",
          from: null,
          to: null,
          limit: 25,
          offset: 0,
        }),
      ),
    ),
  );

  const contributions = await run(
    Effect.flip(
      withActor(
        actor,
        listReviewContributions({
          venue: "",
          status: "all",
          from: null,
          to: null,
          limit: 25,
          offset: 0,
        }),
      ),
    ),
  );

  const detail = await run(
    Effect.flip(withActor(actor, getReviewItem({ kind: "price", id: priceIds[0] ?? "" }))),
  );

  return { queue, contributions, detail };
};

describe("review surface requires restaurant:review", () => {
  test("manage-only, plain member and guest actors are denied every review read", async () => {
    const readers = [manager, member, Actor.Guest()];

    const results = await Promise.all(readers.map(probeReviewReads));

    for (const result of results) {
      expect(result.queue._tag).toBe("InsufficientPermissions");
      expect(result.contributions._tag).toBe("InsufficientPermissions");
      expect(result.detail._tag).toBe("InsufficientPermissions");
    }
  });

  test("manage-only actors are denied on every observation publish path", async () => {
    const priceId = priceIds[0] ?? "";
    const servingId = servingIds[0] ?? "";

    const priceApprove = await run(
      Effect.flip(
        withActor(manager, reviewObservation({ kind: "price", id: priceId, status: "approved" })),
      ),
    );

    expect(priceApprove._tag).toBe("InsufficientPermissions");

    const priceReject = await run(
      Effect.flip(
        withActor(manager, reviewObservation({ kind: "price", id: priceId, status: "rejected" })),
      ),
    );

    expect(priceReject._tag).toBe("InsufficientPermissions");

    const servingApprove = await run(
      Effect.flip(
        withActor(
          manager,
          reviewObservation({ kind: "serving", id: servingId, status: "approved" }),
        ),
      ),
    );

    expect(servingApprove._tag).toBe("InsufficientPermissions");

    const servingReject = await run(
      Effect.flip(
        withActor(
          manager,
          reviewObservation({ kind: "serving", id: servingId, status: "rejected" }),
        ),
      ),
    );

    expect(servingReject._tag).toBe("InsufficientPermissions");

    const decideDenied = await run(
      Effect.flip(
        withActor(manager, decideObservation({ kind: "price", id: priceId, status: "approved" })),
      ),
    );

    expect(decideDenied._tag).toBe("InsufficientPermissions");
  });

  test("review-only actors can decide without holding manage", async () => {
    const priceId = priceIds[1] ?? "";

    const decided = await run(
      withActor(reviewer, decideObservation({ kind: "price", id: priceId, status: "rejected" })),
    );

    expect(decided.status).toBe("rejected");
    expect(decided.repeated).toBe(false);
  });
});

describe("review decisions are idempotent and conflict-safe", () => {
  test("repeating a decision succeeds; conflicting with it fails", async () => {
    const priceId = priceIds[2] ?? "";

    const decided = await run(
      withActor(reviewer, decideObservation({ kind: "price", id: priceId, status: "approved" })),
    );

    expect(decided.status).toBe("approved");
    expect(decided.repeated).toBe(false);

    const repeated = await run(
      withActor(reviewer, decideObservation({ kind: "price", id: priceId, status: "approved" })),
    );

    expect(repeated.status).toBe("approved");
    expect(repeated.repeated).toBe(true);

    const conflict = await run(
      Effect.flip(
        withActor(reviewer, decideObservation({ kind: "price", id: priceId, status: "rejected" })),
      ),
    );

    expect(conflict._tag).toBe("ReviewConflict");
  });

  test("approval publishes eligible drafts and records the reviewer trail", async () => {
    const detail = await run(
      withActor(reviewer, getReviewItem({ kind: "price", id: priceIds[2] ?? "" })),
    );

    expect(detail.review_status).toBe("approved");
    expect(detail.reviewed_by).toBe(reviewerUserId);

    const statuses = await sql<
      Array<{ status: string }>
    >`SELECT status FROM feastjourney.restaurant_menu_items WHERE id=ANY(${itemIds}::uuid[])`;

    expect(statuses.some((row) => row.status === "published")).toBe(true);
  });

  test("unknown observations fail closed", async () => {
    const missing = crypto.randomUUID();

    const detail = await run(
      Effect.flip(withActor(reviewer, getReviewItem({ kind: "price", id: missing }))),
    );

    expect(detail._tag).toBe("ReviewNotFound");

    const decision = await run(
      Effect.flip(
        withActor(
          reviewer,
          decideObservation({ kind: "serving", id: missing, status: "approved" }),
        ),
      ),
    );

    expect(decision._tag).toBe("ReviewNotFound");
  });
});

describe("contribution queue pagination", () => {
  test("review-capable actors receive a paged contribution queue", async () => {
    const page = await run(
      withActor(
        reviewer,
        listReviewContributions({
          venue: "",
          status: "all",
          from: null,
          to: null,
          limit: 25,
          offset: 0,
        }),
      ),
    );

    expect(page.limit).toBe(25);
    expect(page.offset).toBe(0);
    expect(page.total).toBe(page.items.length);
  });

  test("contribution filters reject invalid pages", async () => {
    const denied = await run(
      Effect.flip(
        withActor(
          reviewer,
          listReviewContributions({
            venue: "",
            status: "all",
            from: null,
            to: null,
            limit: 200,
            offset: 0,
          }),
        ),
      ),
    );

    expect(denied._tag).toBe("RestaurantInputError");
  });
});
