import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect } from "effect";
import postgres from "postgres";

import { venueWriteSchema } from "@/modules/restaurant-discovery/restaurant.schema";
import {
  getVenueSources,
  listAdminBusinesses,
  listAdminVenues,
  setVenuesStatus,
  writeVenue,
} from "@/modules/restaurant-discovery/server/operations/admin";
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

const manageRole = `pr4-venues-manage-${stamp}`;

let curator: Actor = Actor.Guest();

let manager: Actor = Actor.Guest();

const venueInput = (
  businessName: string,
  name: string,
  area: string,
  status: "draft" | "published" | "archived",
  extra?: { readonly venueId?: string; readonly businessId?: string },
) =>
  venueWriteSchema.parse({
    venueId: extra?.venueId,
    businessId: extra?.businessId,
    businessName,
    name: `${name} ${stamp}`,
    address: "Synthetic test address",
    area,
    countryCode: "VN",
    longitude: 106.7,
    latitude: 10.8,
    status,
  });

beforeAll(async () => {
  await sql`INSERT INTO feastjourney.roles(id,slug,name) VALUES (${manageRole},${manageRole},'Synthetic venues manage-only role')`;
  await sql`INSERT INTO feastjourney.role_permissions(role_id,permission_key) VALUES (${manageRole},'restaurant:manage')`;

  const curatorSession = await auth.signupSignin(`pr4-venues-curator-${stamp}`);
  await auth.grantRole(curatorSession.userId, "curator");

  const trustedCurator = await run(
    requireAuthenticatedActor(new Headers({ cookie: curatorSession.cookies })),
  );

  curator = Actor.Member({ userId: trustedCurator.userId });

  const managerSession = await auth.signupSignin(`pr4-venues-manager-${stamp}`);
  await auth.grantRole(managerSession.userId, manageRole);

  const trustedManager = await run(
    requireAuthenticatedActor(new Headers({ cookie: managerSession.cookies })),
  );

  manager = Actor.Member({ userId: trustedManager.userId });
}, 30000);

afterAll(async () => {
  await sql.begin(async (tx) => {
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
    await tx`DELETE FROM feastjourney.role_permissions WHERE role_id=${manageRole}`;
    await tx`DELETE FROM feastjourney.roles WHERE id=${manageRole}`;
  });
  await sql.end();
  await auth.close();
});

