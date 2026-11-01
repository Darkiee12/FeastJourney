// oxlint-disable-next-line import/no-unassigned-import -- side-effectful test environment setup, runs before server modules initialize.
import "./cleanup";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { SQL } from "bun";
import { Effect } from "effect";

import { InvalidSearchFilter, PlaceNotFound } from "@/modules/food-discovery/server/domain/errors";
import { AdminService } from "@/modules/food-discovery/server/operations/admin-service";
import { DishService } from "@/modules/food-discovery/server/operations/dish-service";
import type { AppServices } from "@/server/layers";
import { appRuntime } from "@/server/runtime";

/**
 * Discovery fallback scope matrix, end to end against the disposable DB.
 *
 * Covers the SHIPPED served-scope contract in `DishService.getLocalCarousel`
 * (discriminated `CarouselScope` input, service-internal fallback chain) plus
 * the `getLocalCarouselFn` graceful halves (unknown country -> worldwide).
 * The server function itself cannot be invoked from bun:test, so the fn
 * halves are asserted as their two observable service halves.
 *
 * Wire-boundary exclusivity (`carouselQuerySchema` superRefine) and the pure
 * `resolveCarouselScope` normalization are unit-covered by the schema block
 * in `tests/discovery-scope-labels.test.ts` and by Agent A in
 * `tests/dish-carousel-scope.test.ts`; this file pins the end-to-end
 * observable behavior only.
 *
 * 13-row scenario table (S1..S13) plus city legs (S14..S16):
 * | row | input                                  | requested | served    | fallback |
 * |-----|----------------------------------------|-----------|-----------|----------|
 * | S1  | no location (legacy service call)      | worldwide | worldwide | false [] |
 * | S2  | country with dishes                    | country   | country   | false    |
 * | S3  | empty country                          | country   | country   | true     |
 * |     |                                        |           | (honest   | country- |
 * |     |                                        |           |  empty)   | empty    |
 * | S4  | unknown well-formed country            | — (typed  | —         | —        |
 * |     |                                        | PlaceNot- |           |          |
 * |     |                                        | Found)    |           |          |
 * |     |   + worldwide (fn fallback half)       | worldwide | worldwide | false    |
 * | S5  | malformed country codes                | — (typed  | —         | —        |
 * |     |                                        | Invalid-  |           |          |
 * |     |                                        | Search-   |           |          |
 * |     |                                        | Filter)   |           |          |
 * | S6  | nearby with dishes in radius           | nearby    | nearby    | false    |
 * | S7  | sparse ocean coordinates, no hint      | nearby    | nearby    | true     |
 * |     |                                        |           | (honest   | nearby-  |
 * |     |                                        |           |  empty)   | empty    |
 * | S8  | nearby-empty + known country hint     | nearby    | country   | true     |
 * |     |                                        |           | (never    | nearby-  |
 * |     |                                        |           |  nearby)  | empty    |
 * | S9  | worldwide                              | worldwide | worldwide | false    |
 * | S10 | boundary coordinates                   | nearby    | data-     | —        |
 * |     |                                        |           | dependent |          |
 * | S11 | out-of-range / partial coordinates     | — (typed  | —         | —        |
 * |     |                                        | Invalid-  |           |          |
 * |     |                                        | Search-   |           |          |
 * |     |                                        | Filter)   |           |          |
 * | S12 | REGRESSION PINNED: worldwide +         | — (typed  | —         | —        |
 * |     | coordinates (or country) fails closed; | Invalid-  |           |          |
 * |     | coordinates never hijack worldwide     | Search-   |           |          |
 * |     |                                        | Filter)   |           |          |
 * | S13 | sparse nearby + known country hint     | nearby    | nearby    | false +  |
 * |     | (top-up, nearby first, no dupes)       |           | (supple-  | supple-  |
 * |     |                                        |           |  mented)  | mented   |
 * | S14 | city with dishes                       | city      | city      | false    |
 * | S15 | empty city, dishes in ancestor country | city      | country   | true     |
 * |     |                                        |           |           | city-    |
 * |     |                                        |           |           | empty    |
 * | S16 | empty city, empty ancestor country     | city      | country   | true     |
 * |     |                                        |           | (honest   | city-    |
 * |     |                                        |           |  empty)   | empty-   |
 * |     |                                        |           |           | country- |
 * |     |                                        |           |           | empty    |
 *
 * Isolation: unique slug prefix per file run, unique fixture ISOs, no
 * TRUNCATE, no seed-count coupling. Only owned rows are deleted in afterAll
 * (dishes by slug prefix, place edges then places by display_note marker).
 */

