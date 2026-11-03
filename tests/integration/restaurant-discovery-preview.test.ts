import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect } from "effect";
import postgres from "postgres";
import { z } from "zod";

import { DishService } from "@/modules/food-discovery/server/index";
import {
  menuImportSchema,
  venueWriteSchema,
} from "@/modules/restaurant-discovery/restaurant.schema";
import type { MenuImport } from "@/modules/restaurant-discovery/restaurant.schema";
// Direct operation imports: server/index.ts is coordinator-owned and
// currently re-exports another agent's unmigrated customer-reviews work,
// whose Reylo analysis fails until their migration lands.
import {
  importMenu,
  reviewObservation,
  writeVenue,
} from "@/modules/restaurant-discovery/server/operations/admin";
import {
  getRestaurant,
  listVenuePhotoPreviews,
} from "@/modules/restaurant-discovery/server/operations/discovery";
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

/** DB-returned photo id at the fixture I/O boundary: uuid text or loud failure. */
const photoIdSchema = z.uuid();
const stamp = crypto.randomUUID().slice(0, 8);
const area = `Preview synthetic ${stamp}`;
const venueIds: Array<string> = [];
let curator: Actor = Actor.Guest();
let dishId = "";
let venueA = "";
let venueB = "";
let linkedItemId = "";

const source = (key: string) => ({
  category: "official_menu" as const,
  url: "https://example.com/synthetic-preview-menu",
  deduplicationKey: `${stamp}:${key}`,
  restaurantVerified: false,
  observedAt: new Date(Date.now() - 86400000).toISOString(),
  validUntil: new Date(Date.now() + 29 * 86400000).toISOString(),
});

const menuInput = (venueId: string): MenuImport =>
  menuImportSchema.parse({
    venueId,
    menuName: "Synthetic preview menu",
    source: source("preview"),
    items: [
      {
        name: "Synthetic linked noodle",
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
      {
        name: "Synthetic plain rice",
        variants: [{ name: "As listed", comparisonKey: "plain" }],
      },
    ],
  });

const insertPhoto = async (
  venueId: string,
  status: string,
  processing: string,
  sortOrder: number,
  alt: string | null,
): Promise<string> => {
  const photoId = crypto.randomUUID();

  const rows = await sql`
    INSERT INTO feastjourney.restaurant_photos
      (id, venue_id, object_key, status, processing, alt_text,
       original_width, original_height, sort_order, variant_version)
    VALUES
      (${photoId}, ${venueId},
       ${`restaurant-photos/${venueId}/${photoId}/1`},
       ${status}, ${processing}, ${alt}, 1200, 800, ${sortOrder}, 1)
    RETURNING id::text AS id`;

  const id: unknown = rows[0]?.id;

  return photoIdSchema.parse(id);
};

beforeAll(async () => {
  const session = await auth.signupSignin(`preview-curator-${stamp}`);
  await auth.grantRole(session.userId, "curator");
  const trusted = await run(requireAuthenticatedActor(new Headers({ cookie: session.cookies })));

  curator = Actor.Member({ userId: trusted.userId });
  const dish = await run(Effect.flatMap(DishService, (service) => service.getDish("pho-bo", "en")));

  dishId = dish.id;

  const makeVenue = async (name: string): Promise<string> => {
    const created = await run(
      withActor(
        curator,
        writeVenue(
          venueWriteSchema.parse({
            businessName: "Synthetic preview business",
            name: `${name} ${stamp}`,
            address: "Synthetic test address",
            area,
            countryCode: "VN",
            longitude: 106.7,
            latitude: 10.8,
            status: "published",
          }),
        ),
      ),
    );

    // SAFETY: writeVenue returns the created venue row; id is its UUID primary key.
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- tsc-clean under live-DB Reylo; the checker cannot resolve Effect/Reylo generics here
    const createdId: string = created.id;

    venueIds.push(createdId);

    return createdId;
  };

  venueA = await makeVenue("Preview venue A");
  venueB = await makeVenue("Preview venue B");

  const imported = await run(withActor(curator, importMenu(menuInput(venueA))));

  await Promise.all(
    imported.priceIds.map((id) =>
      run(withActor(curator, reviewObservation({ kind: "price", id, status: "approved" }))),
    ),
  );
  await Promise.all(
    imported.evidenceIds.map((id) =>
      run(withActor(curator, reviewObservation({ kind: "serving", id, status: "approved" }))),
    ),
  );

  const linked = imported.offeringIds[0];

  if (linked === undefined) throw new Error("Missing linked fixture offering");

  // Section keys are set at item insert time (the identity trigger freezes
  // all but status afterwards), so the sectioned fixture is inserted
  // directly in published form, matching what the editor produces.
  const sectionMenuId = crypto.randomUUID();
  const sectionItemId = crypto.randomUUID();

  await sql`INSERT INTO feastjourney.restaurant_menus (id, venue_id, name, status)
    VALUES (${sectionMenuId}, ${venueA}, 'Synthetic section menu', 'published')`;
  await sql`INSERT INTO feastjourney.restaurant_menu_items
      (id, venue_id, menu_id, name, status, section_key)
    VALUES (${sectionItemId}, ${venueA}, ${sectionMenuId}, 'Synthetic sectioned item', 'published', 'noodles')`;
  await sql`INSERT INTO feastjourney.restaurant_menu_item_variants
      (venue_id, menu_item_id, name, status)
    VALUES (${venueA}, ${sectionItemId}, 'As listed', 'published')`;

  linkedItemId = sectionItemId;

  // Five publishable rows plus one row per exclusion gate. Inserts run
  // concurrently; sort order comes from the explicit index, not timing.
  const publishable = await Promise.all(
    Array.from({ length: 5 }, (_, order) =>
      insertPhoto(venueA, "published", "ready", order, `Preview photo ${order}`),
    ),
  );

  expect(publishable).toHaveLength(5);

  await Promise.all([
    insertPhoto(venueA, "draft", "ready", 5, "Draft photo"),
    insertPhoto(venueA, "review", "ready", 6, "Review photo"),
    insertPhoto(venueA, "published", "processing", 7, "Processing photo"),
    insertPhoto(venueA, "published", "failed", 8, "Failed photo"),
    insertPhoto(venueA, "published", "ready", 9, null),
  ]);
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
    await tx`DELETE FROM feastjourney.restaurant_photos WHERE venue_id=ANY(${venueIds}::uuid[])`;
    await tx`WITH removed AS (DELETE FROM feastjourney.restaurant_venues WHERE id=ANY(${venueIds}::uuid[]) RETURNING business_id)
      DELETE FROM feastjourney.restaurant_businesses WHERE id IN(SELECT business_id FROM removed)`;
  });
  await sql.end();
  await auth.close();
});

