// oxlint-disable-next-line import/no-unassigned-import -- side-effectful test environment setup, runs before server modules initialize.
import "./cleanup";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { SQL } from "bun";
import { Effect } from "effect";

import { InvalidLocale } from "@/modules/food-discovery/server/domain/errors";
import {
  ConflictingTaxonomy,
  InvalidTaxonomyData,
  TaxonomyAdminService,
  TaxonomyAdminServiceLive,
} from "@/modules/food-discovery/server/operations/taxonomy-admin-service";
import { Actor } from "@/server/auth/actor";
import { type CurrentActor, withActor } from "@/server/auth/current-actor";
import { InsufficientPermissions } from "@/server/auth/errors";
import type { AppServices } from "@/server/layers";
import { appRuntime } from "@/server/runtime";

import { createFoodAuth } from "./food-auth";

/**
 * Curator taxonomy administration: cuisines and ingredients without code
 * deploys. Covers single create (derived/explicit slugs, duplicates,
 * validation), bulk create with per-row isolation (valid rows land while
 * duplicates and invalid rows are reported, never failing the batch),
 * search/pagination listing, `food:import` denials for ungranted actors,
 * and in-transaction audit logging.
 *
 * Isolation: every fixture slug/name carries a unique per-file stamp; only
 * owned cuisine rows, owned ingredient rows, owned audit rows, and the owned
 * test role are deleted. Seed taxonomy is read-only.
 */

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const SLUG_PREFIX = `e2etax${stamp}`;
const roleId = `test-tax-admin-${stamp}`;
const ownedIngredientIds: Array<string> = [];

const foodAuth = createFoodAuth();

let curatorUserId = "";
let plainUserId = "";

const runAs = <A, E>(
  userId: string,
  effect: Effect.Effect<A, E, TaxonomyAdminService | AppServices | CurrentActor>,
): Promise<A> =>
  appRuntime.runPromise(
    withActor(Actor.Member({ userId }), effect).pipe(Effect.provide(TaxonomyAdminServiceLive)),
  );

const runAsFailure = <A, E>(
  userId: string,
  effect: Effect.Effect<A, E, TaxonomyAdminService | AppServices | CurrentActor>,
): Promise<E> =>
  appRuntime.runPromise(
    Effect.flip(
      withActor(Actor.Member({ userId }), effect).pipe(Effect.provide(TaxonomyAdminServiceLive)),
    ),
  );

const audit = (tag: string) => ({
  requestId: `tax-${stamp}-${tag}`,
  sessionId: null,
});

const query = async <T>(statement: (sql: SQL) => Promise<T>): Promise<T> => {
  const sql = new SQL(process.env.DATABASE_URL ?? "");

  try {
    return await statement(sql);
  } finally {
    await sql.end();
  }
};

const auditCount = (requestId: string, event: string): Promise<number> =>
  query(async (sql) => {
    const rows = await sql<Array<{ count: number }>>`SELECT count(*)::int AS count
      FROM feastjourney.security_audit_events
      WHERE request_id = ${requestId} AND event = ${event}`;

    return rows[0]?.count ?? 0;
  });

beforeAll(async () => {
  expect(process.env.DATABASE_URL).toBeTruthy();

  await query(
    (sql) =>
      sql`INSERT INTO feastjourney.roles (id, slug, name) VALUES (${roleId}, ${roleId}, ${roleId}) ON CONFLICT DO NOTHING`,
  );
  await query(
    (sql) =>
      sql`INSERT INTO feastjourney.role_permissions (role_id, permission_key) VALUES (${roleId}, 'food:import') ON CONFLICT DO NOTHING`,
  );

  const curatorSession = await foodAuth.signupSignin("tax-curator");
  const plainSession = await foodAuth.signupSignin("tax-viewer");

  await foodAuth.grantRole(curatorSession.userId, roleId);

  curatorUserId = curatorSession.userId;
  plainUserId = plainSession.userId;
});