const stamp = Date.now().toString(36);
const PREFIX = `df-${stamp}-`;
const ACTOR = `e2e:discovery-fallback-${stamp}`;
const MARKER = `e2e-fallback-country-${stamp}`;

const run = <A, E, R extends AppServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  appRuntime.runPromise(effect);

const runFailure = <A, E, R extends AppServices>(effect: Effect.Effect<A, E, R>): Promise<E> =>
  appRuntime.runPromise(Effect.flip(effect));

/** Run-unique, valid-pattern country code (`XQ-AB3` shape): no cross-run collision. */
const fixtureIso = (lead: "X" | "Y"): string => {
  const suffix = Math.random().toString(36).slice(2, 5).toUpperCase().padEnd(3, "X");

  return `${lead}Q-${suffix}`;
};

const query = async <T>(statement: (sql: SQL) => Promise<T>): Promise<T> => {
  const sql = new SQL(process.env.DATABASE_URL ?? "");

  try {
    return await statement(sql);
  } finally {
    await sql.end();
  }
};

const ensureFixtureCountry = async (
  iso: string,
  name: string,
): Promise<{ readonly id: string; readonly iso: string }> => {
  const existing = await query(
    (sql) => sql<Array<{ id: string }>>`
      SELECT id::text AS id FROM feastjourney.places
      WHERE iso3166 = ${iso} AND display_note = ${MARKER} LIMIT 1`,
  );

  if (existing[0] !== undefined) {
    return { id: existing[0].id, iso };
  }

  const created = await query(
    (sql) => sql<Array<{ id: string }>>`
      INSERT INTO feastjourney.places (kind, iso3166, display_latitude, display_longitude, display_note)
      VALUES ('country', ${iso}, -25.0, -15.0, ${MARKER})
      RETURNING id::text AS id`,
  );

  const placeId = created[0]?.id;

  if (placeId === undefined) {
    throw new Error(`fixture country insert returned no id for ${iso}`);
  }

  await query(
    (sql) => sql`
      INSERT INTO feastjourney.place_names (place_id, language_tag, name, is_preferred, search_key)
      VALUES (${placeId}::bigint, 'en', ${name}, TRUE, lower(${name}))`,
  );

  return { id: placeId, iso };
};

const LOCALITY_LAT = -35.0;
const LOCALITY_LON = -35.0;

/** Remote South Atlantic locality: >500 km from every seeded locality. */
const ensureFixtureLocality = async (
  countryId: string,
  name: string,
): Promise<{ readonly id: string }> => {
  const created = await query(
    (sql) => sql<Array<{ id: string }>>`
      INSERT INTO feastjourney.places (kind, display_latitude, display_longitude, display_note)
      VALUES ('locality', ${LOCALITY_LAT}, ${LOCALITY_LON}, ${MARKER})
      RETURNING id::text AS id`,
  );

  const placeId = created[0]?.id;

  if (placeId === undefined) {
    throw new Error("fixture locality insert returned no id");
  }

  await query(
    (sql) => sql`
      INSERT INTO feastjourney.place_names (place_id, language_tag, name, is_preferred, search_key)
      VALUES (${placeId}::bigint, 'en', ${name}, TRUE, lower(${name}))`,
  );

  await query(
    (sql) => sql`
      INSERT INTO feastjourney.place_parents (place_id, parent_place_id)
      VALUES (${placeId}::bigint, ${countryId}::bigint)`,
  );

  return { id: placeId };
};

interface DishFixtureOptions {
  readonly placeId?: string | undefined;
  readonly withDescription?: boolean | undefined;
  readonly withCategory?: boolean | undefined;
}

