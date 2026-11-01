// oxlint-disable-next-line import/no-unassigned-import -- side-effectful test environment setup, runs before server modules initialize.
import "./cleanup";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { SQL } from "bun";
import { Effect } from "effect";
import { z } from "zod";

import {
  DishNotFound,
  InvalidSearchFilter,
  PlaceNotFound,
} from "@/modules/food-discovery/server/domain/errors";
import { AdminService } from "@/modules/food-discovery/server/operations/admin-service";
import { CatalogImportService } from "@/modules/food-discovery/server/operations/catalog-import-service";
import { toPublishedImage } from "@/modules/food-discovery/server/operations/dish-media-service";
import { DishService } from "@/modules/food-discovery/server/operations/dish-service";
import type { DishPublishedMediaRow } from "@/modules/food-discovery/server/repository/dish-relations-repository";
import type { AppServices } from "@/server/layers";
import { appRuntime } from "@/server/runtime";

/**
 * Homepage discovery-carousel coverage at the service + projection layers.
 *
 * Targets the SHIPPED contracts in `DishService.getLocalCarousel`:
 * SQL-backed selection per scope (country subtree, locality-radius nearby
 * with a country fallback, explicit worldwide), seeded rotation with per-cuisine
 * diversity shaping, honest scope labels, and the honest empty outcome when
 * nothing is in scope: scoped requests never widen to the worldwide pool. Session stability is per seed: same seed + same
 * scope -> same order; a new seed rotates the window over the same pool.
 *
 * Isolation: unique slug prefix per file run, no TRUNCATE, no seed-count
 * coupling. Fixture dishes are deleted in afterAll (dish rows cascade to
 * dish_places/names/descriptions); the single applied-import dish stays in
 * the disposable database exactly like the existing import suites.
 */

const stamp = Date.now().toString(36);
const PREFIX = `dc-${stamp}-`;
const ACTOR = `e2e:discovery-carousel-${stamp}`;
const MARKER = `e2e-carousel-country-${stamp}`;
const MANUAL_LICENSE = "manual:manual-entry";

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

const placeIdRowSchema = z.array(z.object({ id: z.string() }));

interface FixturePlace {
  readonly id: string;
  readonly iso: string;
}