describe("restaurant dashboard venue management", () => {
  test("creates a business, adds a branch under it, and edits branch fields", async () => {
    const businessName = `RenameMe ${stamp}`;

    const created = await run(
      withActor(
        curator,
        writeVenue(venueInput(businessName, "Flagship branch", `Branch area ${stamp}`, "draft")),
      ),
    );

    // oxlint-disable-next-line typescript/no-unsafe-argument -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    venueIds.push(created.id);

    const businesses = await run(
      withActor(curator, listAdminBusinesses({ q: businessName, limit: 10, offset: 0 })),
    );

    expect(businesses.total).toBe(1);
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    const business = businesses.businesses[0];
    expect(business).toBeDefined();

    if (business === undefined) return;
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(business.venue_count).toBe(1);

    const branch = await run(
      withActor(
        curator,
        writeVenue(
          venueInput(businessName, "Second branch", `Branch area ${stamp}`, "draft", {
            // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
            businessId: business.id,
          }),
        ),
      ),
    );

    // oxlint-disable-next-line typescript/no-unsafe-argument -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    venueIds.push(branch.id);

    const edited = await run(
      withActor(
        curator,
        writeVenue(
          venueInput(businessName, "Second branch relocated", `Branch area ${stamp}`, "draft", {
            // oxlint-disable-next-line typescript/no-unsafe-assignment -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
            venueId: branch.id,
          }),
        ),
      ),
    );

    expect(edited.id).toBe(branch.id);

    const page = await run(
      withActor(
        curator,
        listAdminVenues({
          q: `Branch area ${stamp}`,
          status: "",
          business: "",
          limit: 20,
          offset: 0,
        }),
      ),
    );

    expect(page.total).toBe(2);
    // oxlint-disable-next-line typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(page.venues.map((row) => row.business_name)).toEqual([businessName, businessName]);
  });

  test("renames the business on venue edit instead of silently ignoring it", async () => {
    const renamed = `RenamedBiz ${stamp}`;

    const page = await run(
      withActor(
        curator,
        listAdminVenues({
          q: `Branch area ${stamp}`,
          status: "",
          business: "",
          limit: 20,
          offset: 0,
        }),
      ),
    );

    // oxlint-disable-next-line typescript/no-unsafe-assignment -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    const first = page.venues[0];
    expect(first).toBeDefined();

    if (first === undefined) return;

    await run(
      withActor(
        curator,
        writeVenue(
          venueInput(renamed, "Flagship branch", `Branch area ${stamp}`, "draft", {
            // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
            venueId: first.id,
          }),
        ),
      ),
    );

    const after = await run(
      withActor(
        curator,
        listAdminVenues({ q: renamed, status: "", business: "", limit: 20, offset: 0 }),
      ),
    );

    expect(after.total).toBe(2);
    // oxlint-disable-next-line typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    expect(after.venues.map((row) => row.business_name)).toEqual([renamed, renamed]);

    const stale = await run(
      withActor(
        curator,
        listAdminVenues({ q: `RenameMe ${stamp}`, status: "", business: "", limit: 20, offset: 0 }),
      ),
    );

    expect(stale.total).toBe(0);
  });

  test("paginates the venue table server-side with search and status filters", async () => {
    const area = `Paginate area ${stamp}`;

    const createdVenues = await Promise.all(
      ["Paginate one", "Paginate two", "Paginate three"].map((name) =>
        run(
          withActor(curator, writeVenue(venueInput(`Paginate biz ${stamp}`, name, area, "draft"))),
        ),
      ),
    );

    for (const created of createdVenues) {
      // oxlint-disable-next-line typescript/no-unsafe-argument -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
      venueIds.push(created.id);
    }

    const firstPage = await run(
      withActor(
        curator,
        listAdminVenues({ q: area, status: "", business: "", limit: 2, offset: 0 }),
      ),
    );

    expect(firstPage.total).toBe(3);
    expect(firstPage.venues.length).toBe(2);

    const secondPage = await run(
      withActor(
        curator,
        listAdminVenues({ q: area, status: "", business: "", limit: 2, offset: 2 }),
      ),
    );

    expect(secondPage.total).toBe(3);
    expect(secondPage.venues.length).toBe(1);

    const drafts = await run(
      withActor(
        curator,
        listAdminVenues({ q: area, status: "draft", business: "", limit: 20, offset: 0 }),
      ),
    );

    expect(drafts.total).toBe(3);

    const published = await run(
      withActor(
        curator,
        listAdminVenues({ q: area, status: "published", business: "", limit: 20, offset: 0 }),
      ),
    );

    expect(published.total).toBe(0);
    expect(published.venues).toEqual([]);
  });

  test("denies publish without restaurant:review for venue writes and bulk status", async () => {
    const deniedWrite = await run(
      Effect.flip(
        withActor(
          manager,
          writeVenue(
            venueInput(`Deny biz ${stamp}`, "Deny venue", `Deny area ${stamp}`, "published"),
          ),
        ),
      ),
    );

    expect(deniedWrite._tag).toBe("InsufficientPermissions");

    const draft = await run(
      withActor(
        manager,
        writeVenue(venueInput(`Deny biz ${stamp}`, "Deny venue", `Deny area ${stamp}`, "draft")),
      ),
    );

    // oxlint-disable-next-line typescript/no-unsafe-argument -- tsc-clean under live-DB Reylo: checker cannot resolve Effect/Reylo generics here
    venueIds.push(draft.id);

    const deniedBulk = await run(
      Effect.flip(withActor(manager, setVenuesStatus({ ids: [draft.id], status: "published" }))),
    );

    expect(deniedBulk._tag).toBe("InsufficientPermissions");

    const archived = await run(
      withActor(manager, setVenuesStatus({ ids: [draft.id], status: "archived" })),
    );

    expect(archived.updated).toEqual([draft.id]);

    const guestDenied = await run(
      Effect.flip(
        withActor(
          Actor.Guest(),
          listAdminVenues({ q: "", status: "", business: "", limit: 20, offset: 0 }),
        ),
      ),
    );

    expect(guestDenied._tag).toBe("InsufficientPermissions");
  });

  test("returns provenance summaries per venue", async () => {
    const first = venueIds[0];
    expect(first).toBeDefined();

    if (first === undefined) return;

    const rows = await run(withActor(curator, getVenueSources({ venueId: first, limit: 10 })));
    expect(Array.isArray(rows)).toBe(true);
  });
});
