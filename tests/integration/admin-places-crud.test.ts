// oxlint-disable-next-line import/no-unassigned-import -- side-effectful test environment setup, runs before server modules initialize.
import "./cleanup";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { SQL } from "bun";
import { Effect } from "effect";

import {
  InvalidRelationship,
  InvalidSearchFilter,
  PlaceNotFound,
} from "@/modules/food-discovery/server/domain/errors";
import { AdminService } from "@/modules/food-discovery/server/operations/admin-service";
import {
  ConflictingPlace,
  PlaceAdminService,
  PlaceAdminServiceLive,
  PlaceHasChildren,
  PlaceHasDishLinks,
  placeAdminPageSize,
  type PlaceView,
} from "@/modules/food-discovery/server/operations/place-admin-service";
import { Actor } from "@/server/auth/actor";
import { type CurrentActor, withActor } from "@/server/auth/current-actor";
import { InsufficientPermissions } from "@/server/auth/errors";
import type { AppServices } from "@/server/layers";
import { appRuntime } from "@/server/runtime";

import { createFoodAuth } from "./food-auth";

/**
 * Place registry admin CRUD: full lifecycle plus every typed refusal
 * (duplicate identity, hierarchy cycles, in-use deletes, name invariants)
 * and the `food:update` service boundary.
 *
 * Isolation: every fixture name carries a unique per-file stamp; only
 * owned place ids, owned revision rows (matched by actor), owned dish
 * slugs, and the owned test role are deleted. Seed data is read-only.
 */

// Unique per module evaluation: parallel test files in one process share
// pid and millisecond, so a random suffix keeps fixture names/isos apart
// in the shared disposable database.
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const ACTOR = `e2e:place-admin-${stamp}`;
const roleId = `test-place-admin-${stamp}`;
const ownedPlaceIds: Array<string> = [];
const ownedSlugs: Array<string> = [];

const foodAuth = createFoodAuth();

let adminUserId = "";
let plainUserId = "";
let adminLabel = "";

const runAs = <A, E>(
  userId: string,
  effect: Effect.Effect<A, E, PlaceAdminService | AppServices | CurrentActor>,
): Promise<A> =>
  appRuntime.runPromise(
    withActor(Actor.Member({ userId }), effect).pipe(Effect.provide(PlaceAdminServiceLive)),
  );

const runAsFailure = <A, E>(
  userId: string,
  effect: Effect.Effect<A, E, PlaceAdminService | AppServices | CurrentActor>,
): Promise<E> =>
  appRuntime.runPromise(
    Effect.flip(
      withActor(Actor.Member({ userId }), effect).pipe(Effect.provide(PlaceAdminServiceLive)),
    ),
  );

const run = <A, E, R extends AppServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  appRuntime.runPromise(effect);

const track = (view: PlaceView): string => {
  ownedPlaceIds.push(view.id);

  return view.id;
};

const query = async <T>(statement: (sql: SQL) => Promise<T>): Promise<T> => {
  const sql = new SQL(process.env.DATABASE_URL ?? "");

  try {
    return await statement(sql);
  } finally {
    await sql.end();
  }
};

beforeAll(async () => {
  expect(process.env.DATABASE_URL).toBeTruthy();

  await query(
    (sql) =>
      sql`INSERT INTO feastjourney.roles (id, slug, name) VALUES (${roleId}, ${roleId}, ${roleId}) ON CONFLICT DO NOTHING`,
  );
  await query(
    (sql) =>
      sql`INSERT INTO feastjourney.role_permissions (role_id, permission_key) VALUES (${roleId}, 'food:update') ON CONFLICT DO NOTHING`,
  );

  const adminSession = await foodAuth.signupSignin("place-admin");
  const plainSession = await foodAuth.signupSignin("place-viewer");

  await foodAuth.grantRole(adminSession.userId, roleId);

  adminUserId = adminSession.userId;
  plainUserId = plainSession.userId;
  adminLabel = `member:${adminUserId}`;
});

