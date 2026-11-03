import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Effect, Layer, ManagedRuntime } from "effect";
import postgres from "postgres";
import sharp from "sharp";

import type { MenuExtraction } from "@/modules/restaurant-discovery/menu-scan.schema";
import {
  attachMenuPhoto,
  createMenuScan,
  extractMenu,
  getMenuScan,
  submitMenuContribution,
} from "@/modules/restaurant-discovery/server/operations/menu-scans";
import { cleanupMenuScans } from "@/modules/restaurant-discovery/server/operations/scan-cleanup";
import {
  getMenuContribution,
  reviewMenuContribution,
} from "@/modules/restaurant-discovery/server/operations/scan-contributions";
import { UserRepositoriesLive } from "@/modules/user/server/index";
import type { Authorization } from "@/modules/user/server/operations/authorization";
import { AuthorizationLive } from "@/modules/user/server/operations/authorization";
import type { RoleRepository } from "@/modules/user/server/repository/role-repository";
import type { UserRepository } from "@/modules/user/server/repository/user-repository";
import { Actor } from "@/server/auth/actor";
import { withActor } from "@/server/auth/current-actor";
import { DatabaseLive } from "@/server/database/client";
import type { Database } from "@/server/database/client";
import { resetServerEnvCache } from "@/server/env";
import { MenuExtractor } from "@/server/integrations/muse-menu";
import {
  type PrivateMenuStorage,
  PrivateMenuStorageLive,
} from "@/server/integrations/private-menu-storage";

// oxlint-disable-next-line import/no-unassigned-import -- seeds disposable-DB and auth env guards at import time; this file owns no fixtures.
import "./cleanup";
import { createFoodAuth } from "./food-auth";

const sql = postgres(process.env.DATABASE_URL ?? "", { max: 2 });
const auth = createFoodAuth();

const stamp = crypto.randomUUID().slice(0, 8);
const guestHash = createHash("sha256").update(`scan-promotion-${stamp}`).digest("hex");
const foreignHash = createHash("sha256").update(`scan-promotion-foreign-${stamp}`).digest("hex");
const principal = { userId: null, guestHash };

const cannedExtraction = (assetIds: ReadonlyArray<string>): MenuExtraction => ({
  sourceLanguage: "vi",
  menuTitle: "Synthetic scan menu",
  orderIntroduction: { original: "Xin mời gọi món", translated: "Please order" },
  items: assetIds.map((assetId, index) => ({
    originalName: `Synthetic dish ${index + 1}`,
    translatedName: `Synthetic dish ${index + 1} EN`,
    originalDescription: null,
    translatedDescription: null,
    explanatorySummary: null,
    ingredients: null,
    variants: [
      {
        originalLabel: "",
        translatedLabel: null,
        price: {
          rawText: "65.000đ",
          amount: "65000",
          currency: "VND",
          taxTreatment: "included",
        },
      },
    ],
    sourceReferences: [{ assetId, region: null }],
    uncertainties: [],
  })),
});

const fakeExtractor = Layer.succeed(MenuExtractor, {
  extract: (input) => Effect.succeed(cannedExtraction(input.images.map((image) => image.assetId))),
});

type ScanServices =
  | Database
  | Authorization
  | RoleRepository
  | UserRepository
  | PrivateMenuStorage
  | MenuExtractor;

const s3Endpoint = process.env.S3_ENDPOINT_INTERNAL;
const s3Region = process.env.S3_REGION;
const s3Bucket = process.env.S3_BUCKET_PRIVATE;
const s3KeyId = process.env.S3_ACCESS_KEY_ID;
const s3KeySecret = process.env.S3_SECRET_ACCESS_KEY;

if (
  s3Endpoint === undefined ||
  s3Region === undefined ||
  s3Bucket === undefined ||
  s3KeyId === undefined ||
  s3KeySecret === undefined
)
  throw new Error("S3 test endpoint is not configured");

const s3 = new S3Client({
  endpoint: s3Endpoint,
  region: s3Region,
  forcePathStyle: true,
  credentials: { accessKeyId: s3KeyId, secretAccessKey: s3KeySecret },
});

const readBytes = async (key: string): Promise<Uint8Array> => {
  const object = await s3.send(new GetObjectCommand({ Bucket: s3Bucket, Key: key }));

  if (object.Body === undefined) throw new Error(`missing body for ${key}`);

  return object.Body.transformToByteArray();
};

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    DatabaseLive,
    AuthorizationLive,
    UserRepositoriesLive,
    PrivateMenuStorageLive,
    fakeExtractor,
  ),
);

