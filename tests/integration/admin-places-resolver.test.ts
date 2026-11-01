// oxlint-disable-next-line import/no-unassigned-import -- side-effectful test environment setup, runs before server modules initialize.
import "./cleanup";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { SQL } from "bun";
import { Effect } from "effect";

import { PlaceNotFound } from "@/modules/food-discovery/server/domain/errors";
import {
  AmbiguousPlace,
  PlaceAdminService,
  PlaceAdminServiceLive,
  type PlaceAdminApi,
  placeNotFoundReason,
} from "@/modules/food-discovery/server/operations/place-admin-service";
import { Actor } from "@/server/auth/actor";
import { type CurrentActor, withActor } from "@/server/auth/current-actor";
import type { AppServices } from "@/server/layers";
import { appRuntime } from "@/server/runtime";

import { createFoodAuth } from "./food-auth";

/**
 * Portable place reference resolver: id, ISO, and city-name forms with
 * preferred-then-alias matching, parent-ISO scoping, and typed
 * ambiguity/absence failures. Read-only against seed data plus one owned
 * ambiguous pair (two same-named localities under distinct ISO-bearing
 * test parents); only owned rows are deleted.
 */

// Unique per module evaluation: parallel test files in one process share
// pid and millisecond, so a random suffix keeps fixture names/isos apart
// in the shared disposable database.
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const roleId = `test-place-resolver-${stamp}`;
const ownedPlaceIds: Array<string> = [];

const foodAuth = createFoodAuth();

let adminUserId = "";
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

const query = async <T>(statement: (sql: SQL) => Promise<T>): Promise<T> => {
  const sql = new SQL(process.env.DATABASE_URL ?? "");

  try {
    return await statement(sql);
  } finally {
    await sql.end();
  }
};

const resolve = (ref: Parameters<PlaceAdminApi["resolvePlaceRef"]>[0]) =>
  Effect.flatMap(PlaceAdminService, (service) => service.resolvePlaceRef(ref));

let springfieldNorth = "";
let springfieldSouth = "";

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

  const adminSession = await foodAuth.signupSignin("place-resolver");

  await foodAuth.grantRole(adminSession.userId, roleId);

  adminUserId = adminSession.userId;
  adminLabel = `member:${adminUserId}`;

  const cityName = `E2E Springfield ${stamp}`;

  const makeParent = async (iso: string, label: string): Promise<string> => {
    const view = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.createPlace({
          kind: "province",
          iso3166: iso,
          names: [{ languageTag: "en", name: `${label} ${stamp}` }],
        }),
      ),
    );

    ownedPlaceIds.push(view.id);

    return view.id;
  };

  const north = await makeParent("QX", "E2E Northprov");
  const south = await makeParent("QY", "E2E Southprov");

  const makeCity = async (parentId: string): Promise<string> => {
    const view = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.createPlace({
          kind: "locality",
          names: [{ languageTag: "en", name: cityName }],
          parentIds: [parentId],
        }),
      ),
    );

    ownedPlaceIds.push(view.id);

    return view.id;
  };

  springfieldNorth = await makeCity(north);
  springfieldSouth = await makeCity(south);
});

afterAll(async () => {
  // Reverse creation order: children were created after their parents, so
  // this satisfies the RESTRICT guard on place_parents.parent_place_id.
  // Outgoing edges go first so the place deletes stay order-safe even if a
  // test re-parented a fixture after tracking it.
  const deleteOwnedEdges = async (ids: ReadonlyArray<string>): Promise<void> => {
    const [head, ...tail] = ids;

    if (head === undefined) {
      return;
    }

    await query(
      (sql) => sql`DELETE FROM feastjourney.place_parents WHERE place_id = ${head}::bigint`,
    );

    return deleteOwnedEdges(tail);
  };

  await deleteOwnedEdges(ownedPlaceIds);

  const deleteOwnedPlaces = async (ids: ReadonlyArray<string>): Promise<void> => {
    const [head, ...tail] = ids.toReversed();

    if (head === undefined) {
      return;
    }

    await query((sql) => sql`DELETE FROM feastjourney.places WHERE id = ${head}::bigint`);

    return deleteOwnedPlaces(tail);
  };

  await deleteOwnedPlaces(ownedPlaceIds);

  await query((sql) => sql`DELETE FROM feastjourney.place_revisions WHERE actor = ${adminLabel}`);
  await query((sql) => sql`DELETE FROM feastjourney.roles WHERE id = ${roleId}`);
  await foodAuth.close();
});