afterAll(async () => {
  await Promise.all(
    ownedSlugs.map((slug) =>
      query((sql) => sql`DELETE FROM feastjourney.dishes WHERE slug = ${slug}`),
    ),
  );

  // Children sort after their parents in creation order, so deleting in
  // reverse creation order satisfies the RESTRICT guard on
  // place_parents.parent_place_id. Edges are removed first (outgoing edge
  // of every owned place) so the place deletes are order-safe even when
  // service calls in a test re-parented fixtures after tracking.
  // Recursion (not a loop) keeps the sequence without tripping no-await-in-loop.
  const deleteOwnedPlaces = async (ids: ReadonlyArray<string>): Promise<void> => {
    const [head, ...tail] = ids;

    if (head === undefined) {
      return;
    }

    await query(
      (sql) => sql`DELETE FROM feastjourney.place_parents WHERE place_id = ${head}::bigint`,
    );

    return deleteOwnedPlaces(tail);
  };

  await deleteOwnedPlaces(ownedPlaceIds);

  const deleteOwnedPlaceRows = async (ids: ReadonlyArray<string>): Promise<void> => {
    const [head, ...tail] = ids.toReversed();

    if (head === undefined) {
      return;
    }

    await query((sql) => sql`DELETE FROM feastjourney.places WHERE id = ${head}::bigint`);

    return deleteOwnedPlaceRows(tail);
  };

  await deleteOwnedPlaceRows(ownedPlaceIds);

  await query((sql) => sql`DELETE FROM feastjourney.place_revisions WHERE actor = ${adminLabel}`);
  await query((sql) => sql`DELETE FROM feastjourney.roles WHERE id = ${roleId}`);
  await foodAuth.close();
});