const ensureFixtureCountry = async (iso: string, name: string): Promise<FixturePlace> => {
  const existing = await query(
    (sql) => sql<Array<{ id: string }>>`
      SELECT id::text AS id FROM feastjourney.places
      WHERE iso3166 = ${iso} AND display_note = ${MARKER} LIMIT 1`,
  );

  if (existing[0] !== undefined) {
    return { id: existing[0].id, iso };
  }

  // Centroid placed far from every seeded place so nearby/ocean assertions
  // stay deterministic: South Atlantic (remote, >1000 km from all seeds).
  // NOTE: no wikidata_id column in the live schema — see gap report.
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

interface DishFixtureOptions {
  readonly iso?: string | undefined;
  readonly withDescription?: boolean | undefined;
  readonly withCategory?: boolean | undefined;
  readonly status?: "draft" | "review" | undefined;
}

/** Publishable-by-default dish; pass options to build invalid fixtures. */
const createFixtureDish = async (
  tag: string,
  options: DishFixtureOptions = {},
): Promise<{ readonly id: string; readonly slug: string }> => {
  const slug = `${PREFIX}${tag}`;
  const name = `Carousel Dish ${tag} ${stamp}`;

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
          `A test dish for carousel coverage (${tag}).`,
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

  if (options.iso !== undefined) {
    const iso = options.iso;

    const rows = placeIdRowSchema.parse(
      await query(
        (sql) => sql<Array<{ id: string }>>`
          SELECT id::text AS id FROM feastjourney.places WHERE iso3166 = ${iso} LIMIT 1`,
      ),
    );

    const placeId = rows[0]?.id;

    if (placeId === undefined) {
      throw new Error(`expected place ${iso} to exist`);
    }

    await run(
      Effect.flatMap(AdminService, (service) =>
        service.linkDishPlace(ACTOR, created.id, placeId, "origin", false),
      ),
    );
  }

  if (options.status === "review") {
    await run(
      Effect.flatMap(AdminService, (service) =>
        service.updateDish(ACTOR, created.id, { status: "review" }),
      ),
    );

    return created;
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

const carouselScopes = async (input: {
  readonly latitude?: number | undefined;
  readonly longitude?: number | undefined;
  readonly country?: string | undefined;
  readonly worldwide?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly seed?: number | undefined;
}): Promise<{
  readonly slugs: Array<string>;
  readonly scope: string;
  readonly ids: Array<string>;
  readonly fallback: boolean;
}> => {
  const output = await run(
    Effect.flatMap(DishService, (service) => service.getLocalCarousel({ locale: "en", ...input })),
  );

  return {
    slugs: output.items.map((item) => item.slug),
    scope: output.scope,
    ids: output.items.map((item) => item.id),
    fallback: output.fallback,
  };
};

const carouselSlugs = async (input: {
  readonly latitude?: number | undefined;
  readonly longitude?: number | undefined;
  readonly country?: string | undefined;
  readonly worldwide?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly seed?: number | undefined;
}): Promise<Array<string>> => (await carouselScopes(input)).slugs;

const cardIds = (items: ReadonlyArray<{ readonly id: string }>): Array<string> =>
  items.map((item) => item.id);

let emptyIso = "";
let sevenIso = "";
let noGeoSlug = "";
let reviewSlug = "";
let importSlug = "";

beforeAll(async () => {
  expect(process.env.DATABASE_URL).toBeDefined();

  // Two isolated fixture countries: one stays empty, one hosts the
  // seven-dish pool plus the no-geo/per-country fixtures' neighbors.
  const empty = await ensureFixtureCountry(fixtureIso("X"), `Emptyland ${stamp}`);
  const seven = await ensureFixtureCountry(fixtureIso("Y"), `Sevenland ${stamp}`);

  emptyIso = empty.iso;
  sevenIso = seven.iso;

  const creations = await Promise.all(
    Array.from({ length: 7 }, (_, index) => createFixtureDish(`seven-${index}`, { iso: sevenIso })),
  );

  expect(creations).toHaveLength(7);

  const noGeo = await createFixtureDish("no-geo");
  noGeoSlug = noGeo.slug;

  const review = await createFixtureDish("review-hidden", { iso: sevenIso, status: "review" });
  reviewSlug = review.slug;

  // Imported -> review -> published path: one record through the real
  // validate/apply pipeline, linked to a seeded country.
  const sourceName = `${PREFIX}import-source`;
  const slug = `${PREFIX}imported-pho`;

  const report = await run(
    Effect.flatMap(CatalogImportService, (service) =>
      service.validateImport({
        sourceName,
        payload: {
          source_name: sourceName,
          records: [
            {
              slug,
              names: [
                {
                  language_tag: "en",
                  name: `Imported Carousel Pho ${stamp}`,
                  name_kind: "localized",
                },
              ],
              descriptions: [
                {
                  language_tag: "en",
                  description: `Imported dish for carousel coverage ${stamp}.`,
                  summary: null,
                },
              ],
              places: [{ iso: "VN", association: "origin" }],
              categories: ["soup"],
            },
          ],
        },
        license: MANUAL_LICENSE,
      }),
    ),
  );

  expect(report.validRecords).toBe(1);

  const applied = await run(
    Effect.flatMap(CatalogImportService, (service) =>
      service.applyImport({
        jobId: report.jobId,
        approvals: { licenseAck: true, reviewAck: true, duplicateRefs: [] },
        actorUserId: ACTOR,
      }),
    ),
  );

  expect(applied.applied).toBe(1);

  const appliedDishId = await query(
    (sql) => sql<Array<{ dishId: string }>>`
      SELECT dish_id::text AS "dishId" FROM feastjourney.catalog_import_records
      WHERE job_id = ${report.jobId}::bigint AND status = 'applied' LIMIT 1`,
  );

  const dishId = appliedDishId[0]?.dishId;

  if (dishId === undefined) {
    throw new Error("applied import record has no dish id");
  }

  await run(
    Effect.flatMap(AdminService, (service) => service.updateDishStatus(ACTOR, dishId, "published")),
  );

  importSlug = slug;
});

afterAll(async () => {
  await query((sql) => sql`DELETE FROM feastjourney.dishes WHERE slug LIKE ${`${PREFIX}%`}`);
  await query((sql) => sql`DELETE FROM feastjourney.places WHERE display_note = ${MARKER}`);
});

describe("discovery carousel", () => {
  test("imported then published dishes become discoverable", async () => {
    const detail = await run(
      Effect.flatMap(DishService, (service) => service.getDish(importSlug, "en")),
    );

    expect(detail.slug).toBe(importSlug);

    const search = await run(
      Effect.flatMap(DishService, (service) =>
        service.searchDishes({ q: `Imported Carousel Pho ${stamp}`, locale: "en", limit: 20 }),
      ),
    );

    expect(search.items.map((item) => item.slug)).toContain(importSlug);

    const slugs = await carouselSlugs({ country: "VN", limit: 20 });

    expect(slugs).toContain(importSlug);
  });

  test("review-status dishes stay invisible on every public surface", async () => {
    const detail = await runFailure(
      Effect.flatMap(DishService, (service) => service.getDish(reviewSlug, "en")),
    );

    expect(detail).toBeInstanceOf(DishNotFound);

    const search = await run(
      Effect.flatMap(DishService, (service) =>
        service.searchDishes({
          q: `Carousel Dish review-hidden ${stamp}`,
          locale: "en",
          limit: 20,
        }),
      ),
    );

    expect(search.items.map((item) => item.slug)).not.toContain(reviewSlug);

    const worldwide = await carouselSlugs({ worldwide: true, limit: 100 });

    expect(worldwide).not.toContain(reviewSlug);

    const country = await carouselSlugs({ country: sevenIso, limit: 20 });

    expect(country).not.toContain(reviewSlug);
  });

  test("dishes without geo associations never appear as nearby", async () => {
    // Fixture centroid (-25,-15) is the nearest place to itself; the
    // no-geo dish has no place links at all. Under the honest-empty
    // contract the request either serves a nearby band (which can only hold
    // place-linked dishes) or an honest empty — never a silent worldwide
    // pool.
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", latitude: -25.0, longitude: -15.0, limit: 20 }),
      ),
    );

    if (output.scope === "nearby" && output.items.length > 0) {
      expect(output.items.map((item) => item.slug)).not.toContain(noGeoSlug);
    } else {
      expect(output.scope).toBe("nearby");
      expect(output.fallback).toBe(true);
      expect(output.items).toEqual([]);
    }

    const worldwide = await carouselSlugs({ worldwide: true, limit: 100 });

    expect(worldwide).toContain(noGeoSlug);
  });

  test("no location at all resolves to an honest empty outcome", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) => service.getLocalCarousel({ locale: "en" })),
    );

    expect(output.items).toEqual([]);
  });

  test("zero-dish country resolves to an honest empty, never silent worldwide dishes", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", country: emptyIso, limit: 10 }),
      ),
    );

    expect(output.requestedScope).toBe("country");
    expect(output.scope).toBe("country");
    expect(output.fallback).toBe(true);
    expect(output.fallbackReason).toBe("country-empty");
    expect(output.items).toEqual([]);
  });

  test("worldwide scope returns real published dishes", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", worldwide: true, limit: 5 }),
      ),
    );

    expect(output.items.length).toBeGreaterThan(0);

    for (const item of output.items) {
      expect(item.slug.length).toBeGreaterThan(0);
      expect(item.id).toMatch(/^[0-9]+$/);
    }
  });

  test("more than five eligible dishes honors the limit", async () => {
    const def = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", country: sevenIso }),
      ),
    );

    expect(def.items).toHaveLength(5);

    const wide = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", country: sevenIso, limit: 7 }),
      ),
    );

    expect(wide.items).toHaveLength(7);

    const slugs = wide.items.map((item) => item.slug);

    for (let index = 0; index < 7; index += 1) {
      expect(slugs).toContain(`${PREFIX}seven-${index}`);
    }
  });

  test("repeat calls are session-stable per seed (default seed is 0)", async () => {
    const input = { locale: "en", country: sevenIso, limit: 7 } as const;

    const first = await run(
      Effect.flatMap(DishService, (service) => service.getLocalCarousel({ ...input })),
    );

    const second = await run(
      Effect.flatMap(DishService, (service) => service.getLocalCarousel({ ...input })),
    );

    const third = await run(
      Effect.flatMap(DishService, (service) => service.getLocalCarousel({ ...input })),
    );

    expect(cardIds(second.items)).toEqual(cardIds(first.items));
    expect(cardIds(third.items)).toEqual(cardIds(first.items));

    const seeded = await run(
      Effect.flatMap(DishService, (service) => service.getLocalCarousel({ ...input, seed: 0 })),
    );

    expect(cardIds(seeded.items)).toEqual(cardIds(first.items));
  });

  test("a new seed rotates the window while keeping the same pool", async () => {
    const orders = await Promise.all(
      [0, 1, 2, 3, 4].map(async (seed) => carouselSlugs({ country: sevenIso, limit: 7, seed })),
    );

    const expected = Array.from({ length: 7 }, (_, index) => `${PREFIX}seven-${index}`).toSorted();

    for (const order of orders) {
      expect([...order].toSorted()).toEqual(expected);
    }

    const distinct = new Set(orders.map((order) => order.join(",")));

    expect(distinct.size).toBeGreaterThan(1);
  });

  test("served scope labels what the cards actually are", async () => {
    const country = await carouselScopes({ country: sevenIso, limit: 5 });

    expect(country.scope).toBe("country");

    const worldwide = await carouselScopes({ worldwide: true, limit: 5 });

    expect(worldwide.scope).toBe("worldwide");

    const none = await carouselScopes({});

    expect(none.slugs).toEqual([]);
    expect(none.scope).toBe("worldwide");

    const ocean = await carouselScopes({ latitude: 0, longitude: -160, limit: 5 });

    expect(ocean.slugs).toEqual([]);
    expect(ocean.scope).toBe("nearby");
    expect(ocean.fallback).toBe(true);

    const emptyCountry = await carouselScopes({ country: emptyIso, limit: 5 });

    expect(emptyCountry.slugs).toEqual([]);
    expect(emptyCountry.scope).toBe("country");
    expect(emptyCountry.fallback).toBe(true);
  });

  test("country selection is per-country appropriate", async () => {
    const home = await carouselSlugs({ country: sevenIso, limit: 20 });

    expect(home).toContain(`${PREFIX}seven-0`);

    // An empty country is an honest empty: the client offers the explicit
    // worldwide escape hatch instead of silent worldwide dishes.
    const away = await carouselScopes({ country: emptyIso, limit: 20 });

    expect(away.scope).toBe("country");
    expect(away.fallback).toBe(true);
    expect(away.slugs).toEqual([]);
  });

  test("boundary coordinates are accepted, out-of-range rejected", async () => {
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

    for (const output of accepted) {
      expect(output.items).toBeDefined();
    }

    const rejected = await Promise.all(
      [
        [90.1, 0],
        [-90.1, 0],
        [0, 180.1],
        [0, -180.1],
        [Number.NaN, 0],
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
  });

  test("sparse ocean visitor resolves to an honest empty, never a far continent", async () => {
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

  test("malformed country codes fail closed", async () => {
    const failures = await Promise.all(
      ["usa", "U", "XX-TOOLONG", "12"].map((country) =>
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

  test("unknown well-formed country is a typed PlaceNotFound", async () => {
    const carousel = await runFailure(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", country: "ZZ", limit: 5 }),
      ),
    );

    expect(carousel).toBeInstanceOf(PlaceNotFound);

    const search = await runFailure(
      Effect.flatMap(DishService, (service) =>
        service.searchDishes({ locale: "en", country: "ZZ", limit: 5 }),
      ),
    );

    expect(search).toBeInstanceOf(PlaceNotFound);
  });

  test("carousel cards carry publication-gated images, never invented photos", async () => {
    const output = await run(
      Effect.flatMap(DishService, (service) =>
        service.getLocalCarousel({ locale: "en", country: sevenIso, limit: 7 }),
      ),
    );

    // No photos were staged for fixtures: every card renders the
    // placeholder path (image null), never an invented URL.
    expect(output.items).toHaveLength(7);

    for (const item of output.items) {
      expect(item.image).toBeNull();
      expect(item.slug.startsWith(PREFIX)).toBe(true);
    }
  });
});

describe("carousel image projection (Garage delivery URLs)", () => {
  const baseRow: DishPublishedMediaRow = {
    id: "123",
    dish_id: "456",
    public_url: null,
    object_key: null,
    attribution: "Test Kitchen",
    license: "own-work",
    status: "published",
    sort_order: 0,
    alt_text: "A test bowl",
    focal_x: 0.5,
    focal_y: 0.4,
    original_width: 1200,
    original_height: 800,
    format: "webp",
    byte_size: 42000n,
    checksum_sha256: "abc",
    variant_version: 1,
    uploaded_by: "tester",
    processing: "ready",
    reviewed_at: null,
    published_at: "2026-01-01T00:00:00.000Z",
    source_url: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  test("Garage-stored rows project generated same-origin delivery URLs", () => {
    const projected = toPublishedImage({ ...baseRow, object_key: "dishes/456/123/v1" });

    expect(projected).not.toBeNull();
    expect(projected?.url).toContain("/api/v1/dish-images/123/1/1600");
    expect(projected?.srcSet).toContain("/api/v1/dish-images/123/1/400");
    expect(projected?.alt).toBe("A test bowl");
    expect(projected?.attribution).toBe("Test Kitchen");
  });

  test("legacy external rows fall back to the stored public URL without srcSet", () => {
    const projected = toPublishedImage({
      ...baseRow,
      object_key: null,
      public_url: "https://example.com/legacy.jpg",
    });

    expect(projected?.url).toBe("https://example.com/legacy.jpg");
    expect(projected?.srcSet).toBeNull();
  });

  test("rows with neither stored bytes nor public URL project to null (placeholder)", () => {
    expect(toPublishedImage({ ...baseRow, object_key: null, public_url: null })).toBeNull();
  });
});