const run = <A, E, R extends ScanServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  runtime.runPromise(effect);

const photoBytes = async (red: number): Promise<Uint8Array> =>
  sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: red, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();

let curatorId = "";
let venueId = "";
let businessId = "";
let scanId = "";
let contributionId = "";
const sessionKeys: Array<string> = [];
const extraScans: Array<string> = [];

// extractMenu gates on real scanner config before reaching the injected
// MenuExtractor, so enable a synthetic scanner like
// menu-scan-provenance.test.ts does; the fake extractor still performs the
// actual extraction.
const originalScannerEnabled = process.env["MENU_SCANNER_ENABLED"];
const originalApiKey = process.env["MODEL_API_KEY"];

beforeAll(async () => {
  process.env["MENU_SCANNER_ENABLED"] = "true";
  process.env["MODEL_API_KEY"] = "synthetic-promotion-key";
  resetServerEnvCache();
  const session = await auth.signupSignin("scan-curator");
  curatorId = session.userId;
  await auth.grantRole(curatorId, "curator");

  const business = await sql<ReadonlyArray<{ id: string }>>`
    INSERT INTO feastjourney.restaurant_businesses(name) VALUES (${`Scan business ${stamp}`}) RETURNING id`;

  const createdBusiness = business.at(0);

  if (createdBusiness === undefined) throw new Error("business fixture missing");
  businessId = createdBusiness.id;

  const venue = await sql<ReadonlyArray<{ id: string }>>`
    INSERT INTO feastjourney.restaurant_venues(business_id,name,address,area,country_code,location,status)
    VALUES (${businessId}, ${`Scan branch ${stamp}`}, ${`${stamp} Test St`}, ${`Scan Area ${stamp}`}, 'VN',
      public.ST_SetSRID(public.ST_MakePoint(106.8, 10.77), 4326)::public.geography, 'published')
    RETURNING id`;

  const createdVenue = venue.at(0);

  if (createdVenue === undefined) throw new Error("venue fixture missing");
  venueId = createdVenue.id;
});

afterAll(async () => {
  const ownedKeys = await sql<
    ReadonlyArray<{ object_key: string }>
  >`SELECT object_key FROM feastjourney.menu_scan_assets WHERE session_id=ANY(${[scanId, ...extraScans].filter((id) => id !== "")}::uuid[])`;

  await Promise.all(
    ownedKeys.map((asset) =>
      s3.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: asset.object_key })),
    ),
  );
  await sql.begin(async (tx) => {
    if (contributionId !== "") {
      await tx`DELETE FROM feastjourney.menu_scan_contribution_menus WHERE contribution_id=${contributionId}`;
      await tx`DELETE FROM feastjourney.menu_scan_contributions WHERE id=${contributionId}`;
    }

    await tx`UPDATE feastjourney.menu_scan_sessions SET current_revision=NULL WHERE id=${scanId}::uuid OR id=ANY(${extraScans}::uuid[])`;
    await tx`DELETE FROM feastjourney.menu_scan_revisions WHERE session_id=${scanId}::uuid OR session_id=ANY(${extraScans}::uuid[])`;
    await tx`DELETE FROM feastjourney.menu_scan_assets WHERE session_id=${scanId}::uuid OR session_id=ANY(${extraScans}::uuid[])`;
    await tx`DELETE FROM feastjourney.menu_scan_sessions WHERE id=${scanId}::uuid OR id=ANY(${extraScans}::uuid[])`;
    await tx`DELETE FROM feastjourney.restaurant_receipt_lines WHERE observation_id IN(SELECT id FROM feastjourney.restaurant_price_observations WHERE venue_id=${venueId}::uuid)`;
    await tx`DELETE FROM feastjourney.restaurant_price_observations WHERE venue_id=${venueId}::uuid`;
    await tx`DELETE FROM feastjourney.restaurant_serving_evidence WHERE venue_id=${venueId}::uuid`;
    await tx`DELETE FROM feastjourney.restaurant_sources WHERE venue_id=${venueId}::uuid`;
    await tx`DELETE FROM feastjourney.restaurant_menu_item_variants WHERE venue_id=${venueId}::uuid`;
    await tx`DELETE FROM feastjourney.restaurant_menu_items WHERE venue_id=${venueId}::uuid`;
    await tx`DELETE FROM feastjourney.restaurant_menus WHERE venue_id=${venueId}::uuid`;
    await tx`DELETE FROM feastjourney.restaurant_venue_names WHERE venue_id=${venueId}::uuid`;
    await tx`DELETE FROM feastjourney.restaurant_venues WHERE id=${venueId}::uuid`;
    await tx`DELETE FROM feastjourney.restaurant_businesses WHERE id=${businessId}::uuid`;
  });
  await sql.end();
  await runtime.dispose();
  await auth.close();

  if (originalScannerEnabled === undefined) delete process.env["MENU_SCANNER_ENABLED"];
  else process.env["MENU_SCANNER_ENABLED"] = originalScannerEnabled;

  if (originalApiKey === undefined) delete process.env["MODEL_API_KEY"];
  else process.env["MODEL_API_KEY"] = originalApiKey;

  resetServerEnvCache();
});