describe("restaurant discovery preview payload", () => {
  test("detail carries only published ready photos with alt text and dimensions", async () => {
    const detail = await run(getRestaurant(venueA, "dine_in"));

    expect(detail.photos).toHaveLength(5);
    expect(detail.photos.every((photo) => photo.alt.startsWith("Preview photo"))).toBe(true);

    const [first] = detail.photos;

    expect(first?.primary).toBe(true);
    expect(detail.photos.slice(1).every((photo) => !photo.primary)).toBe(true);
    expect(
      detail.photos.every((photo) =>
        photo.variants.every((variant) =>
          variant.url.startsWith(`/api/v1/restaurant-images/${photo.assetId}/1/`),
        ),
      ),
    ).toBe(true);
  });

  test("detail exposes arrangement sections for published items only", async () => {
    const detail = await run(getRestaurant(venueA, "dine_in"));

    // SAFETY: getRestaurant returns Reylo-inferred venue/offering/section rows; tsc verifies the shape against the live DB.
    // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo; the checker cannot resolve Effect/Reylo generics here
    const offeringIds = new Set(detail.offerings.map((offering) => offering.item_id));

    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo; the checker cannot resolve Effect/Reylo generics here
    expect(detail.sections.length).toBeGreaterThan(0);
    // oxlint-disable-next-line typescript/no-unsafe-call, typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo; the checker cannot resolve Effect/Reylo generics here
    expect(detail.sections.find((section) => section.id === linkedItemId)?.section_key).toBe(
      "noodles",
    );
    // oxlint-disable-next-line typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo; the checker cannot resolve Effect/Reylo generics here
    expect(detail.sections.every((section) => offeringIds.has(section.id))).toBe(true);
  });

  test("empty venue exposes empty photos and sections without failing", async () => {
    const detail = await run(getRestaurant(venueB, "dine_in"));

    expect(detail.offerings).toEqual([]);
    expect(detail.photos).toEqual([]);
    expect(detail.sections).toEqual([]);
  });

  test("unknown venue id fails typed instead of returning empty success", async () => {
    const failure = await run(Effect.flip(getRestaurant(crypto.randomUUID(), "dine_in")));

    expect(failure._tag).toBe("RestaurantNotFound");
  });

  test("preview read attaches batched photos with per-venue caps", async () => {
    const unknown = crypto.randomUUID();
    const first = await run(listVenuePhotoPreviews({ venueIds: [venueA, venueB, unknown] }));
    const second = await run(listVenuePhotoPreviews({ venueIds: [venueA, venueB, unknown] }));

    expect(second).toEqual(first);
    expect(first.map((entry) => entry.venueId)).toEqual([venueA, venueB, unknown]);
    expect(first[0]?.photos).toHaveLength(3);
    expect(first[0]?.photos[0]?.primary).toBe(true);
    expect(first[1]?.photos).toEqual([]);
    expect(first[2]?.photos).toEqual([]);
  });

  test("preview read rejects unbounded or malformed input typed", async () => {
    const malformed = await run(Effect.flip(listVenuePhotoPreviews({ venueIds: ["not-a-uuid"] })));

    expect(malformed._tag).toBe("RestaurantInputError");

    const empty = await run(Effect.flip(listVenuePhotoPreviews({ venueIds: [] })));

    expect(empty._tag).toBe("RestaurantInputError");

    const oversized = await run(
      Effect.flip(
        listVenuePhotoPreviews({ venueIds: Array.from({ length: 51 }, () => crypto.randomUUID()) }),
      ),
    );

    expect(oversized._tag).toBe("RestaurantInputError");
  });
});