describe("resolvePlaceRef", () => {
  test("resolves ISO codes with case canonicalization", async () => {
    const upper = await runAs(adminUserId, resolve({ iso: "VN" }));

    expect(upper.iso3166).toBe("VN");
    expect(upper.kind).toBe("country");

    const lower = await runAs(adminUserId, resolve({ iso: "vn" }));

    expect(lower.id).toBe(upper.id);
  });

  test("resolves registry ids and reports unknown ids with a Place Manager action", async () => {
    const hanoi = await runAs(adminUserId, resolve({ city: "Hanoi", parentIso: "VN" }));
    const byId = await runAs(adminUserId, resolve({ placeId: Number(hanoi.id) }));

    expect(byId.id).toBe(hanoi.id);

    const missing = await runAsFailure(adminUserId, resolve({ placeId: 199999999999 }));

    expect(missing).toBeInstanceOf(PlaceNotFound);

    if (!(missing instanceof PlaceNotFound)) {
      throw new Error("expected PlaceNotFound");
    }

    expect(placeNotFoundReason(missing)).toContain("Place Manager");
  });

  test("matches preferred names, then non-preferred aliases", async () => {
    const hanoi = await runAs(adminUserId, resolve({ city: "Hanoi" }));

    expect(hanoi.kind).toBe("locality");

    const alias = await runAs(adminUserId, resolve({ city: "Bangalore" }));
    const canonical = await runAs(adminUserId, resolve({ city: "Bengaluru" }));

    expect(alias.id).toBe(canonical.id);
  });

  test("reports unknown cities and malformed ISOs as PlaceNotFound", async () => {
    const unknownCity = await runAsFailure(adminUserId, resolve({ city: `E2E Noplace ${stamp}` }));

    expect(unknownCity).toBeInstanceOf(PlaceNotFound);

    if (!(unknownCity instanceof PlaceNotFound)) {
      throw new Error("expected PlaceNotFound");
    }

    expect(placeNotFoundReason(unknownCity)).toContain("Place Manager");

    const unknownIso = await runAsFailure(adminUserId, resolve({ iso: "ZZ" }));

    expect(unknownIso).toBeInstanceOf(PlaceNotFound);

    const malformedIso = await runAsFailure(adminUserId, resolve({ iso: "usa" }));

    expect(malformedIso).toBeInstanceOf(PlaceNotFound);

    const blankCity = await runAsFailure(adminUserId, resolve({ city: "   " }));

    expect(blankCity).toBeInstanceOf(PlaceNotFound);
  });

  test("scopes city matches by parent ISO and fails closed on mismatch", async () => {
    const scoped = await runAs(adminUserId, resolve({ city: "Hanoi", parentIso: "VN" }));

    expect(scoped.kind).toBe("locality");

    const mismatch = await runAsFailure(adminUserId, resolve({ city: "Hanoi", parentIso: "US" }));

    expect(mismatch).toBeInstanceOf(PlaceNotFound);

    if (!(mismatch instanceof PlaceNotFound)) {
      throw new Error("expected PlaceNotFound");
    }

    expect(placeNotFoundReason(mismatch)).toContain("Place Manager");
  });

  test("returns AmbiguousPlace with context for same-named cities", async () => {
    const ambiguous = await runAsFailure(
      adminUserId,
      resolve({ city: `E2E Springfield ${stamp}` }),
    );

    expect(ambiguous).toBeInstanceOf(AmbiguousPlace);

    if (!(ambiguous instanceof AmbiguousPlace)) {
      throw new Error("expected AmbiguousPlace");
    }

    const candidates = ambiguous.candidates;

    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((entry) => entry.id))).toEqual(
      new Set([springfieldNorth, springfieldSouth]),
    );

    for (const candidate of candidates) {
      expect(candidate.context).toContain(`E2E Springfield ${stamp}`);
    }
  });

  test("disambiguates same-named cities through parent ISO scope", async () => {
    const cityName = `E2E Springfield ${stamp}`;
    const north = await runAs(adminUserId, resolve({ city: cityName, parentIso: "QX" }));

    expect(north.id).toBe(springfieldNorth);

    const south = await runAs(adminUserId, resolve({ city: cityName, parentIso: "QY" }));

    expect(south.id).toBe(springfieldSouth);

    const mismatch = await runAsFailure(adminUserId, resolve({ city: cityName, parentIso: "VN" }));

    expect(mismatch).toBeInstanceOf(PlaceNotFound);
  });

  test("finds a renamed city by its new name and forgets the old text", async () => {
    const view = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.createPlace({
          kind: "locality",
          names: [{ languageTag: "en", name: `E2E Oldname ${stamp}` }],
        }),
      ),
    );

    ownedPlaceIds.push(view.id);

    const before = await runAs(adminUserId, resolve({ city: `E2E Oldname ${stamp}` }));

    expect(before.id).toBe(view.id);

    const detail = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) => service.placeDetail(view.id)),
    );

    const nameId = detail.names.find((entry) => entry.languageTag === "en")?.id ?? "";

    expect(nameId).toMatch(/^[0-9]+$/);

    const saved = await runAs(
      adminUserId,
      Effect.flatMap(PlaceAdminService, (service) =>
        service.savePlaceNames(view.id, {
          upsert: [{ id: nameId, languageTag: "en", name: `E2E Newname ${stamp}` }],
          removeIds: [],
        }),
      ),
    );

    expect(saved.find((entry) => entry.id === nameId)?.name).toBe(`E2E Newname ${stamp}`);

    const renamed = await runAs(adminUserId, resolve({ city: `E2E Newname ${stamp}` }));

    expect(renamed.id).toBe(view.id);

    const stale = await runAsFailure(adminUserId, resolve({ city: `E2E Oldname ${stamp}` }));

    expect(stale).toBeInstanceOf(PlaceNotFound);
  });
});