describe("place admin CRUD", () => {
  test("creates a locality with default preferred-name election and reads it back", async () => {
    const name = `E2E Testville ${stamp}`;

    const view = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.createPlace({
          kind: "locality",
          displayLatitude: 12.34,
          displayLongitude: 56.78,
          displayNote: `E2E fixture ${stamp}`,
          names: [
            { languageTag: "en", name },
            { languageTag: "vi", name: `E2E Thị trấn ${stamp}` },
          ],
        }),
      ),
    );

    track(view);
    expect(view.kind).toBe("locality");
    expect(view.iso3166).toBeNull();
    expect(view.displayLatitude).toBeCloseTo(12.34);

    const detail = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.placeDetail(view.id)),
    );

    expect(detail.place.id).toBe(view.id);
    expect(detail.names).toHaveLength(2);

    const english = detail.names.find((entry) => entry.languageTag === "en");

    expect(english?.isPreferred).toBe(true);
    expect(english?.searchKey).toBe(`e2e testville ${stamp}`);
    expect(detail.parents).toHaveLength(0);
    expect(detail.ancestors).toHaveLength(0);
    expect(detail.children).toHaveLength(0);
    expect(detail.dishCounts).toEqual({ origin: 0, associated: 0, popular: 0, total: 0 });
  });

  test("refuses an ISO code on a locality", async () => {
    const failure = await runAsFailure(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.createPlace({
          kind: "locality",
          iso3166: "VN",
          names: [{ languageTag: "en", name: `E2E Bad Iso ${stamp}` }],
        }),
      ),
    );

    expect(failure).toBeInstanceOf(InvalidSearchFilter);
  });

  test("refuses out-of-range and half-set coordinates", async () => {
    const badLat = await runAsFailure(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.createPlace({
          kind: "locality",
          displayLatitude: 91,
          displayLongitude: 10,
          names: [{ languageTag: "en", name: `E2E Bad Lat ${stamp}` }],
        }),
      ),
    );

    expect(badLat).toBeInstanceOf(InvalidSearchFilter);

    const halfSet = await runAsFailure(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.createPlace({
          kind: "locality",
          displayLatitude: 10,
          names: [{ languageTag: "en", name: `E2E Half Coords ${stamp}` }],
        }),
      ),
    );

    expect(halfSet).toBeInstanceOf(InvalidSearchFilter);
  });

  test("refuses duplicate (kind, name, parent) identity but allows the same name under another parent", async () => {
    const parentA = track(
      await runAs(
        adminUserId,
        Effect.flatMap(PlaceAdminService, (service) =>
          service.createPlace({
            kind: "province",
            names: [{ languageTag: "en", name: `E2E North ${stamp}` }],
          }),
        ),
      ),
    );

    const parentB = track(
      await runAs(
        adminUserId,
        Effect.flatMap(PlaceAdminService, (service) =>
          service.createPlace({
            kind: "province",
            names: [{ languageTag: "en", name: `E2E South ${stamp}` }],
          }),
        ),
      ),
    );

    const first = track(
      await runAs(
        adminUserId,
        Effect.flatMap(PlaceAdminService, (service) =>
          service.createPlace({
            kind: "locality",
            names: [{ languageTag: "en", name: `E2E SameName ${stamp}` }],
            parentIds: [parentA],
          }),
        ),
      ),
    );

    expect(first).toMatch(/^[0-9]+$/);

    const duplicate = await runAsFailure(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.createPlace({
          kind: "locality",
          names: [{ languageTag: "en", name: `E2E Samename ${stamp}` }],
          parentIds: [parentA],
        }),
      ),
    );

    expect(duplicate).toBeInstanceOf(ConflictingPlace);

    const otherParent = track(
      await runAs(
        adminUserId,
        Effect.flatMap(PlaceAdminService, (service) =>
          service.createPlace({
            kind: "locality",
            names: [{ languageTag: "en", name: `E2E Samename ${stamp}` }],
            parentIds: [parentB],
          }),
        ),
      ),
    );

    expect(otherParent).toMatch(/^[0-9]+$/);
  });

  test("rejects multiple preferred names for one language", async () => {
    const failure = await runAsFailure(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.createPlace({
          kind: "locality",
          names: [
            { languageTag: "en", name: `E2E Pref A ${stamp}`, isPreferred: true },
            { languageTag: "en", name: `E2E Pref B ${stamp}`, isPreferred: true },
          ],
        }),
      ),
    );

    expect(failure).toBeInstanceOf(InvalidSearchFilter);
  });

  test("updates notes and coordinates, and rejects ISO on localities", async () => {
    const view = track(
      await runAs(
        adminUserId,
        Effect.flatMap(PlaceAdminService, (service) =>
          service.createPlace({
            kind: "locality",
            names: [{ languageTag: "en", name: `E2E Updatable ${stamp}` }],
          }),
        ),
      ),
    );

    const updated = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.updatePlace(view, {
          displayLatitude: -33.86,
          displayLongitude: 151.2,
          displayNote: `updated ${stamp}`,
        }),
      ),
    );

    expect(updated.displayLatitude).toBeCloseTo(-33.86);
    expect(updated.displayNote).toBe(`updated ${stamp}`);

    const badIso = await runAsFailure(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.updatePlace(view, { iso3166: "AU" })),
    );

    expect(badIso).toBeInstanceOf(InvalidSearchFilter);

    const unknown = await runAsFailure(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.updatePlace("199999999999", { displayNote: "nope" }),
      ),
    );

    expect(unknown).toBeInstanceOf(PlaceNotFound);
  });

  test("detail exposes hierarchy in both directions with dish counts", async () => {
    const province = track(
      await runAs(
        adminUserId,
        Effect.flatMap(PlaceAdminService, (service) =>
          service.createPlace({
            kind: "province",
            names: [{ languageTag: "en", name: `E2E Shire ${stamp}` }],
          }),
        ),
      ),
    );

    const town = track(
      await runAs(
        adminUserId,
        Effect.flatMap(PlaceAdminService, (service) =>
          service.createPlace({
            kind: "locality",
            names: [{ languageTag: "en", name: `E2E Hamlet ${stamp}` }],
            parentIds: [province],
          }),
        ),
      ),
    );

    const townDetail = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.placeDetail(town)),
    );

    expect(townDetail.parents.map((entry) => entry.id)).toEqual([province]);
    expect(townDetail.ancestors.map((entry) => ({ id: entry.id, depth: entry.depth }))).toEqual([
      { id: province, depth: 1 },
    ]);
    expect(townDetail.parents[0]?.displayName).toBe(`E2E Shire ${stamp}`);

    const provinceDetail = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.placeDetail(province)),
    );

    expect(provinceDetail.children.map((entry) => entry.id)).toEqual([town]);
    expect(provinceDetail.children[0]?.displayName).toBe(`E2E Hamlet ${stamp}`);
  });

  test("upserts names, flips preference, and refuses to strand a place nameless", async () => {
    const view = track(
      await runAs(
        adminUserId,
        Effect.flatMap(PlaceAdminService, (service) =>
          service.createPlace({
            kind: "locality",
            names: [{ languageTag: "en", name: `E2E Nametown ${stamp}` }],
          }),
        ),
      ),
    );

    const afterAlias = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.upsertPlaceNames(view, [{ languageTag: "en", name: `E2E Ntawn ${stamp}` }]),
      ),
    );

    expect(afterAlias).toHaveLength(2);
    expect(afterAlias.filter((entry) => entry.isPreferred)).toHaveLength(1);

    const afterPromote = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.upsertPlaceNames(view, [
          { languageTag: "en", name: `E2E Ntawn ${stamp}`, isPreferred: true },
        ]),
      ),
    );

    const preferred = afterPromote.filter((entry) => entry.isPreferred);

    expect(preferred).toHaveLength(1);
    expect(preferred[0]?.name).toBe(`E2E Ntawn ${stamp}`);

    const aliasId = afterPromote.find((entry) => !entry.isPreferred)?.id ?? "";

    const removed = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.removePlaceName(view, aliasId)),
    );

    expect(removed.removedNameId).toBe(aliasId);
    expect(removed.promotedNameId).toBeNull();

    const remaining = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.placeDetail(view)),
    );

    const lastId = remaining.names[0]?.id ?? "";

    const refuseLast = await runAsFailure(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.removePlaceName(view, lastId)),
    );

    expect(refuseLast).toBeInstanceOf(InvalidSearchFilter);

    const refuseUnknown = await runAsFailure(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.removePlaceName(view, "199999999999")),
    );

    expect(refuseUnknown).toBeInstanceOf(InvalidSearchFilter);
  });

  test("auto-promotes the oldest sibling when a preferred name is removed", async () => {
    const view = track(
      await runAs(
        adminUserId,
        Effect.flatMap(PlaceAdminService, (service) =>
          service.createPlace({
            kind: "locality",
            names: [{ languageTag: "en", name: `E2E Promotown ${stamp}` }],
          }),
        ),
      ),
    );

    const withAlias = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.upsertPlaceNames(view, [{ languageTag: "en", name: `E2E Promalias ${stamp}` }]),
      ),
    );

    const preferredId = withAlias.find((entry) => entry.isPreferred)?.id ?? "";

    const removed = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.removePlaceName(view, preferredId)),
    );

    expect(removed.promotedNameId).not.toBeNull();

    const detail = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.placeDetail(view)),
    );

    const survivors = detail.names.filter((entry) => entry.languageTag === "en");

    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.isPreferred).toBe(true);
  });

  test("guards the parent DAG: self, two-node, and idempotent links", async () => {
    const province = track(
      await runAs(
        adminUserId,
        Effect.flatMap(PlaceAdminService, (service) =>
          service.createPlace({
            kind: "province",
            names: [{ languageTag: "en", name: `E2E Cycshire ${stamp}` }],
          }),
        ),
      ),
    );

    const town = track(
      await runAs(
        adminUserId,
        Effect.flatMap(PlaceAdminService, (service) =>
          service.createPlace({
            kind: "locality",
            names: [{ languageTag: "en", name: `E2E Cycville ${stamp}` }],
            parentIds: [province],
          }),
        ),
      ),
    );

    const selfParent = await runAsFailure(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.setPlaceParent(town, town)),
    );

    expect(selfParent).toBeInstanceOf(InvalidRelationship);

    const cycle = await runAsFailure(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.setPlaceParent(province, town)),
    );

    expect(cycle).toBeInstanceOf(InvalidRelationship);

    const idempotent = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.setPlaceParent(town, province)),
    );

    expect(idempotent.linked).toBe(false);

    const removed = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.removePlaceParent(town, province)),
    );

    expect(removed.removed).toBe(true);

    const removedAgain = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.removePlaceParent(town, province)),
    );

    expect(removedAgain.removed).toBe(false);
  });

  test("refuses to delete places with children or dish links", async () => {
    const province = track(
      await runAs(
        adminUserId,
        Effect.flatMap(PlaceAdminService, (service) =>
          service.createPlace({
            kind: "province",
            names: [{ languageTag: "en", name: `E2E Delshire ${stamp}` }],
          }),
        ),
      ),
    );

    const town = track(
      await runAs(
        adminUserId,
        Effect.flatMap(PlaceAdminService, (service) =>
          service.createPlace({
            kind: "locality",
            names: [{ languageTag: "en", name: `E2E Deltown ${stamp}` }],
            parentIds: [province],
          }),
        ),
      ),
    );

    const withChild = await runAsFailure(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.deletePlace(province)),
    );

    expect(withChild).toBeInstanceOf(PlaceHasChildren);

    if (!(withChild instanceof PlaceHasChildren)) {
      throw new Error("expected PlaceHasChildren");
    }

    expect(withChild.childCount).toBe(1);

    const slug = `e2e-del-dish-${stamp}`;

    ownedSlugs.push(slug);

    const dish = await run(
      Effect.flatMap(AdminService, (service) =>
        service.createDish(ACTOR, {
          slug,
          status: "draft",
          names: [{ languageTag: "en", name: `E2E Del Dish ${stamp}`, nameKind: "localized" }],
        }),
      ),
    );

    await run(
      Effect.flatMap(AdminService, (service) =>
        service.linkDishPlace(ACTOR, dish.id, town, "associated", false),
      ),
    );

    const withLink = await runAsFailure(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.deletePlace(town)),
    );

    expect(withLink).toBeInstanceOf(PlaceHasDishLinks);

    if (!(withLink instanceof PlaceHasDishLinks)) {
      throw new Error("expected PlaceHasDishLinks");
    }

    expect(withLink.dishCount).toBe(1);

    await query((sql) => sql`DELETE FROM feastjourney.dishes WHERE slug = ${slug}`);

    const deleted = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.deletePlace(town)),
    );

    expect(deleted.id).toBe(town);

    const gone = await runAsFailure(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.placeDetail(town)),
    );

    expect(gone).toBeInstanceOf(PlaceNotFound);

    const revisions = await query(
      (sql) =>
        sql<
          Array<{ operation: string; place_id: string | null }>
        >`SELECT operation, place_id::text AS place_id FROM feastjourney.place_revisions WHERE actor = ${adminLabel} AND summary LIKE ${`%${town}%`}`,
    );

    expect(revisions.some((row) => row.operation === "deleted")).toBe(true);
  });

  test("lists places with query, kind, and parent filters plus pagination", async () => {
    const province = track(
      await runAs(
        adminUserId,
        Effect.flatMap(PlaceAdminService, (service) =>
          service.createPlace({
            kind: "province",
            names: [{ languageTag: "en", name: `E2E Listshire ${stamp}` }],
          }),
        ),
      ),
    );

    const created = await Promise.all(
      ["Alpha", "Beta", "Gamma"].map((suffix) =>
        runAs(
          adminUserId,
          Effect.flatMap(PlaceAdminService, (service) =>
            service.createPlace({
              kind: "locality",
              names: [{ languageTag: "en", name: `E2E Listville ${suffix} ${stamp}` }],
              parentIds: [province],
            }),
          ),
        ),
      ),
    );

    for (const view of created) {
      track(view);
    }

    const page = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.listPlaces({ query: `Listville ${stamp}`, kind: "locality", page: 0 }),
      ),
    );

    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(3);
    expect(page.items[0]?.displayName).toContain("Listville");

    const scoped = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.listPlaces({ parentId: province, page: 0 }),
      ),
    );

    const scopedIds = new Set(scoped.items.map((entry) => entry.id));

    for (const id of page.items.map((entry) => entry.id)) {
      expect(scopedIds.has(id)).toBe(true);
    }

    const empty = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.listPlaces({ query: `NoSuchPlace ${stamp}`, page: 0 }),
      ),
    );

    expect(empty).toEqual({ items: [], page: 0, pageSize: placeAdminPageSize, total: 0 });
  });

  test("denies mutations without food:update", async () => {
    const failure = await runAsFailure(
      plainUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.createPlace({
          kind: "locality",
          names: [{ languageTag: "en", name: `E2E Forbidden ${stamp}` }],
        }),
      ),
    );

    expect(failure).toBeInstanceOf(InsufficientPermissions);
  });
});
