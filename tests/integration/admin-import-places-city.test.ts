// oxlint-disable-next-line import/no-unassigned-import -- side-effectful test environment setup, runs before server modules initialize.
import "./cleanup";
import { afterAll, describe, expect, test } from "bun:test";

import { SQL } from "bun";
import { Effect } from "effect";

import { CatalogImportService } from "@/modules/food-discovery/server/operations/catalog-import-service";
import type { AppServices } from "@/server/layers";
import { appRuntime } from "@/server/runtime";

/**
 * City/province-level import places (workstream 3).
 *
 * Covers the shared place-entry grammar at the service boundary:
 * `City@Parent` / bare-city resolution against the place registry, the
 * `{city, parent_iso}` JSON object form (plus arrays for multiple
 * associations), CSV-grammar strings, alias recall, scoped disambiguation,
 * ambiguous/missing validation issues, no silent country fallback, the
 * omitted-association default (`associated`, never `origin`), and backward
 * compatibility for existing `{iso}` / `{place_id}` links on both the
 * single-shot and the batched stage paths.
 *
 * Registry isolation: real seeded cities (Hanoi, Bengaluru) are read-only
 * fixtures; the ambiguity collider uses a stamp-unique `Testville<stamp>`
 * locality pair created and removed by this suite, so parallel suites never
 * observe it.
 */

const run = <A, E, R extends AppServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  appRuntime.runPromise(effect);

const query = async <T>(statement: (sql: SQL) => Promise<T>): Promise<T> => {
  const sql = new SQL(process.env.DATABASE_URL ?? "");

  try {
    return await statement(sql);
  } finally {
    await sql.end();
  }
};

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.replace(
  /[^a-z0-9]/g,
  "",
);

const MANUAL_LICENSE = "manual:manual-entry";
const APPROVER = `city-import:test-approver-${stamp}`;

interface DishName {
  readonly language_tag: string;
  readonly name: string;
  readonly name_kind: string;
}

const dishRecord = (name: string, places: ReadonlyArray<unknown>, slug?: string) => {
  const names: Array<DishName> = [{ language_tag: "en", name, name_kind: "localized" }];

  const record: {
    readonly names: ReadonlyArray<DishName>;
    readonly categories: ReadonlyArray<string>;
    readonly places: ReadonlyArray<unknown>;
    readonly slug?: string;
  } =
    slug === undefined
      ? { names, categories: ["soup"], places }
      : { names, categories: ["soup"], places, slug };

  return record;
};

const validateRecords = (sourceName: string, records: ReadonlyArray<unknown>) =>
  run(
    Effect.flatMap(CatalogImportService, (service) =>
      service.validateImport({
        sourceName,
        payload: { source_name: sourceName, records: [...records] },
        license: MANUAL_LICENSE,
      }),
    ),
  );

const applyJob = (jobId: string) =>
  run(
    Effect.flatMap(CatalogImportService, (service) =>
      service.applyImport({
        jobId,
        approvals: { licenseAck: false, reviewAck: true, duplicateRefs: [] },
        actorUserId: APPROVER,
      }),
    ),
  );

const appliedDishId = async (jobId: string): Promise<bigint> => {
  const rows = await query<Array<{ readonly dish_id: string | null }>>(
    (sql) =>
      sql`SELECT dish_id::text AS dish_id FROM feastjourney.catalog_import_records WHERE job_id = ${BigInt(jobId)} AND status = 'applied' LIMIT 100`,
  );

  const first = rows[0];

  expect(first?.dish_id).not.toBeNull();

  return BigInt(first?.dish_id ?? "0");
};

const appliedDishIds = (jobId: string): Promise<Array<bigint>> =>
  query<Array<{ readonly dish_id: string | null }>>(
    (sql) =>
      sql`SELECT dish_id::text AS dish_id FROM feastjourney.catalog_import_records WHERE job_id = ${BigInt(jobId)} AND status = 'applied' ORDER BY dish_id ASC LIMIT 100`,
  ).then((rows) => rows.map((row) => BigInt(row.dish_id ?? "0")));

interface DishPlaceLink {
  readonly place_id: string;
  readonly association: string;
}

const dishPlaceLinks = (dishId: bigint): Promise<Array<DishPlaceLink>> =>
  query<Array<DishPlaceLink>>(
    (sql) =>
      sql`SELECT place_id::text AS place_id, association FROM feastjourney.dish_places WHERE dish_id = ${dishId}`,
  );