/** Publishable-by-default dish; pass options to build narrower fixtures. */
const createFixtureDish = async (
  tag: string,
  options: DishFixtureOptions = {},
): Promise<{ readonly id: string; readonly slug: string }> => {
  const slug = `${PREFIX}${tag}`;
  const name = `Fallback Dish ${tag} ${stamp}`;

  const created = await run(
    Effect.flatMap(AdminService, (service) =>
      service.createDish(ACTOR, {
        slug,
        status: "draft",
        names: [{ languageTag: "en", name, nameKind: "localized" }],
      }),
    ),
  );

  if (options.withDescription !== false) {
    await run(
      Effect.flatMap(AdminService, (service) =>
        service.upsertDishDescription(
          ACTOR,
          created.id,
          "en",
          `A test dish for fallback scope coverage (${tag}).`,
          null,
        ),
      ),
    );
  }

  if (options.withCategory !== false) {
    await run(
      Effect.flatMap(AdminService, (service) =>
        service.linkDishCategory(ACTOR, created.id, "soup"),
      ),
    );
  }

  if (options.placeId !== undefined) {
    const placeId: string = options.placeId;

    await run(
      Effect.flatMap(AdminService, (service) =>
        service.linkDishPlace(ACTOR, created.id, placeId, "origin", false),
      ),
    );
  }

  if (options.withDescription !== false && options.withCategory !== false) {
    await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDishStatus(ACTOR, created.id, "published"),
      ),
    );
  }

  return created;
};

let emptyIso = "";
let poolIso = "";
let poolCountryId = "";
let poolLocalityId = "";
let localitySlug = "";
let noGeoSlug = "";
let poolEmptyCityId = "";
let emptyCityId = "";

beforeAll(async () => {
  expect(process.env.DATABASE_URL).toBeDefined();

  const empty = await ensureFixtureCountry(fixtureIso("X"), `Emptyfallback ${stamp}`);
  const pool = await ensureFixtureCountry(fixtureIso("Y"), `Poolfallback ${stamp}`);

  emptyIso = empty.iso;
  poolIso = pool.iso;
  poolCountryId = pool.id;

  const locality = await ensureFixtureLocality(pool.id, `Fallbackport ${stamp}`);
  poolLocalityId = locality.id;

  const poolEmptyCity = await ensureFixtureLocality(pool.id, `Fallbackempty ${stamp}`);
  poolEmptyCityId = poolEmptyCity.id;

  const emptyCity = await ensureFixtureLocality(empty.id, `Emptyport ${stamp}`);
  emptyCityId = emptyCity.id;

  const creations = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      createFixtureDish(`pool-${index}`, { placeId: poolCountryId }),
    ),
  );

  expect(creations).toHaveLength(6);

  const local = await createFixtureDish("locality-dish", { placeId: locality.id });
  localitySlug = local.slug;

  const noGeo = await createFixtureDish("no-geo");
  noGeoSlug = noGeo.slug;
});

afterAll(async () => {
  await query((sql) => sql`DELETE FROM feastjourney.dishes WHERE slug LIKE ${`${PREFIX}%`}`);
  // Edges first: locality -> country edges RESTRICT deleting the parent.
  await query(
    (sql) => sql`
      DELETE FROM feastjourney.place_parents
      WHERE place_id IN (SELECT id FROM feastjourney.places WHERE display_note = ${MARKER})
        OR parent_place_id IN (SELECT id FROM feastjourney.places WHERE display_note = ${MARKER})`,
  );
  await query((sql) => sql`DELETE FROM feastjourney.places WHERE display_note = ${MARKER}`);
});