afterAll(async () => {
  await query((sql) => sql`DELETE FROM feastjourney.cuisines WHERE slug LIKE ${`${SLUG_PREFIX}%`}`);

  await Promise.all(
    ownedIngredientIds.map((id) =>
      query((sql) => sql`DELETE FROM feastjourney.ingredients WHERE id = ${id}::bigint`),
    ),
  );

  await query(
    (sql) =>
      sql`DELETE FROM feastjourney.security_audit_events WHERE request_id LIKE ${`tax-${stamp}%`}`,
  );
  await query((sql) => sql`DELETE FROM feastjourney.roles WHERE id = ${roleId}`);
  await foodAuth.close();
});

describe("cuisine administration", () => {
  test("creates a cuisine with a slug derived from the display name", async () => {
    const name = `E2etax${stamp} Fusion`;

    const created = await runAs(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.createCuisine({ name }, audit("cuisine-create")),
      ),
    );

    expect(created.slug).toBe(`${SLUG_PREFIX}-fusion`);
    expect(created.name).toBe(name);
    expect(created.id).toMatch(/^[0-9]+$/);
    expect(await auditCount(`tax-${stamp}-cuisine-create`, "food.taxonomy.cuisine.created")).toBe(
      1,
    );
  });

  test("creates a cuisine with an explicit slug and refuses duplicates", async () => {
    const slug = `${SLUG_PREFIX}-explicit`;

    const created = await runAs(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.createCuisine({ slug, name: `Explicit ${stamp}` }, audit("cuisine-explicit")),
      ),
    );

    expect(created.slug).toBe(slug);

    const duplicate = await runAsFailure(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.createCuisine({ slug, name: `Explicit ${stamp}` }, audit("cuisine-duplicate")),
      ),
    );

    expect(duplicate).toBeInstanceOf(ConflictingTaxonomy);
  });

  test("rejects invalid slugs and unusable names", async () => {
    const badSlug = await runAsFailure(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.createCuisine({ slug: "Not A Slug", name: `Bad ${stamp}` }, audit("bad-slug")),
      ),
    );

    expect(badSlug).toBeInstanceOf(InvalidTaxonomyData);

    const blankName = await runAsFailure(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.createCuisine({ name: "   " }, audit("blank-name")),
      ),
    );

    expect(blankName).toBeInstanceOf(InvalidTaxonomyData);
  });

  test("bulk create isolates per-row failures: valid rows land, duplicates skip, invalid rows report", async () => {
    const report = await runAs(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.bulkCreateCuisines(
          {
            entries: [
              { name: `E2etax${stamp} Bulk One` },
              { name: `E2etax${stamp} Bulk Two`, slug: `${SLUG_PREFIX}-bulk-two` },
              { name: `E2etax${stamp} Bulk One` },
              { slug: "BAD SLUG", name: `E2etax${stamp} Bulk Bad` },
              { name: "" },
            ],
          },
          audit("cuisine-bulk"),
        ),
      ),
    );

    expect(report.created.map((entry) => entry.slug)).toEqual([
      `${SLUG_PREFIX}-bulk-one`,
      `${SLUG_PREFIX}-bulk-two`,
    ]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]?.reason).toMatch(/already exists|duplicate/);
    expect(report.invalid).toHaveLength(2);
    expect(await auditCount(`tax-${stamp}-cuisine-bulk`, "food.taxonomy.cuisine.created")).toBe(2);
  });

  test("lists cuisines with search filtering and pagination", async () => {
    const first = await runAs(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.listCuisines({ query: `e2etax${stamp} fusion`, limit: 20, offset: 0 }),
      ),
    );

    expect(first.cuisines.map((entry) => entry.slug)).toContain(`${SLUG_PREFIX}-fusion`);

    const page = await runAs(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.listCuisines({ query: `e2etax${stamp} bulk`, limit: 1, offset: 1 }),
      ),
    );

    expect(page.cuisines).toHaveLength(1);
    expect(page.cuisines[0]?.slug).toBe(`${SLUG_PREFIX}-bulk-two`);

    const unsearchable = await runAs(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.listCuisines({ query: "!!!", limit: 20, offset: 0 }),
      ),
    );

    expect(unsearchable.cuisines).toEqual([]);
  });

  test("denies cuisine writes without the food:import grant", async () => {
    const single = await runAsFailure(
      plainUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.createCuisine({ name: `Denied ${stamp}` }, audit("cuisine-denied")),
      ),
    );

    expect(single).toBeInstanceOf(InsufficientPermissions);

    const bulk = await runAsFailure(
      plainUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.bulkCreateCuisines(
          { entries: [{ name: `Denied ${stamp}` }] },
          audit("bulk-denied"),
        ),
      ),
    );

    expect(bulk).toBeInstanceOf(InsufficientPermissions);
  });
});