const placeIdByPreferredName = async (name: string): Promise<bigint> => {
  const rows = await query<Array<{ readonly id: string }>>(
    (sql) =>
      sql`SELECT p.id::text AS id FROM feastjourney.places AS p JOIN feastjourney.place_names AS n ON n.place_id = p.id WHERE n.language_tag = 'en' AND n.is_preferred AND n.name = ${name} LIMIT 1`,
  );

  const first = rows[0];

  expect(first).toBeDefined();

  return BigInt(first?.id ?? "0");
};

const placeIdByIso = async (iso: string): Promise<bigint> => {
  const rows = await query<Array<{ readonly id: string }>>(
    (sql) => sql`SELECT id::text AS id FROM feastjourney.places WHERE iso3166 = ${iso} LIMIT 1`,
  );

  const first = rows[0];

  expect(first).toBeDefined();

  return BigInt(first?.id ?? "0");
};

interface Collider {
  readonly name: string;
  readonly firstId: bigint;
  readonly secondId: bigint;
}

const seedColliderPair = async (name: string): Promise<Collider> => {
  const vn = await placeIdByIso("VN");
  const us = await placeIdByIso("US");

  const first = await query<Array<{ readonly id: string }>>(
    (sql) =>
      sql`INSERT INTO feastjourney.places (kind) VALUES ('locality') RETURNING id::text AS id`,
  );

  const second = await query<Array<{ readonly id: string }>>(
    (sql) =>
      sql`INSERT INTO feastjourney.places (kind) VALUES ('locality') RETURNING id::text AS id`,
  );

  const firstId = BigInt(first[0]?.id ?? "0");
  const secondId = BigInt(second[0]?.id ?? "0");

  await query(
    (sql) => sql`
      INSERT INTO feastjourney.place_names (place_id, language_tag, name, is_preferred, search_key)
      VALUES (${firstId}, 'en', ${name}, TRUE, lower(public.unaccent(${name}))),
             (${secondId}, 'en', ${name}, TRUE, lower(public.unaccent(${name})))`,
  );
  await query(
    (sql) => sql`
      INSERT INTO feastjourney.place_parents (place_id, parent_place_id)
      VALUES (${firstId}, ${vn}), (${secondId}, ${us})`,
  );

  return { name, firstId, secondId };
};

const removeColliderPair = async (collider: Collider): Promise<void> => {
  const ids = [collider.firstId, collider.secondId];

  await query(
    (sql) => sql`DELETE FROM feastjourney.place_parents WHERE place_id = ANY(${ids}::bigint[])`,
  );
  await query(
    (sql) => sql`DELETE FROM feastjourney.place_names WHERE place_id = ANY(${ids}::bigint[])`,
  );
  await query((sql) => sql`DELETE FROM feastjourney.places WHERE id = ANY(${ids}::bigint[])`);
};

afterAll(async () => {
  // Data hygiene: applied dishes link Hanoi/Bengaluru/VN and would pollute
  // the shared database for suites that need an empty Hanoi pool
  // (recommendation honest fallbacks). Slugs derive from the stamp-unique
  // dish names, so one prefix match removes exactly this file's dishes;
  // dish rows cascade to dish_places/names/descriptions.
  await query((sql) => sql`DELETE FROM feastjourney.dishes WHERE slug LIKE ${`%${stamp}%`}`);
});