describe("discovery fallback scope matrix", () => {
  test("S1: no location at all resolves to an honest worldwide empty", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) => service.getLocalCarousel({ locale: "en" })),
    );

    expect(output.items).toEqual([]);
    expect(output.scope).toBe("worldwide");
    expect(output.requestedScope).toBe("worldwide");
    expect(output.fallback).toBe(false);
  });

  test("S2: country with dishes serves the country scope", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", country: poolIso, limit: 20 }),
      ),
    );

    expect(output.scope).toBe("country");
    expect(output.requestedScope).toBe("country");
    expect(output.fallback).toBe(false);
    expect(output.items.length).toBeGreaterThan(0);

    const slugs = output.items.map((item) => item.slug);

    expect(slugs).toContain(`${PREFIX}pool-0`);
    expect(slugs).toContain(localitySlug);
  });

  test("S3: empty country resolves to an honest empty, never silent worldwide", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", country: emptyIso, limit: 5 }),
      ),
    );

    expect(output.requestedScope).toBe("country");
    expect(output.scope).toBe("country");
    expect(output.fallback).toBe(true);
    expect(output.fallbackReason).toBe("country-empty");
    expect(output.items).toEqual([]);
  });

  test("S4: unknown well-formed country is a typed PlaceNotFound; worldwide half is non-empty", async () => {
    const failure = await runFailure(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", country: "ZZ", limit: 5 }),
      ),
    );

    expect(failure).toBeInstanceOf(PlaceNotFound);

    // getLocalCarouselFn catches PlaceNotFound and serves worldwide instead.
    const fallback = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", worldwide: true, limit: 5 }),
      ),
    );

    expect(fallback.requestedScope).toBe("worldwide");
    expect(fallback.scope).toBe("worldwide");
    expect(fallback.fallback).toBe(false);
    expect(fallback.items.length).toBeGreaterThan(0);
  });

  test("S5: malformed country codes fail closed with InvalidSearchFilter", async () => {
    const failures = await Promise.all(
      ["usa", "U", "XX-TOOLONG", "12", "US "].map((country) =>
        runFailure(
          Effect.flatMap(DishService, (service) =>
            service.getLocalCarousel({ locale: "en", country, limit: 5 }),
          ),
        ),
      ),
    );

    for (const failure of failures) {
      expect(failure).toBeInstanceOf(InvalidSearchFilter);
    }
  });

  test("S6: nearby coordinates with dishes serve the nearby scope", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({
          locale: "en",
          latitude: LOCALITY_LAT,
          longitude: LOCALITY_LON,
          limit: 5,
        }),
      ),
    );

    expect(output.requestedScope).toBe("nearby");
    expect(output.scope).toBe("nearby");
    expect(output.fallback).toBe(false);
    expect(output.items.map((item) => item.slug)).toContain(localitySlug);
  });

  test("S7: sparse ocean coordinates resolve to an honest empty, never a far continent", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", latitude: 0, longitude: -160, limit: 5 }),
      ),
    );

    expect(output.requestedScope).toBe("nearby");
    expect(output.scope).toBe("nearby");
    expect(output.fallback).toBe(true);
    expect(output.fallbackReason).toBe("nearby-empty");
    expect(output.items).toEqual([]);
  });

  test("S8: nearby-empty with a known country falls back labeled as country, never near-you", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({
          locale: "en",
          latitude: 0,
          longitude: -160,
          country: poolIso,
          limit: 20,
        }),
      ),
    );

    expect(output.requestedScope).toBe("nearby");
    expect(output.scope).toBe("country");
    expect(output.scope).not.toBe("nearby");
    expect(output.fallback).toBe(true);
    expect(output.fallbackReason).toBe("nearby-empty");
    expect(output.items.length).toBeGreaterThan(0);
    expect(output.items.map((item) => item.slug)).toContain(`${PREFIX}pool-0`);
  });

  test("S9: worldwide serves real published dishes and honors the limit", async () => {
    const def = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", worldwide: true }),
      ),
    );

    expect(def.requestedScope).toBe("worldwide");
    expect(def.scope).toBe("worldwide");
    expect(def.fallback).toBe(false);
    expect(def.items).toHaveLength(5);

    const wide = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", worldwide: true, limit: 100 }),
      ),
    );

    expect(wide.scope).toBe("worldwide");
    expect(wide.items.map((item) => item.slug)).toContain(`${PREFIX}pool-0`);

    for (const item of wide.items) {
      expect(item.slug.length).toBeGreaterThan(0);
      expect(item.id).toMatch(/^[0-9]+$/);
    }
  });

  test("S10: boundary coordinates are accepted as a nearby request", async () => {
    const accepted = await Promise.all(
      [
        [90, 180],
        [-90, -180],
        [90, -180],
        [-90, 180],
      ].map(([latitude, longitude]) =>
        run(
          Effect.flatMap(DishService, (service) =>
            service.getLocalCarousel({ locale: "en", latitude, longitude, limit: 5 }),
          ),
        ),
      ),
    );

    // The served scope is data-dependent (empty bands resolve to an honest
    // empty); the requested scope is always the nearby the caller sent.
    for (const output of accepted) {
      expect(output.items).toBeDefined();
      expect(output.requestedScope).toBe("nearby");

      if (output.fallback) {
        expect(output.items).toEqual([]);
      } else {
        expect(output.scope).toBe("nearby");
      }
    }
  });

  test("S11: out-of-range and partial coordinates fail closed with InvalidSearchFilter", async () => {
    const rejected = await Promise.all(
      [
        [90.1, 0],
        [-90.1, 0],
        [0, 180.1],
        [0, -180.1],
        [Number.NaN, 0],
        [0, Number.NaN],
      ].map(([latitude, longitude]) =>
        runFailure(
          Effect.flatMap(DishService, (service) =>
            service.getLocalCarousel({ locale: "en", latitude, longitude, limit: 5 }),
          ),
        ),
      ),
    );

    for (const failure of rejected) {
      expect(failure).toBeInstanceOf(InvalidSearchFilter);
    }

    const partialLatitude = await runFailure(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", latitude: 10, limit: 5 }),
      ),
    );

    expect(partialLatitude).toBeInstanceOf(InvalidSearchFilter);

    const partialLongitude = await runFailure(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", longitude: 10, limit: 5 }),
      ),
    );

    expect(partialLongitude).toBeInstanceOf(InvalidSearchFilter);
  });

  test("S12 REGRESSION PINNED: worldwide must not carry coordinates or country", async () => {
    // Fail-closed exclusivity: a worldwide request carrying coordinates or a
    // country is rejected instead of silently running a precise search. The
    // wire schema (`carouselQuerySchema`) rejects the same shapes, so this
    // service pin is the second layer, not the only one.
    const withCoords = await runFailure(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({
          locale: "en",
          worldwide: true,
          latitude: LOCALITY_LAT,
          longitude: LOCALITY_LON,
          limit: 5,
        }),
      ),
    );

    expect(withCoords).toBeInstanceOf(InvalidSearchFilter);

    const withCountry = await runFailure(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", worldwide: true, country: poolIso, limit: 5 }),
      ),
    );

    expect(withCountry).toBeInstanceOf(InvalidSearchFilter);
  });

  test("dishes without geo associations never surface as nearby", async () => {
    const nearby = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({
          locale: "en",
          latitude: LOCALITY_LAT,
          longitude: LOCALITY_LON,
          limit: 20,
        }),
      ),
    );

    expect(nearby.items.map((item) => item.slug)).not.toContain(noGeoSlug);
  });

  test("S13: sparse nearby pool is topped up with distinct country dishes, nearby first", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({
          locale: "en",
          latitude: LOCALITY_LAT,
          longitude: LOCALITY_LON,
          country: poolIso,
          limit: 5,
        }),
      ),
    );

    expect(output.requestedScope).toBe("nearby");
    expect(output.scope).toBe("nearby");
    expect(output.fallback).toBe(false);
    expect(output.supplemented).toBe(true);
    expect(output.items).toHaveLength(5);
    // Nearby relevance keeps its order: the locality dish leads.
    expect(output.items[0]?.slug).toBe(localitySlug);

    const ids = output.items.map((item) => item.id);

    expect(new Set(ids).size).toBe(ids.length);

    // Topped up from the country pool (seeded rotation decides WHICH pool
    // dishes fill the window, so assert pool membership, not one slug).
    const slugs = output.items.map((item) => item.slug);

    expect(slugs.filter((slug) => slug.startsWith(`${PREFIX}pool-`)).length).toBe(4);
  });

  test("S14: city with dishes serves the city scope", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", place: poolLocalityId, limit: 1 }),
      ),
    );

    expect(output.requestedScope).toBe("city");
    expect(output.scope).toBe("city");
    expect(output.fallback).toBe(false);
    expect(output.supplemented).toBe(false);
    expect(output.items.map((item) => item.slug)).toContain(localitySlug);
  });

  test("S15: empty city serves the ancestor country pool, labeled honestly", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", place: poolEmptyCityId, limit: 20 }),
      ),
    );

    expect(output.requestedScope).toBe("city");
    expect(output.scope).toBe("country");
    expect(output.scope).not.toBe("city");
    expect(output.fallback).toBe(true);
    expect(output.fallbackReason).toBe("city-empty");
    expect(output.items.map((item) => item.slug)).toContain(`${PREFIX}pool-0`);
  });

  test("S16: empty city with an empty ancestor resolves to an honest empty", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", place: emptyCityId, limit: 5 }),
      ),
    );

    expect(output.requestedScope).toBe("city");
    expect(output.scope).toBe("country");
    expect(output.fallback).toBe(true);
    expect(output.fallbackReason).toBe("city-empty-country-empty");
    expect(output.items).toEqual([]);
  });
});