const noiseJpeg = async (): Promise<Uint8Array> => {
  // Sequential by design: each candidate size is measured before trying the next.
  for (const edge of [2700, 2800, 2900, 3000]) {
    const raw = crypto.getRandomValues(new Uint8Array(edge * edge * 3));

    // oxlint-disable-next-line no-await-in-loop -- Candidate sizes are measured one at a time to stop at the first quota-sized image.
    const bytes = await sharp(raw, { raw: { width: edge, height: edge, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();

    // oxlint-disable-next-line no-await-in-loop -- The reservation quota counts re-encoded bytes, so each candidate is re-encoded before measuring.
    const decoded = await sharp(bytes).jpeg({ quality: 95 }).toBuffer();

    if (decoded.byteLength > 6.8 * 1024 * 1024 && bytes.byteLength <= 8 * 1024 * 1024) return bytes;
  }

  throw new Error("could not synthesize a quota-sized image");
};

describe("menu scan promotion and cleanup", () => {
  test("guest scans two pages and curator promotes registered private evidence", async () => {
    const created = await run(createMenuScan(principal, { targetLanguage: "en", venueId }));
    scanId = created.id;

    await Promise.all([
      run(attachMenuPhoto(principal, scanId, 1, await photoBytes(30), "image/png")),
      run(attachMenuPhoto(principal, scanId, 2, await photoBytes(200), "image/png")),
    ]);

    const extracted = await run(extractMenu(principal, scanId, `promotion-${stamp}`));
    expect(extracted.document?.items.length).toBe(2);

    const submitted = await run(
      submitMenuContribution(principal, {
        scanId,
        revision: 1,
        consent: true,
        termsVersion: "menu-facts-v1",
        venueId,
      }),
    );

    contributionId = submitted.id;
    expect(submitted.status).toBe("pending");

    const detail = await run(getMenuScan(principal, scanId));
    const itemIds = (detail.document?.items ?? []).map((item) => item.id);

    const pricedIds = (detail.document?.items ?? []).flatMap((item) =>
      item.variants.map((variant) => variant.id),
    );

    expect(itemIds.length).toBe(2);

    const reviewed = await run(
      withActor(
        Actor.Member({ userId: curatorId }),
        reviewMenuContribution({
          contributionId,
          decision: "approved",
          channel: "takeaway",
          rightsReviewed: true,
          venueId,
          observedAt: new Date(Date.now() - 86400000).toISOString(),
          validUntil: new Date(Date.now() + 29 * 86400000).toISOString(),
          notes: "Synthetic promotion review",
          itemIds,
          pricedVariantIds: pricedIds,
        }),
      ),
    );

    expect(reviewed.status).toBe("approved");

    const contribution = await run(
      withActor(Actor.Member({ userId: curatorId }), getMenuContribution(contributionId)),
    );

    // One promoted menu per evidence page, each linked to its photograph.
    expect(contribution.menus.length).toBe(2);
    expect(new Set(contribution.menus.map((menu) => menu.asset_id)).size).toBe(2);

    expect(JSON.stringify(contribution)).not.toContain("object_key");
    expect(JSON.stringify(contribution)).not.toContain("evidence_key");

    const sources = await sql<
      ReadonlyArray<{
        object_key: string;
        asset_key: string;
        channel: string;
        within_retention: boolean;
      }>
    >`
      SELECT s.private_object_key AS object_key,a.object_key AS asset_key,p.sales_channel AS channel,
       s.valid_until<=c.retention_until AS within_retention
      FROM feastjourney.menu_scan_contribution_menus cm
      JOIN feastjourney.menu_scan_contributions c ON c.id=cm.contribution_id
      JOIN feastjourney.menu_scan_assets a ON a.id=cm.asset_id
      JOIN feastjourney.restaurant_menu_items i ON i.menu_id=cm.menu_id
      JOIN feastjourney.restaurant_menu_item_variants v ON v.menu_item_id=i.id
      JOIN feastjourney.restaurant_price_observations p ON p.variant_id=v.id
      JOIN feastjourney.restaurant_sources s ON s.id=p.source_id
      WHERE cm.contribution_id=${contributionId}::uuid`;

    expect(sources.length).toBe(2);

    for (const source of sources) {
      expect(source.object_key).toBe(source.asset_key);
      expect(source.object_key.startsWith(`menu/${scanId}/`)).toBe(true);
      expect(source.channel).toBe("takeaway");
      expect(source.within_retention).toBe(true);
    }
  });

  test("foreign guests cannot read the scan", async () => {
    const exit = await runtime.runPromiseExit(
      getMenuScan({ userId: null, guestHash: foreignHash }, scanId),
    );

    expect(exit._tag).toBe("Failure");
  });

  test("parallel uploads cannot exceed the combined quota", async () => {
    const big = await noiseJpeg();

    const created: { readonly id: string; readonly expires_at: string } = await run(
      createMenuScan(principal, { targetLanguage: "en", venueId: null }),
    );

    extraScans.push(created.id);

    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((page) =>
        run(attachMenuPhoto(principal, created.id, page, big, "image/jpeg")),
      ),
    );

    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected.length).toBeGreaterThan(0);

    const totals = await sql<ReadonlyArray<{ bytes: number }>>`
      SELECT COALESCE(sum(byte_length),0)::int AS bytes FROM feastjourney.menu_scan_assets
      WHERE session_id=${created.id}::uuid AND status IN ('uploading','ready')`;

    expect((totals.at(0)?.bytes ?? 0) <= 24 * 1024 * 1024).toBe(true);
  });

  test("consent expiry erases photos and drafts while preserving curated facts and attribution", async () => {
    const rows = await sql<ReadonlyArray<{ object_key: string }>>`
      SELECT object_key FROM feastjourney.menu_scan_assets WHERE session_id=${scanId}::uuid`;

    sessionKeys.push(...rows.map((row) => row.object_key));
    expect(sessionKeys.length).toBe(2);

    await sql`UPDATE feastjourney.menu_scan_sessions SET created_at=now()-INTERVAL '25 hours', expires_at=now()-INTERVAL '1 hour' WHERE id=${scanId}::uuid`;
    await sql`UPDATE feastjourney.menu_scan_assets SET created_at=now()-INTERVAL '10 minutes' WHERE session_id=${scanId}::uuid`;

    const report = await run(cleanupMenuScans());
    expect(report.objectsDeleted).toBeGreaterThanOrEqual(2);

    // Expired private session is gone for its owner.
    const exit = await runtime.runPromiseExit(getMenuScan(principal, scanId));
    expect(exit._tag).toBe("Failure");

    // Approved evidence uses those same private objects and expires with consent.
    const states = await Promise.all(
      sessionKeys.map((key) =>
        readBytes(key).then(
          () => "readable",
          () => "gone" as const,
        ),
      ),
    );

    expect(states).toEqual(sessionKeys.map(() => "gone"));

    // Only the minimal contribution record remains, with its original revision number.
    const revisions = await sql<ReadonlyArray<{ revision: number }>>`
      SELECT revision FROM feastjourney.menu_scan_revisions WHERE session_id=${scanId}::uuid`;

    expect(revisions).toHaveLength(0);

    const contributions = await sql<
      ReadonlyArray<{ revision: number | null; submitted_revision: number; status: string }>
    >`
      SELECT revision,submitted_revision,status FROM feastjourney.menu_scan_contributions WHERE id=${contributionId}::uuid`;

    expect([...contributions]).toEqual([
      { revision: null, submitted_revision: 1, status: "approved" },
    ]);

    const retainedFacts = await sql<
      ReadonlyArray<{ amount: string; translated_name: string; source_language: string }>
    >`
      SELECT p.amount::text,i.translated_name,m.source_language
      FROM feastjourney.restaurant_price_observations p
      JOIN feastjourney.restaurant_menu_item_variants v ON v.id=p.variant_id
      JOIN feastjourney.restaurant_menu_items i ON i.id=v.menu_item_id
      JOIN feastjourney.restaurant_menus m ON m.id=i.menu_id
      WHERE p.venue_id=${venueId}::uuid`;

    expect(retainedFacts.length).toBe(2);

    for (const fact of retainedFacts) {
      expect(fact.amount).toBe("65000");
      expect(fact.translated_name).toContain("EN");
      expect(fact.source_language).toBe("vi");
    }
  });
});