describe("admin import city/province places", () => {
  test("JSON city@parent object resolves and applies with explicit origin", async () => {
    const hanoi = await placeIdByPreferredName("Hanoi");

    const vn = await placeIdByIso("VN");

    const sourceName = `city-object-${stamp}`;

    const report = await validateRecords(sourceName, [
      dishRecord(`City Dish ${stamp}`, [
        { city: "Hanoi", parent_iso: "VN", association: "origin" },
        { iso: "VN", association: "associated" },
      ]),
    ]);

    expect(report.validRecords).toBe(1);
    expect(report.invalidRecords).toBe(0);

    const applied = await applyJob(report.jobId);

    expect(applied.applied).toBe(1);

    const links = await dishPlaceLinks(await appliedDishId(report.jobId));
    const byPlace = new Map(links.map((link) => [link.place_id, link.association]));

    expect(byPlace.get(hanoi.toString())).toBe("origin");
    expect(byPlace.get(vn.toString())).toBe("associated");
  });

  test("omitted association defaults to associated, never origin", async () => {
    const hanoi = await placeIdByPreferredName("Hanoi");

    const report = await validateRecords(`city-default-${stamp}`, [
      dishRecord(`City Default Dish ${stamp}`, [{ city: "Hanoi", parent_iso: "VN" }]),
    ]);

    expect(report.validRecords).toBe(1);

    const applied = await applyJob(report.jobId);

    expect(applied.applied).toBe(1);

    const links = await dishPlaceLinks(await appliedDishId(report.jobId));

    expect(links).toEqual([{ place_id: hanoi.toString(), association: "associated" }]);
  });

  test("bare city and alias resolve when unambiguous", async () => {
    const bengaluru = await placeIdByPreferredName("Bengaluru");

    const report = await validateRecords(`city-bare-${stamp}`, [
      dishRecord(`Bare City Dish ${stamp}`, [{ city: "Bengaluru" }]),
      dishRecord(`Alias City Dish ${stamp}`, [{ city: "Bangalore", parent_iso: "IN-KA" }]),
    ]);

    expect(report.validRecords).toBe(2);
    expect(report.invalidRecords).toBe(0);

    const applied = await applyJob(report.jobId);

    expect(applied.applied).toBe(2);

    const ids = await appliedDishIds(report.jobId);

    expect(ids.length).toBe(2);

    const allBareLinks = await Promise.all(ids.map((id) => dishPlaceLinks(id)));

    for (const links of allBareLinks) {
      expect(links).toEqual([{ place_id: bengaluru.toString(), association: "associated" }]);
    }
  });

  test("scoped City@Parent beats a same-named collider; bare name is ambiguous", async () => {
    const collider = await seedColliderPair(`Testville${stamp}`);

    // The applied dish links the collider place (RESTRICT); remove dishes
    // before places so the finally cleanup can always run.
    const appliedIds: Array<bigint> = [];

    try {
      const scoped = await validateRecords(`city-scoped-${stamp}`, [
        dishRecord(`Scoped City Dish ${stamp}`, [
          { city: collider.name, parent_iso: "VN", association: "popular" },
        ]),
      ]);

      expect(scoped.validRecords).toBe(1);

      const applied = await applyJob(scoped.jobId);

      expect(applied.applied).toBe(1);

      appliedIds.push(...(await appliedDishIds(scoped.jobId)));

      const links = await dishPlaceLinks(await appliedDishId(scoped.jobId));

      expect(links).toEqual([{ place_id: collider.firstId.toString(), association: "popular" }]);

      const ambiguous = await validateRecords(`city-ambiguous-${stamp}`, [
        dishRecord(`Ambiguous City Dish ${stamp}`, [{ city: collider.name }]),
      ]);

      expect(ambiguous.validRecords).toBe(0);
      expect(ambiguous.invalidRecords).toBe(1);

      const message = ambiguous.items[0]?.errors.join(" ") ?? "";

      expect(message).toContain("ambiguous city");
      expect(message).toContain("2 places");
      expect(message).toContain(collider.firstId.toString());
      expect(message).toContain(collider.secondId.toString());
      expect(message).toContain("place:<id>");
    } finally {
      for (const dishId of appliedIds) {
        // eslint-disable-next-line no-await-in-loop -- sequential deletes keep dish_places cascade order deterministic
        await query((sql) => sql`DELETE FROM feastjourney.dishes WHERE id = ${dishId}`);
      }

      await removeColliderPair(collider);
    }
  });

  test("unknown city, unknown parent, and no country fallback are actionable invalids", async () => {
    const vn = await placeIdByIso("VN");
    const missingName = `Nowhereville${stamp}`;

    const report = await validateRecords(`city-missing-${stamp}`, [
      dishRecord(`Missing City Dish ${stamp}`, [{ city: missingName, parent_iso: "VN" }]),
      dishRecord(`Missing Parent Dish ${stamp}`, [{ city: "Hanoi", parent_iso: "XX" }]),
      dishRecord(`Atlantis Dish ${stamp}`, [{ city: `Atlantis${stamp}` }]),
    ]);

    expect(report.validRecords).toBe(0);
    expect(report.invalidRecords).toBe(3);

    const messages = report.items.map((item) => item.errors.join(" "));

    expect(messages[0]).toContain(`unknown place "${missingName}@VN"`);
    expect(messages[0]).toContain("Place Manager");
    expect(messages[1]).toContain('unknown parent place iso "XX"');
    expect(messages[2]).toContain("unknown place");
    expect(messages[2]).toContain("Place Manager");

    // No silent country fallback: none of the rows may link the VN country row.
    const invalidRows = await query<Array<{ readonly status: string }>>(
      (sql) =>
        sql`SELECT status FROM feastjourney.catalog_import_records WHERE job_id = ${BigInt(report.jobId)} LIMIT 100`,
    );

    expect(invalidRows.length).toBe(3);
    expect(invalidRows.every((row) => row.status === "invalid")).toBe(true);
    expect(vn).not.toBeNull();
  });

  test("CSV grammar strings resolve with comma and semicolon separators", async () => {
    const hanoi = await placeIdByPreferredName("Hanoi");
    const bengaluru = await placeIdByPreferredName("Bengaluru");
    const vn = await placeIdByIso("VN");

    const report = await validateRecords(`city-strings-${stamp}`, [
      dishRecord(`String City Dish ${stamp}`, [`Hanoi@VN:popular, Bengaluru@IN-KA;VN:origin`]),
    ]);

    expect(report.validRecords).toBe(1);

    const applied = await applyJob(report.jobId);

    expect(applied.applied).toBe(1);

    const links = await dishPlaceLinks(await appliedDishId(report.jobId));
    const byPlace = new Map(links.map((link) => [link.place_id, link.association]));

    expect(byPlace.get(hanoi.toString())).toBe("popular");
    expect(byPlace.get(bengaluru.toString())).toBe("associated");
    expect(byPlace.get(vn.toString())).toBe("origin");
  });

  test("unsupported association text is an actionable invalid", async () => {
    const report = await validateRecords(`city-badassoc-${stamp}`, [
      dishRecord(`Bad Assoc Dish ${stamp}`, [`Hanoi@VN:bogus`]),
    ]);

    expect(report.validRecords).toBe(0);
    expect(report.invalidRecords).toBe(1);
    expect(report.items[0]?.errors.join(" ")).toContain("unsupported place association");
  });

  test("backward compatibility: iso, place_id, and invalid references behave as before", async () => {
    const hanoi = await placeIdByPreferredName("Hanoi");

    const report = await validateRecords(`city-compat-${stamp}`, [
      dishRecord(`Compat Iso Dish ${stamp}`, [{ iso: "VN", association: "origin" }]),
      dishRecord(`Compat Id Dish ${stamp}`, [
        { place_id: hanoi.toString(), association: "popular" },
      ]),
      dishRecord(`Compat Unknown Dish ${stamp}`, [{ iso: "XX", association: "origin" }]),
    ]);

    expect(report.validRecords).toBe(2);
    expect(report.invalidRecords).toBe(1);
    expect(report.items[2]?.errors.join(" ")).toContain('unknown place iso "XX"');

    const applied = await applyJob(report.jobId);

    expect(applied.applied).toBe(2);
  });

  test("batched stage path normalizes city forms and applies them", async () => {
    const hanoi = await placeIdByPreferredName("Hanoi");

    const begun = await run(
      Effect.flatMap(CatalogImportService, (service) =>
        service.beginImport({
          sourceName: `city-batched-${stamp}`,
          format: "json",
          totalRecords: 2,
          license: MANUAL_LICENSE,
        }),
      ),
    );

    const staged = await run(
      Effect.flatMap(CatalogImportService, (service) =>
        service.stageImportBatch({
          jobId: begun.jobId,
          baseIndex: 0,
          records: [
            dishRecord(`Batched City Dish ${stamp}`, [
              { city: "Hanoi", parent_iso: "VN", association: "associated" },
            ]),
            dishRecord(`Batched String Dish ${stamp}`, ["Hanoi@VN:popular"]),
          ],
        }),
      ),
    );

    expect(staged.complete).toBe(true);
    expect(staged.batchValid).toBe(2);
    expect(staged.batchInvalid).toBe(0);

    const applied = await run(
      Effect.flatMap(CatalogImportService, (service) =>
        service.applyImportBatch({
          jobId: begun.jobId,
          approvals: { licenseAck: false, reviewAck: true, duplicateRefs: [] },
          actorUserId: APPROVER,
        }),
      ),
    );

    expect(applied.applied).toBe(2);
    expect(applied.done).toBe(true);

    const ids = await appliedDishIds(begun.jobId);

    expect(ids.length).toBe(2);

    const allBatchedLinks = await Promise.all(ids.map((id) => dishPlaceLinks(id)));

    for (const links of allBatchedLinks) {
      expect(links.map((link) => link.place_id)).toContain(hanoi.toString());
    }
  });
});
