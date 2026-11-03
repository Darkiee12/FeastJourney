import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect } from "effect";
import postgres from "postgres";

import { DishService } from "@/modules/food-discovery/server/index";
import {
  menuImportSchema,
  venueWriteSchema,
} from "@/modules/restaurant-discovery/restaurant.schema";
import type { MenuImport } from "@/modules/restaurant-discovery/restaurant.schema";
import {
  importMenu,
  restaurantAdminData,
  reviewObservation,
  setMenuStatus,
  setOfferingStatus,
  writeVenue,
} from "@/modules/restaurant-discovery/server/index";
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

const manageRole = `pr4-gating-manage-${stamp}`;

const reviewRole = `pr4-gating-review-${stamp}`;

let curator: Actor = Actor.Guest();

let manager: Actor = Actor.Guest();

let reviewer: Actor = Actor.Guest();

let member: Actor = Actor.Guest();

let dishId = "";

let menuId = "";

let itemId = "";

let variantId = "";

const memberOf = async (name: string, roleId?: string): Promise<Actor> => {
  const session = await auth.signupSignin(`${name}-${stamp}`);

  if (roleId !== undefined) {
    await auth.grantRole(session.userId, roleId);
  }

  const trusted = await run(requireAuthenticatedActor(new Headers({ cookie: session.cookies })));

  return Actor.Member({ userId: trusted.userId });
};

const venueInput = (name: string, status: "draft" | "published" | "archived") =>
  venueWriteSchema.parse({
    businessName: "Synthetic gating business",
    name: `${name} ${stamp}`,
    address: "Synthetic test address",
    area: `Gating area ${stamp}`,
    countryCode: "VN",
    longitude: 106.7,
    latitude: 10.8,
    status,
  });

beforeAll(async () => {
  await sql`INSERT INTO feastjourney.roles(id,slug,name) VALUES (${manageRole},${manageRole},'Synthetic manage-only role')`;

  await sql`INSERT INTO feastjourney.roles(id,slug,name) VALUES (${reviewRole},${reviewRole},'Synthetic review-only role')`;

  await sql`INSERT INTO feastjourney.role_permissions(role_id,permission_key) VALUES (${manageRole},'restaurant:manage')`;

  await sql`INSERT INTO feastjourney.role_permissions(role_id,permission_key) VALUES (${reviewRole},'restaurant:review')`;

  const curatorSession = await auth.signupSignin(`pr4-gating-curator-${stamp}`);

  await auth.grantRole(curatorSession.userId, "curator");

  const trustedCurator = await run(
    requireAuthenticatedActor(new Headers({ cookie: curatorSession.cookies })),
  );

  curator = Actor.Member({ userId: trustedCurator.userId });

  manager = await memberOf("pr4-gating-manager", manageRole);

  reviewer = await memberOf("pr4-gating-reviewer", reviewRole);

  member = await memberOf("pr4-gating-member");

  const dish = await run(Effect.flatMap(DishService, (service) => service.getDish("pho-bo", "en")));

  dishId = dish.id;

  const venue = await run(withActor(curator, writeVenue(venueInput("Gating venue", "draft"))));

  // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-assignment -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here; identical pattern passes in restaurants.test.ts
  venueIds.push(venue.id);

  const request: MenuImport = menuImportSchema.parse({
    // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-assignment -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here; identical pattern passes in restaurants.test.ts
    venueId: venue.id,
    menuName: "Synthetic gating menu",
    source: {
      category: "official_menu",
      url: "https://example.com/synthetic-gating-menu",
      deduplicationKey: `${stamp}:gating`,
      restaurantVerified: false,
      observedAt: new Date(Date.now() - 86400000).toISOString(),
      validUntil: new Date(Date.now() + 29 * 86400000).toISOString(),
    },
    items: [
      {
        name: "Synthetic gating offering",
        dishId,
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
              sourceLineKey: "regular",
            },
          },
        ],
      },
    ],
  });

  const imported = await run(withActor(curator, importMenu(request)));

  // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-assignment -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here; identical pattern passes in restaurants.test.ts
  menuId = imported.menuId;

  const offering = imported.offeringIds[0];

  if (offering === undefined) {
    throw new Error("Missing gating offering fixture");
  }

  itemId = offering.itemId;

  variantId = offering.variantId;
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

