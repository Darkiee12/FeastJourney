// oxlint-disable-next-line import/no-unassigned-import -- side-effectful test environment setup, runs before server modules initialize.
import "./cleanup";
import { afterAll, describe, expect, test } from "bun:test";

import { SQL } from "bun";
import { Effect, Option, Schema } from "effect";
import { z } from "zod";

import {
  applyRestaurantImport,
  getRestaurantImportJob,
  resolveImportRecord,
  stageRestaurantImport,
  validateRestaurantImport,
} from "@/modules/restaurant-discovery/server/operations/bulk-import";
import { Actor } from "@/server/auth/actor";
import { withActor } from "@/server/auth/current-actor";
import type { AppServices } from "@/server/layers";
import { appRuntime } from "@/server/runtime";

import { createFoodAuth } from "./food-auth";

const foodAuth = createFoodAuth();

afterAll(() => foodAuth.close());

const run = <A, E, R extends AppServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  appRuntime.runPromise(effect);

const runFailure = <A, E, R extends AppServices>(effect: Effect.Effect<A, E, R>): Promise<E> =>
  appRuntime.runPromise(Effect.flip(effect));

const stamp = Date.now().toString(36);

const curatorActor = (userId: string) => Actor.Member({ userId });

/** Raw driver rows arrive untyped; decode the cell grid once at the I/O
 * boundary instead of asserting shapes downstream. */
const cellRowsSchema = z.array(z.array(z.unknown()));

const seedVenue = async (name: string, address: string): Promise<{ id: string }> => {
  const sql = new SQL(process.env.DATABASE_URL ?? "");

  const business = cellRowsSchema.parse(
    await sql`INSERT INTO feastjourney.restaurant_businesses(name) VALUES (${name}) RETURNING id`.values(),
  );

  const businessId = Schema.decodeUnknownOption(Schema.String)(business[0]?.[0]);

  if (Option.isNone(businessId)) throw new Error("seed business insert returned no id");

  const businessUuid = businessId.value;

  const venue = cellRowsSchema.parse(
    await sql`INSERT INTO feastjourney.restaurant_venues
    (business_id, name, address, area, country_code, location, status)
    VALUES (${businessUuid}::uuid, ${name}, ${address}, 'Quận 3', 'VN',
      public.ST_SetSRID(public.ST_MakePoint(106.682, 10.782), 4326)::public.geography, 'draft')
    RETURNING id`.values(),
  );

  const venueId = Schema.decodeUnknownOption(Schema.String)(venue[0]?.[0]);

  if (Option.isNone(venueId)) throw new Error("seed venue insert returned no id");

  const venueUuid = venueId.value;

  await sql`INSERT INTO feastjourney.restaurant_venue_names(venue_id, language_tag, name)
    VALUES (${venueUuid}::uuid, 'und', ${name})`;
  await sql.end();

  return { id: venueUuid };
};

const venueCount = async (): Promise<number> => {
  const sql = new SQL(process.env.DATABASE_URL ?? "");

  const rows = cellRowsSchema.parse(
    await sql`SELECT COUNT(*)::int AS n FROM feastjourney.restaurant_venues
    WHERE name LIKE ${`%${stamp}%`}`.values(),
  );

  await sql.end();
  const first = rows[0]?.[0];
  const decoded = Schema.decodeUnknownOption(Schema.Number)(first);

  return Option.isSome(decoded) ? decoded.value : -1;
};