describe("ingredient administration", () => {
  test("creates an ingredient with the default English name and search key", async () => {
    const name = `E2etax${stamp} Moonleaf`;

    const created = await runAs(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.createIngredient({ name }, audit("ingredient-create")),
      ),
    );

    ownedIngredientIds.push(created.id);
    expect(created.name).toBe(name);
    expect(created.id).toMatch(/^[0-9]+$/);
    expect(
      await auditCount(`tax-${stamp}-ingredient-create`, "food.taxonomy.ingredient.created"),
    ).toBe(1);

    const listed = await runAs(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.listIngredients({ query: `e2etax${stamp} moonleaf`, limit: 10, offset: 0 }),
      ),
    );

    expect(listed.ingredients.map((entry) => entry.id)).toContain(created.id);
  });

  test("refuses duplicate ingredient names and invalid locales", async () => {
    const duplicate = await runAsFailure(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.createIngredient(
          { name: `E2etax${stamp} Moonleaf` },
          audit("ingredient-duplicate"),
        ),
      ),
    );

    expect(duplicate).toBeInstanceOf(ConflictingTaxonomy);

    const badLocale = await runAsFailure(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.createIngredient(
          { name: `E2etax${stamp} Starroot`, languageTag: "not-a-locale!!" },
          audit("ingredient-locale"),
        ),
      ),
    );

    expect(badLocale).toBeInstanceOf(InvalidLocale);
  });

  test("bulk create reports per-row outcomes without failing the batch", async () => {
    const report = await runAs(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.bulkCreateIngredients(
          {
            entries: [
              { name: `E2etax${stamp} Sunpepper` },
              { name: `E2etax${stamp} Sunpepper` },
              { name: `E2etax${stamp} Moonleaf` },
              { name: "  " },
              { name: `E2etax${stamp} Starroot`, languageTag: "xx!" },
            ],
          },
          audit("ingredient-bulk"),
        ),
      ),
    );

    for (const entry of report.created) {
      ownedIngredientIds.push(entry.id);
    }

    expect(report.created).toHaveLength(1);
    expect(report.created[0]?.name).toBe(`E2etax${stamp} Sunpepper`);
    expect(report.skipped).toHaveLength(2);
    expect(report.invalid).toHaveLength(2);
    expect(
      await auditCount(`tax-${stamp}-ingredient-bulk`, "food.taxonomy.ingredient.created"),
    ).toBe(1);
  });

  test("lists ingredients with and without a query", async () => {
    const filtered = await runAs(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.listIngredients({ query: `e2etax${stamp} sunpepper`, limit: 10, offset: 0 }),
      ),
    );

    expect(filtered.ingredients).toHaveLength(1);

    const unfiltered = await runAs(
      curatorUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.listIngredients({ limit: 5, offset: 0 }),
      ),
    );

    expect(unfiltered.ingredients).toHaveLength(5);
  });

  test("denies ingredient writes without the food:import grant", async () => {
    const single = await runAsFailure(
      plainUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.createIngredient({ name: `Denied ${stamp}` }, audit("ingredient-denied")),
      ),
    );

    expect(single).toBeInstanceOf(InsufficientPermissions);

    const bulk = await runAsFailure(
      plainUserId,
      Effect.flatMap(TaxonomyAdminService, (service) =>
        service.bulkCreateIngredients(
          { entries: [{ name: `Denied ${stamp}` }] },
          audit("ingredient-bulk-denied"),
        ),
      ),
    );

    expect(bulk).toBeInstanceOf(InsufficientPermissions);
  });
});