describe("publication requires review as well as management", () => {
  test("publishing a venue requires restaurant:review", async () => {
    const failures = await Promise.all(
      [manager, reviewer, member, Actor.Guest()].map((actor) =>
        run(
          Effect.flip(withActor(actor, writeVenue(venueInput("Published attempt", "published")))),
        ),
      ),
    );

    for (const failure of failures) {
      expect(failure._tag).toBe("InsufficientPermissions");
    }

    const created = await run(withActor(curator, writeVenue(venueInput("Published", "published"))));

    // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-assignment -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here; identical pattern passes in restaurants.test.ts
    venueIds.push(created.id);

    expect(created.id).toBeString();
  });

  test("a manage-only actor can still stage drafts and archive venues", async () => {
    const draft = await run(withActor(manager, writeVenue(venueInput("Staged", "draft"))));

    // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-assignment -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here; identical pattern passes in restaurants.test.ts
    venueIds.push(draft.id);

    expect(draft.id).toBeString();

    const archived = await run(withActor(manager, writeVenue(venueInput("Retired", "archived"))));

    // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-assignment -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here; identical pattern passes in restaurants.test.ts
    venueIds.push(archived.id);

    expect(archived.id).toBeString();
  });

  test("publishing a menu requires restaurant:review; archiving stays manage-only", async () => {
    const denied = await run(
      Effect.flip(withActor(manager, setMenuStatus({ menuId, status: "published" }))),
    );

    expect(denied._tag).toBe("InsufficientPermissions");

    const reviewerDenied = await run(
      Effect.flip(withActor(reviewer, setMenuStatus({ menuId, status: "published" }))),
    );

    expect(reviewerDenied._tag).toBe("InsufficientPermissions");

    const guestDenied = await run(
      Effect.flip(withActor(Actor.Guest(), setMenuStatus({ menuId, status: "published" }))),
    );

    expect(guestDenied._tag).toBe("InsufficientPermissions");

    const archived = await run(withActor(manager, setMenuStatus({ menuId, status: "archived" })));

    expect(archived.id).toBe(menuId);

    const published = await run(withActor(curator, setMenuStatus({ menuId, status: "published" })));

    expect(published.id).toBe(menuId);
  });

  test("publishing items and variants stays review-gated", async () => {
    const itemDenied = await run(
      Effect.flip(
        withActor(manager, setOfferingStatus({ kind: "item", id: itemId, status: "published" })),
      ),
    );

    expect(itemDenied._tag).toBe("InsufficientPermissions");

    const variantDenied = await run(
      Effect.flip(
        withActor(
          manager,
          setOfferingStatus({ kind: "variant", id: variantId, status: "published" }),
        ),
      ),
    );

    expect(variantDenied._tag).toBe("InsufficientPermissions");

    await run(
      withActor(curator, setOfferingStatus({ kind: "item", id: itemId, status: "published" })),
    );

    await run(
      withActor(
        curator,
        setOfferingStatus({ kind: "variant", id: variantId, status: "published" }),
      ),
    );
  });

  test("observation approval still requires restaurant:review", async () => {
    const venue = await run(withActor(curator, writeVenue(venueInput("Review check", "draft"))));

    // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-assignment -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here; identical pattern passes in restaurants.test.ts
    venueIds.push(venue.id);

    const imported = await run(
      withActor(
        curator,
        importMenu(
          menuImportSchema.parse({
            // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-assignment -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here; identical pattern passes in restaurants.test.ts
            venueId: venue.id,
            menuName: "Synthetic review menu",
            source: {
              category: "official_menu",
              url: "https://example.com/synthetic-review-menu",
              deduplicationKey: `${stamp}:review-check`,
              restaurantVerified: false,
              observedAt: new Date(Date.now() - 86400000).toISOString(),
              validUntil: new Date(Date.now() + 29 * 86400000).toISOString(),
            },
            items: [
              {
                name: "Synthetic review offering",
                dishId,
                matchKind: "exact",
                variants: [
                  {
                    name: "Regular bowl",
                    comparisonKey: "regular-bowl",
                    price: {
                      amount: "65000",
                      currency: "VND",
                      kind: "listed",
                      channel: "dine_in",
                      taxTreatment: "included",
                      sourceLineKey: "regular",
                    },
                  },
                ],
              },
            ],
          }),
        ),
      ),
    );

    const priceId = imported.priceIds[0];

    if (priceId === undefined) {
      throw new Error("Missing review fixture price");
    }

    const denied = await run(
      Effect.flip(
        withActor(manager, reviewObservation({ kind: "price", id: priceId, status: "approved" })),
      ),
    );

    expect(denied._tag).toBe("InsufficientPermissions");

    await run(
      withActor(curator, reviewObservation({ kind: "price", id: priceId, status: "approved" })),
    );
  });
});

describe("review queue reads are review-gated", () => {
  test("manage-only callers receive venues but no review queue", async () => {
    const data = await run(withActor(manager, restaurantAdminData));

    expect(data.canReview).toBe(false);

    expect(data.queue).toEqual([]);

    expect(Array.isArray(data.venues)).toBe(true);
  });

  test("review-capable callers receive the review queue", async () => {
    const data = await run(withActor(curator, restaurantAdminData));

    expect(data.canReview).toBe(true);

    expect(Array.isArray(data.queue)).toBe(true);
  });

  test("review-only actors cannot load the manage-scoped admin surface", async () => {
    const failure = await run(Effect.flip(withActor(reviewer, restaurantAdminData)));

    expect(failure._tag).toBe("InsufficientPermissions");
  });

  test("guests cannot load the admin surface", async () => {
    const failure = await run(Effect.flip(withActor(Actor.Guest(), restaurantAdminData)));

    expect(failure._tag).toBe("InsufficientPermissions");
  });
});