const sourcesForVenues = async (
  venueIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, Array<unknown>>> => {
  const sql = new SQL(process.env.DATABASE_URL ?? "");

  const rows = cellRowsSchema.parse(
    await sql`SELECT venue_id, category, restaurant_verified, deduplication_key
    FROM feastjourney.restaurant_sources WHERE venue_id = ANY(${venueIds}::uuid[])`.values(),
  );

  await sql.end();

  const byVenue = new Map<string, Array<unknown>>();

  for (const row of rows) {
    const decoded = Schema.decodeUnknownOption(Schema.String)(row[0]);

    if (Option.isSome(decoded)) byVenue.set(decoded.value, row);
  }

  return byVenue;
};

const auditCounts = async (
  event: string,
  resources: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, number>> => {
  const sql = new SQL(process.env.DATABASE_URL ?? "");

  const rows = cellRowsSchema.parse(
    await sql`SELECT resource, COUNT(*)::int AS n
    FROM feastjourney.security_audit_events
    WHERE event = ${event} AND resource = ANY(${resources}) GROUP BY resource`.values(),
  );

  await sql.end();

  const counts = new Map<string, number>();

  for (const row of rows) {
    const resource = Schema.decodeUnknownOption(Schema.String)(row[0]);
    const count = Schema.decodeUnknownOption(Schema.Number)(row[1]);

    if (Option.isSome(resource) && Option.isSome(count)) counts.set(resource.value, count.value);
  }

  return counts;
};

const venueName = async (venueId: string): Promise<string | null> => {
  const sql = new SQL(process.env.DATABASE_URL ?? "");

  const rows = cellRowsSchema.parse(
    await sql`SELECT name FROM feastjourney.restaurant_venues WHERE id = ${venueId}::uuid`.values(),
  );

  await sql.end();

  return Option.getOrNull(Schema.decodeUnknownOption(Schema.String)(rows[0]?.[0]));
};

const seedName = `Phở Hòa Pasteur ${stamp}`;
const seedAddress = `260C Pasteur ${stamp}, Quận 3`;

const importRows = (sourceRecordSuffix: string): ReadonlyArray<unknown> => [
  {
    businessName: `Bun Cha Hang Quat ${sourceRecordSuffix}`,
    name: `Bún Chả Hàng Quạt ${sourceRecordSuffix}`,
    address: `101 Hàng Quạt ${sourceRecordSuffix}, Hoàn Kiếm`,
    area: "Hoàn Kiếm",
    countryCode: "VN",
    longitude: 106.701,
    latitude: 10.775,
    sourceRecordId: `ov-new-1-${sourceRecordSuffix}`,
    sourceUrl: "https://example.com/overture/ov-new-1",
  },
  {
    businessName: `exact dup ${sourceRecordSuffix}`,
    name: `  ${seedName.toUpperCase()} `,
    address: seedAddress.toLowerCase(),
    area: "Quận 3",
    countryCode: "VN",
    longitude: 106.682,
    latitude: 10.782,
    sourceRecordId: `ov-dup-1-${sourceRecordSuffix}`,
    sourceUrl: "https://example.com/overture/ov-dup-1",
  },
  {
    businessName: `fuzzy ${sourceRecordSuffix}`,
    name: `${seedName}r`,
    address: seedAddress,
    area: "Quận 3",
    countryCode: "VN",
    longitude: 106.682,
    latitude: 10.782,
    sourceRecordId: `ov-fuzzy-1-${sourceRecordSuffix}`,
    sourceUrl: "https://example.com/overture/ov-fuzzy-1",
  },
  {
    businessName: `Hanoi row ${sourceRecordSuffix}`,
    name: "Chả Cá Lã Vọng",
    address: "14 Chả Cá, Hoàn Kiếm",
    area: "Hoàn Kiếm",
    countryCode: "VN",
    longitude: 105.854,
    latitude: 21.028,
    sourceRecordId: `hn-1-${sourceRecordSuffix}`,
    sourceUrl: "https://example.com/overture/hn-1",
  },
];

/** Test-owned cleanup: exact ids for this run (jobs cascade their
 * records), stamp-scoped venues/businesses for the rest. Startup also
 * sweeps jobs carrying this suite's own markers so a crashed prior run
 * never blocks food-auth user teardown via the job created_by FK. */
const OWN_MARKERS = {
  overtureAttribution: "© Overture Maps Foundation",
  manualAttribution: "PR13 manage-only probe",
};

const cleanupTestData = async (input: {
  readonly jobIds: ReadonlyArray<string>;
  readonly userIds: ReadonlyArray<string>;
}): Promise<void> => {
  const sql = new SQL(process.env.DATABASE_URL ?? "");

  if (input.jobIds.length > 0) {
    await sql`DELETE FROM feastjourney.restaurant_import_jobs WHERE id = ANY(${input.jobIds}::uuid[])`;
  }

  await sql`DELETE FROM feastjourney.restaurant_import_jobs
    WHERE attribution IN (${OWN_MARKERS.overtureAttribution}, ${OWN_MARKERS.manualAttribution})`;

  if (input.userIds.length > 0) {
    await sql`DELETE FROM feastjourney.restaurant_import_jobs WHERE created_by = ANY(${input.userIds})`;
  }

  await sql`DELETE FROM feastjourney.restaurant_venue_names
    WHERE venue_id IN (SELECT id FROM feastjourney.restaurant_venues WHERE name LIKE ${`%${stamp}%`})`;
  await sql`DELETE FROM feastjourney.restaurant_sources
    WHERE venue_id IN (SELECT id FROM feastjourney.restaurant_venues WHERE name LIKE ${`%${stamp}%`})`;
  await sql`DELETE FROM feastjourney.restaurant_venues WHERE name LIKE ${`%${stamp}%`}`;
  await sql`DELETE FROM feastjourney.restaurant_businesses WHERE name LIKE ${`%${stamp}%`}`;
  await sql.end();
};

/** Test-side boundary decode: the suite asserts on plain JSON-safe
 * fields only, so it parses the operation result instead of reaching into
 * Reylo-inferred row types across the Effect boundary. */
const testRecordSchema = z.object({
  id: z.string(),
  external_ref: z.string(),
  status: z.string(),
  venue_id: z.string().nullable(),
  duplicate_of: z.string().nullable(),
  dedup_key: z.string().nullable(),
});

const testDetailSchema = z.object({ records: z.array(testRecordSchema) });

describe("restaurant bulk import", () => {
  test("validates, dedups, applies, and preserves curator edits across reimports", async () => {
    const curator = await foodAuth.signupSignin(`bulk-curator-${stamp}`);
    await foodAuth.grantRole(curator.userId, "curator");
    await cleanupTestData({ jobIds: [], userIds: [curator.userId] });

    const seed = await seedVenue(seedName, seedAddress);
    const before = await venueCount();

    const staged = await run(
      withActor(
        curatorActor(curator.userId),
        stageRestaurantImport({
          sourceName: "Overture Maps Places",
          format: "json",
          sourceVersion: "2026-10.0",
          release: "2026-10.0",
          license: "other",
          attribution: "© Overture Maps Foundation",
          jobSourceUrl: "https://example.com/overture-2026-10",
          jsonRecords: importRows(stamp),
        }),
      ),
    );

    expect(staged.stagedCount).toBe(4);

    const validated = await run(
      withActor(curatorActor(curator.userId), validateRestaurantImport({ jobId: staged.jobId })),
    );

    expect(validated.status).toBe("validated");
    expect(validated.valid).toBe(1);
    expect(validated.invalid).toBe(1);
    expect(validated.skippedDuplicate).toBe(1);
    expect(validated.needsReview).toBe(1);

    const detail = testDetailSchema.parse(
      await run(
        withActor(curatorActor(curator.userId), getRestaurantImportJob({ jobId: staged.jobId })),
      ),
    );

    const fuzzy = detail.records.find((record) => record.status === "needs_review");
    expect(fuzzy).toBeDefined();

    if (fuzzy === undefined) return;
    expect(fuzzy.duplicate_of).toBe(seed.id);

    await run(
      withActor(
        curatorActor(curator.userId),
        resolveImportRecord({ jobId: staged.jobId, recordId: fuzzy.id, decision: "approved" }),
      ),
    );

    const deniedApply = await runFailure(
      withActor(
        curatorActor(curator.userId),
        applyRestaurantImport({
          jobId: staged.jobId,
          licenseAck: false,
          reviewAck: true,
          acknowledgedRefs: [],
        }),
      ),
    );

    expect(deniedApply._tag).toBe("RestaurantInputError");

    const applied = await run(
      withActor(
        curatorActor(curator.userId),
        applyRestaurantImport({
          jobId: staged.jobId,
          licenseAck: true,
          reviewAck: true,
          acknowledgedRefs: [],
        }),
      ),
    );

    expect(applied.done).toBe(true);
    expect(applied.applied).toBe(2);
    expect(applied.skippedDuplicate).toBe(1);
    expect(applied.pendingReview).toBe(0);
    expect(await venueCount()).toBe(before + 2);

    const after = testDetailSchema.parse(
      await run(
        withActor(curatorActor(curator.userId), getRestaurantImportJob({ jobId: staged.jobId })),
      ),
    );

    const appliedRows = after.records.filter((record) => record.status === "applied");
    expect(appliedRows).toHaveLength(2);

    const appliedVenueIds = appliedRows.map((row) => row.venue_id ?? "");
    const provenance = await sourcesForVenues(appliedVenueIds);
    const auditHits = await auditCounts("restaurant.import.applied", appliedVenueIds);

    for (const row of appliedRows) {
      expect(row.venue_id).not.toBeNull();

      const source = provenance.get(row.venue_id ?? "");

      expect(source?.[1]).toBe("authorized_provider");
      expect(source?.[2]).toBe(false);
      expect(Option.isSome(Schema.decodeUnknownOption(Schema.String)(source?.[3]))).toBe(true);
      expect(auditHits.get(row.venue_id ?? "") ?? -1).toBe(1);
    }

    const newVenue = appliedRows.find((row) => row.external_ref === `ov-new-1-${stamp}`);
    expect(newVenue?.dedup_key).toBe(`Overture Maps Places:2026-10.0:ov-new-1-${stamp}`);

    // Curator edits the applied venue directly, then the same release is
    // reimported: no new venue, no overwrite.
    const curatorName = `Bún Chả Hàng Quạt (curator edit) ${stamp}`;
    const editSql = new SQL(process.env.DATABASE_URL ?? "");
    await editSql`UPDATE feastjourney.restaurant_venues SET name = ${curatorName}, updated_at = now()
      WHERE id = ${newVenue?.venue_id ?? ""}::uuid`;
    await editSql`INSERT INTO feastjourney.restaurant_venue_names(venue_id, language_tag, name)
      VALUES (${newVenue?.venue_id ?? ""}::uuid, 'und', ${curatorName})`;
    await editSql.end();

    const reimport = await run(
      withActor(
        curatorActor(curator.userId),
        stageRestaurantImport({
          sourceName: "Overture Maps Places",
          format: "json",
          sourceVersion: "2026-10.0",
          release: "2026-10.0",
          license: "other",
          attribution: "© Overture Maps Foundation",
          jobSourceUrl: "https://example.com/overture-2026-10",
          jsonRecords: importRows(stamp),
        }),
      ),
    );

    const revalidated = await run(
      withActor(curatorActor(curator.userId), validateRestaurantImport({ jobId: reimport.jobId })),
    );

    expect(revalidated.valid).toBe(0);
    expect(await venueCount()).toBe(before + 2);
    expect(await venueName(newVenue?.venue_id ?? "")).toBe(curatorName);

    await cleanupTestData({ jobIds: [staged.jobId, reimport.jobId], userIds: [curator.userId] });
  });

  test("rejects duplicate source records inside one batch", async () => {
    const curator = await foodAuth.signupSignin(`bulk-batchdup-${stamp}`);
    await foodAuth.grantRole(curator.userId, "curator");
    await cleanupTestData({ jobIds: [], userIds: [curator.userId] });

    const row = {
      businessName: `Batch Dup ${stamp}`,
      name: `Batch Dup Venue ${stamp}`,
      address: `7 Batch St ${stamp}`,
      area: "Quận 1",
      countryCode: "VN",
      longitude: 106.7,
      latitude: 10.77,
      sourceRecordId: `batch-dup-1-${stamp}`,
      sourceUrl: "https://example.com/manual/batch-dup-1",
    };

    const staged = await run(
      withActor(
        curatorActor(curator.userId),
        stageRestaurantImport({
          sourceName: "Manual",
          format: "json",
          sourceVersion: null,
          release: null,
          license: null,
          attribution: "PR13 manage-only probe",
          jobSourceUrl: "https://example.com/manual",
          jsonRecords: [row, { ...row }],
        }),
      ),
    );

    expect(staged.stagedCount).toBe(2);

    const validated = await run(
      withActor(curatorActor(curator.userId), validateRestaurantImport({ jobId: staged.jobId })),
    );

    expect(validated.valid).toBe(1);
    expect(validated.invalid).toBe(1);

    await cleanupTestData({ jobIds: [staged.jobId], userIds: [curator.userId] });
  });

  test("denies staging and bulk apply without the explicit grants", async () => {
    const member = await foodAuth.signupSignin(`bulk-member-${stamp}`);

    const stageDenied = await runFailure(
      withActor(
        curatorActor(member.userId),
        stageRestaurantImport({
          sourceName: "Manual",
          format: "json",
          sourceVersion: null,
          release: null,
          license: null,
          attribution: null,
          jobSourceUrl: "https://example.com/manual",
          jsonRecords: [],
        }),
      ),
    );

    expect(stageDenied._tag).toBe("InsufficientPermissions");

    const curator = await foodAuth.signupSignin(`bulk-manage-${stamp}`);
    const sql = new SQL(process.env.DATABASE_URL ?? "");
    await sql`INSERT INTO feastjourney.roles (id, slug, name) VALUES (${`pr13-manage-only-${stamp}`}, ${`pr13-manage-only-${stamp}`}, 'PR13 manage only') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO feastjourney.role_permissions (role_id, permission_key) VALUES (${`pr13-manage-only-${stamp}`}, 'restaurant:manage') ON CONFLICT DO NOTHING`;
    await sql.end();
    await foodAuth.grantRole(curator.userId, `pr13-manage-only-${stamp}`);

    const staged = await run(
      withActor(
        curatorActor(curator.userId),
        stageRestaurantImport({
          sourceName: "Manual",
          format: "json",
          sourceVersion: null,
          release: null,
          license: null,
          attribution: "PR13 manage-only probe",
          jobSourceUrl: "https://example.com/manual",
          jsonRecords: [
            {
              businessName: "Grant Probe",
              name: `Grant Probe ${stamp}`,
              address: "1 Grant St",
              area: "Quận 1",
              countryCode: "VN",
              longitude: 106.7,
              latitude: 10.77,
              sourceUrl: "https://example.com/manual/1",
            },
          ],
        }),
      ),
    );

    await run(
      withActor(curatorActor(curator.userId), validateRestaurantImport({ jobId: staged.jobId })),
    );

    const applyDenied = await runFailure(
      withActor(
        curatorActor(curator.userId),
        applyRestaurantImport({
          jobId: staged.jobId,
          licenseAck: true,
          reviewAck: true,
          acknowledgedRefs: [],
        }),
      ),
    );

    expect(applyDenied._tag).toBe("InsufficientPermissions");

    await cleanupTestData({
      jobIds: [staged.jobId],
      userIds: [member.userId, curator.userId],
    });
    const cleanup = new SQL(process.env.DATABASE_URL ?? "");
    await cleanup`DELETE FROM feastjourney.roles WHERE id = ${`pr13-manage-only-${stamp}`}`;
    await cleanup.end();
  });
});
