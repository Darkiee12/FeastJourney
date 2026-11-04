import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Data, Effect, Layer, ManagedRuntime } from "effect";
import postgres from "postgres";
import sharp from "sharp";

import type {
  MenuExtraction,
  MenuScanDocument,
} from "@/modules/restaurant-discovery/menu-scan.schema";
import { getRestaurant } from "@/modules/restaurant-discovery/server/operations/discovery";
import {
  attachMenuPhoto,
  claimGuestMenuScan,
  createMenuScan,
  extractMenu,
  getMenuScan,
  readMenuPhoto,
  reviseMenuScan,
  submitMenuContribution,
  type ScanPrincipal,
} from "@/modules/restaurant-discovery/server/operations/menu-scans";
import { cleanupMenuScans } from "@/modules/restaurant-discovery/server/operations/scan-cleanup";
import {
  getMenuContribution,
  reviewMenuContribution,
} from "@/modules/restaurant-discovery/server/operations/scan-contributions";
import { type Authorization, UserRepositoriesLive } from "@/modules/user/server/index";
import { AuthorizationLive } from "@/modules/user/server/operations/authorization";
import type { RoleRepository } from "@/modules/user/server/repository/role-repository";
import type { UserRepository } from "@/modules/user/server/repository/user-repository";
import { Actor } from "@/server/auth/actor";
import { withActor } from "@/server/auth/current-actor";
import { DatabaseLive, withTransaction, type Database } from "@/server/database/client";
import { resetServerEnvCache } from "@/server/env";
import { MenuExtractor } from "@/server/integrations/muse-menu";
import {
  PrivateMenuStorage,
  PrivateMenuStorageLive,
  StorageUnavailable,
} from "@/server/integrations/private-menu-storage";

import { createFoodAuth } from "./food-auth";

const originalScannerEnabled = process.env["MENU_SCANNER_ENABLED"];
const originalApiKey = process.env["MODEL_API_KEY"];

const enableScannerEnv = (): void => {
  process.env["MENU_SCANNER_ENABLED"] = "true";
  process.env["MODEL_API_KEY"] = "synthetic-hardening-key";
  resetServerEnvCache();
};

const restoreScannerEnv = (): void => {
  if (originalScannerEnabled === undefined) delete process.env["MENU_SCANNER_ENABLED"];
  else process.env["MENU_SCANNER_ENABLED"] = originalScannerEnabled;

  if (originalApiKey === undefined) delete process.env["MODEL_API_KEY"];
  else process.env["MODEL_API_KEY"] = originalApiKey;

  resetServerEnvCache();
};

const sql = postgres(process.env.DATABASE_URL ?? "", { max: 3 });
const auth = createFoodAuth();
const stamp = crypto.randomUUID().slice(0, 8);

const guest: ScanPrincipal = {
  userId: null,
  guestHash: createHash("sha256").update(`guest-${stamp}`).digest("hex"),
};

const stranger: ScanPrincipal = {
  userId: null,
  guestHash: createHash("sha256").update(`stranger-${stamp}`).digest("hex"),
};

const scanIds: Array<string> = [];
let curatorId = "";
let memberId = "";
let otherMemberId = "";
let venueId = "";
let businessId = "";

const extraction = (assetId: string): MenuExtraction => ({
  sourceLanguage: "vi",
  menuTitle: "Synthetic hardening menu",
  orderIntroduction: { original: "Tôi muốn gọi", translated: "I would like" },
  items: ["Phở bò", "Trà"].map((originalName) => ({
    originalName,
    translatedName: `Translated ${originalName}`,
    originalDescription: null,
    translatedDescription: "Reviewed synthetic translation",
    explanatorySummary: null,
    ingredients: null,
    variants: [
      {
        originalLabel: "",
        translatedLabel: null,
        price: { rawText: "65.000đ", amount: "65000", currency: "VND", taxTreatment: "included" },
      },
    ],
    sourceReferences: [{ assetId, region: null }],
    uncertainties: [],
  })),
});

const fakeExtractor = Layer.succeed(MenuExtractor, {
  extract: (input) => {
    const image = input.images.at(0);

    if (image === undefined) return Effect.die(new Error("test extraction requires an image"));

    return Effect.succeed(extraction(image.assetId));
  },
});

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    DatabaseLive,
    AuthorizationLive,
    UserRepositoriesLive,
    PrivateMenuStorageLive,
    fakeExtractor,
  ),
);

type TestServices =
  | Database
  | Authorization
  | RoleRepository
  | UserRepository
  | PrivateMenuStorage
  | MenuExtractor;

const run = <A, E, R extends TestServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  runtime.runPromise(effect);

async function expectFailure<A, E, R extends TestServices>(
  effect: Effect.Effect<A, E, R>,
  tag: string,
): Promise<void> {
  const failure = await run(Effect.flip(effect));
  expect(failure).toMatchObject({ _tag: tag });
}

const s3Config = {
  endpoint: process.env.S3_ENDPOINT_INTERNAL,
  region: process.env.S3_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
  },
};

const s3 = new S3Client(s3Config);
const bucket = process.env.S3_BUCKET_PRIVATE;

const photo = sharp({ create: { width: 48, height: 48, channels: 3, background: "#304080" } })
  .png()
  .toBuffer();

async function waitForExtractionDocument(principal: ScanPrincipal, scanId: string) {
  const deadline = Date.now() + 10000;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- Status polling is sequential by design.
    const current = await run(getMenuScan(principal, scanId));

    if (current.document !== null) return current;

    if (Date.now() >= deadline) throw new Error("synthetic extraction document missing");

    // oxlint-disable-next-line no-await-in-loop -- Status polling is sequential by design.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function extractedScan(
  principal = guest,
): Promise<{ scanId: string; assetId: string; document: MenuScanDocument }> {
  const created = await run(createMenuScan(principal, { targetLanguage: "en", venueId }));
  scanIds.push(created.id);
  const asset = await run(attachMenuPhoto(principal, created.id, 1, await photo, "image/png"));
  // Extraction runs detached server-side; the accept returns the processing
  // view promptly, so poll the scan view until the document lands.
  await run(extractMenu(principal, created.id, crypto.randomUUID()));
  const view = await waitForExtractionDocument(principal, created.id);

  if (view.document === null) throw new Error("synthetic extraction document missing");

  return { scanId: created.id, assetId: asset.assetId, document: view.document };
}

async function contributionFixture() {
  const scan = await extractedScan();

  const contributed = await run(
    submitMenuContribution(guest, {
      scanId: scan.scanId,
      revision: 1,
      consent: true,
      termsVersion: "menu-facts-v1",
      venueId,
    }),
  );

  return { ...scan, contributionId: contributed.id };
}

const approval = (fixture: Awaited<ReturnType<typeof contributionFixture>>) => ({
  contributionId: fixture.contributionId,
  decision: "approved" as const,
  venueId,
  channel: "delivery" as const,
  rightsReviewed: true,
  observedAt: new Date(Date.now() - 86400000).toISOString(),
  validUntil: new Date(Date.now() + 29 * 86400000).toISOString(),
  notes: "Synthetic reviewer verified branch, source, translations and individual prices",
  itemIds: fixture.document.items.map((item) => item.id),
  pricedVariantIds: fixture.document.items.flatMap((item) =>
    item.variants.map((variant) => variant.id),
  ),
});

beforeAll(async () => {
  enableScannerEnv();

  const curator = await auth.signupSignin("hardening-curator");
  curatorId = curator.userId;
  await auth.grantRole(curatorId, "curator");
  memberId = (await auth.signupSignin("hardening-member-a")).userId;
  otherMemberId = (await auth.signupSignin("hardening-member-b")).userId;

  const businesses = await sql<
    ReadonlyArray<{ id: string }>
  >`INSERT INTO feastjourney.restaurant_businesses(name) VALUES (${`Hardening business ${stamp}`}) RETURNING id`;

  const business = businesses.at(0);

  if (business === undefined) throw new Error("business fixture missing");
  businessId = business.id;

  const venues = await sql<
    ReadonlyArray<{ id: string }>
  >`INSERT INTO feastjourney.restaurant_venues(business_id,name,address,area,country_code,location,status) VALUES (${businessId},${`Hardening branch ${stamp}`},'Synthetic test address',${stamp},'VN',public.ST_SetSRID(public.ST_MakePoint(106.8,10.77),4326)::public.geography,'published') RETURNING id`;

  const venue = venues.at(0);

  if (venue === undefined) throw new Error("venue fixture missing");
  venueId = venue.id;
});

afterAll(async () => {
  const keys = await sql<
    ReadonlyArray<{ object_key: string }>
  >`SELECT object_key FROM feastjourney.menu_scan_assets WHERE session_id=ANY(${scanIds}::uuid[])`;

  await Promise.all(
    keys.map((entry) =>
      s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: entry.object_key })),
    ),
  );
  await sql.begin(async (tx) => {
    await tx`DELETE FROM feastjourney.menu_scan_contribution_menus WHERE contribution_id IN (SELECT id FROM feastjourney.menu_scan_contributions WHERE session_id=ANY(${scanIds}::uuid[]))`;
    await tx`DELETE FROM feastjourney.menu_scan_contributions WHERE session_id=ANY(${scanIds}::uuid[])`;
    await tx`UPDATE feastjourney.menu_scan_sessions SET current_revision=NULL WHERE id=ANY(${scanIds}::uuid[])`;
    await tx`DELETE FROM feastjourney.menu_scan_revisions WHERE session_id=ANY(${scanIds}::uuid[])`;
    await tx`DELETE FROM feastjourney.menu_scan_assets WHERE session_id=ANY(${scanIds}::uuid[])`;
    await tx`DELETE FROM feastjourney.menu_scan_sessions WHERE id=ANY(${scanIds}::uuid[])`;
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
  await runtime.dispose();
  await sql.end();
  s3.destroy();
  await auth.close();
  restoreScannerEnv();
});

describe("private menu scan ownership and immutable revisions", () => {
  test("rejects forged image types and excessive files before storing private bytes", async () => {
    const created = await run(createMenuScan(guest, { targetLanguage: "en", venueId: null }));

    scanIds.push(created.id);
    await expectFailure(
      attachMenuPhoto(guest, created.id, 1, await photo, "image/jpeg"),
      "InvalidImage",
    );
    await expectFailure(
      attachMenuPhoto(guest, created.id, 1, new Uint8Array(8 * 1024 * 1024 + 1), "image/png"),
      "InvalidImage",
    );
    await expectFailure(
      attachMenuPhoto(guest, created.id, 1, new TextEncoder().encode("not an image"), "image/png"),
      "InvalidImage",
    );

    const assets =
      await sql`SELECT id FROM feastjourney.menu_scan_assets WHERE session_id=${created.id}::uuid`;

    expect(assets.length).toBe(0);
  });

  test("guest capability gates scan and photographs, and explicit member claim isolates accounts", async () => {
    const fixture = await extractedScan();
    await expectFailure(getMenuScan(stranger, fixture.scanId), "ScanNotFound");
    await expectFailure(readMenuPhoto(stranger, fixture.scanId, fixture.assetId), "ScanNotFound");
    const member = { userId: memberId, guestHash: guest.guestHash };
    await expectFailure(getMenuScan(member, fixture.scanId), "ScanNotFound");
    const claimed = await run(claimGuestMenuScan(member, fixture.scanId));
    expect(claimed.scan.id).toBe(fixture.scanId);
    expect(
      (await run(readMenuPhoto(member, fixture.scanId, fixture.assetId))).length,
    ).toBeGreaterThan(0);
    await expectFailure(getMenuScan(guest, fixture.scanId), "ScanNotFound");
    await expectFailure(
      getMenuScan({ userId: otherMemberId, guestHash: guest.guestHash }, fixture.scanId),
      "ScanNotFound",
    );
    await expectFailure(
      claimGuestMenuScan({ userId: otherMemberId, guestHash: guest.guestHash }, fixture.scanId),
      "ScanNotFound",
    );
  });

  test("customer additions receive server-owned IDs and revision compare-and-set preserves history", async () => {
    const fixture = await extractedScan();
    const submittedItemId = crypto.randomUUID();
    const submittedVariantId = crypto.randomUUID();
    const template = fixture.document.items.at(0);

    if (template === undefined) throw new Error("fixture item missing");

    const correction: MenuScanDocument = {
      ...fixture.document,
      items: [
        ...fixture.document.items,
        {
          ...template,
          id: submittedItemId,
          originalName: "Customer added soup",
          customerAdded: true,
          variants: [
            {
              id: submittedVariantId,
              customerAdded: true,
              originalLabel: "",
              translatedLabel: null,
              price: null,
            },
          ],
        },
      ],
    };

    const revised = await run(
      reviseMenuScan(guest, { scanId: fixture.scanId, expectedRevision: 1, document: correction }),
    );

    expect(revised.scan.current_revision).toBe(2);

    const added = revised.document?.items.find(
      (item) => item.originalName === "Customer added soup",
    );

    expect(added).toBeDefined();
    expect(added?.id).not.toBe(submittedItemId);
    expect(added?.variants.at(0)?.id).not.toBe(submittedVariantId);
    await expectFailure(
      reviseMenuScan(guest, { scanId: fixture.scanId, expectedRevision: 1, document: correction }),
      "ScanConflict",
    );

    const revisions = await sql<
      ReadonlyArray<{ revision: number; document: MenuScanDocument }>
    >`SELECT revision,document FROM feastjourney.menu_scan_revisions WHERE session_id=${fixture.scanId}::uuid ORDER BY revision`;

    expect(revisions.map((row) => row.revision)).toEqual([1, 2]);
    expect(revisions.at(0)?.document).toEqual(fixture.document);

    const immutableFailure: unknown =
      await sql`UPDATE feastjourney.menu_scan_revisions SET origin='customer' WHERE session_id=${fixture.scanId}::uuid AND revision=1`.then(
        () => "unexpected-success",
        (failure) => failure,
      );

    expect(immutableFailure).toMatchObject({ code: "23514" });
  });

  test("repeated consent submission preserves the same exact snapshot", async () => {
    const fixture = await extractedScan();

    const input = {
      scanId: fixture.scanId,
      revision: 1,
      consent: true as const,
      termsVersion: "menu-facts-v1" as const,
      venueId,
    };

    const first = await run(submitMenuContribution(guest, input));
    const second = await run(submitMenuContribution(guest, input));
    expect(second).toEqual(first);

    const rows = await sql<
      ReadonlyArray<{ submitted_revision: number; count: number }>
    >`SELECT submitted_revision,count(*)::int AS count FROM feastjourney.menu_scan_contributions WHERE session_id=${fixture.scanId}::uuid GROUP BY submitted_revision`;

    expect([...rows]).toEqual([{ submitted_revision: 1, count: 1 }]);

    const retention = await sql<
      ReadonlyArray<{ within_consent: boolean }>
    >`SELECT s.expires_at<=c.retention_until AS within_consent FROM feastjourney.menu_scan_sessions s JOIN feastjourney.menu_scan_contributions c ON c.session_id=s.id WHERE s.id=${fixture.scanId}::uuid`;

    expect([...retention]).toEqual([{ within_consent: true }]);
  });
});

describe("review authorization and transaction guarantees", () => {
  test("duplicate hints count consented contributions without exposing private personal scans", async () => {
    const fixture = await contributionFixture();
    const actor = Actor.Member({ userId: curatorId });
    const before = await run(withActor(actor, getMenuContribution(fixture.contributionId)));

    const originalCount = before.duplicates.find(
      (entry) => entry.asset_id === fixture.assetId,
    )?.contribution_count;

    expect(originalCount).toBeDefined();
    const personal = await extractedScan();
    const afterPersonal = await run(withActor(actor, getMenuContribution(fixture.contributionId)));
    expect(
      afterPersonal.duplicates.find((entry) => entry.asset_id === fixture.assetId)
        ?.contribution_count,
    ).toBe(originalCount);

    await run(
      submitMenuContribution(guest, {
        scanId: personal.scanId,
        revision: 1,
        consent: true,
        termsVersion: "menu-facts-v1",
        venueId,
      }),
    );
    const afterConsent = await run(withActor(actor, getMenuContribution(fixture.contributionId)));
    expect(
      afterConsent.duplicates.find((entry) => entry.asset_id === fixture.assetId)
        ?.contribution_count,
    ).toBe((originalCount ?? 0) + 1);
    await expectFailure(
      withActor(Actor.Member({ userId: memberId }), getMenuContribution(fixture.contributionId)),
      "InsufficientPermissions",
    );
  });

  test("ordinary members cannot inspect or approve a pending private contribution", async () => {
    const fixture = await contributionFixture();
    const actor = Actor.Member({ userId: memberId });
    await expectFailure(
      withActor(actor, getMenuContribution(fixture.contributionId)),
      "InsufficientPermissions",
    );
    await expectFailure(
      withActor(actor, reviewMenuContribution(approval(fixture))),
      "InsufficientPermissions",
    );
    expect((await run(getRestaurant(venueId, "delivery"))).offerings).toEqual([]);
  });

  test("approval requires explicit channel and rights confirmation", async () => {
    const fixture = await contributionFixture();
    const actor = Actor.Member({ userId: curatorId });
    await expectFailure(
      withActor(actor, reviewMenuContribution({ ...approval(fixture), channel: null })),
      "ScanInputError",
    );
    await expectFailure(
      withActor(actor, reviewMenuContribution({ ...approval(fixture), rightsReviewed: false })),
      "ScanInputError",
    );
    const view = await run(withActor(actor, getMenuContribution(fixture.contributionId)));
    expect(view.contribution.status).toBe("pending");
  });

  test("competing reviewer decisions have one winner with immutable attribution", async () => {
    const fixture = await contributionFixture();
    const input = approval(fixture);

    const results = await Promise.allSettled([
      run(withActor(Actor.Member({ userId: curatorId }), reviewMenuContribution(input))),
      run(
        withActor(
          Actor.Member({ userId: curatorId }),
          reviewMenuContribution({ ...input, decision: "rejected" }),
        ),
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
    expect(results.filter((result) => result.status === "rejected").length).toBe(1);

    const view = await run(
      withActor(Actor.Member({ userId: curatorId }), getMenuContribution(fixture.contributionId)),
    );

    expect(["approved", "rejected"]).toContain(view.contribution.status);
    expect(view.contribution.reviewed_by).toBe(curatorId);

    const menuCount = await sql<
      ReadonlyArray<{ count: number }>
    >`SELECT count(*)::int AS count FROM feastjourney.menu_scan_contribution_menus WHERE contribution_id=${fixture.contributionId}::uuid`;

    expect(menuCount.at(0)?.count).toBe(view.contribution.status === "approved" ? 1 : 0);
  });

  test("failure after nested promotion rolls back every curated write and review decision", async () => {
    const fixture = await contributionFixture();

    class ForcedRollback extends Data.TaggedError("ForcedRollback")<{}> {}

    await expectFailure(
      withTransaction(
        "test/rollback-menu-promotion",
        withActor(
          Actor.Member({ userId: curatorId }),
          reviewMenuContribution(approval(fixture)),
        ).pipe(Effect.andThen(new ForcedRollback())),
      ),
      "ForcedRollback",
    );

    const state = await run(
      withActor(Actor.Member({ userId: curatorId }), getMenuContribution(fixture.contributionId)),
    );

    expect(state.contribution.status).toBe("pending");
    expect(state.menus).toEqual([]);

    const sources = await sql<
      ReadonlyArray<{ count: number }>
    >`SELECT count(*)::int AS count FROM feastjourney.restaurant_sources WHERE venue_id=${venueId}::uuid AND deduplication_key LIKE ${`menu-contribution:${fixture.contributionId}:%`}`;

    expect(sources.at(0)?.count).toBe(0);

    const audits = await sql<
      ReadonlyArray<{ count: number }>
    >`SELECT count(*)::int AS count FROM feastjourney.security_audit_events WHERE resource=${fixture.contributionId} AND event='restaurant.contribution.approved'`;

    expect(audits.at(0)?.count).toBe(0);
    expect(
      (await run(readMenuPhoto(guest, fixture.scanId, fixture.assetId))).byteLength,
    ).toBeGreaterThan(0);
  });
});

describe("expiry and retryable binary cleanup", () => {
  test("expired personal scans erase their current revision without violating its foreign key", async () => {
    const fixture = await extractedScan();
    await sql`UPDATE feastjourney.menu_scan_sessions SET created_at=now()-INTERVAL '25 hours',expires_at=now()-INTERVAL '1 hour' WHERE id=${fixture.scanId}::uuid`;
    await sql`UPDATE feastjourney.menu_scan_assets SET created_at=now()-INTERVAL '10 minutes' WHERE session_id=${fixture.scanId}::uuid`;
    await expectFailure(getMenuScan(guest, fixture.scanId), "ScanNotFound");
    await run(cleanupMenuScans());

    const sessions = await sql<
      ReadonlyArray<{ status: string; current_revision: number | null }>
    >`SELECT status,current_revision FROM feastjourney.menu_scan_sessions WHERE id=${fixture.scanId}::uuid`;

    expect([...sessions]).toEqual([{ status: "deleted", current_revision: null }]);

    const revisions =
      await sql`SELECT revision FROM feastjourney.menu_scan_revisions WHERE session_id=${fixture.scanId}::uuid`;

    expect(revisions.length).toBe(0);
  });

  test("failed object deletion is bounded, deferred and succeeds on a later run", async () => {
    const fixture = await extractedScan();
    await sql`UPDATE feastjourney.menu_scan_sessions SET created_at=now()-INTERVAL '25 hours',expires_at=now()-INTERVAL '1 hour' WHERE id=${fixture.scanId}::uuid`;
    await sql`UPDATE feastjourney.menu_scan_assets SET created_at=now()-INTERVAL '10 minutes' WHERE session_id=${fixture.scanId}::uuid`;

    const rows = await sql<
      ReadonlyArray<{ object_key: string }>
    >`SELECT object_key FROM feastjourney.menu_scan_assets WHERE id=${fixture.assetId}::uuid`;

    const ownedAsset = rows.at(0);

    if (ownedAsset === undefined) throw new Error("asset fixture missing");
    const storage = await run(PrivateMenuStorage);
    let failedRemovals = 0;

    const failingStorage = {
      ...storage,
      remove: (key: string) => {
        if (key !== ownedAsset.object_key) return storage.remove(key);
        failedRemovals += 1;

        return Effect.fail(new StorageUnavailable());
      },
    };

    const report = await run(
      cleanupMenuScans().pipe(
        Effect.provideService(PrivateMenuStorage, failingStorage),
        Effect.timeout("5 seconds"),
      ),
    );

    expect(report.objectsFailed).toBe(1);
    expect(failedRemovals).toBe(1);

    const tracked = await sql<
      ReadonlyArray<{ delete_attempts: number; future_retry: boolean }>
    >`SELECT delete_attempts,next_delete_attempt_at>now() AS future_retry FROM feastjourney.menu_scan_assets WHERE id=${fixture.assetId}::uuid`;

    expect([...tracked]).toEqual([{ delete_attempts: 1, future_retry: true }]);

    const deferred = await run(
      cleanupMenuScans().pipe(Effect.provideService(PrivateMenuStorage, failingStorage)),
    );

    expect(deferred.objectsFailed).toBe(0);
    expect(failedRemovals).toBe(1);
    await sql`UPDATE feastjourney.menu_scan_assets SET next_delete_attempt_at=now()-INTERVAL '1 second' WHERE id=${fixture.assetId}::uuid`;
    await run(cleanupMenuScans());

    const object = await s3
      .send(new GetObjectCommand({ Bucket: bucket, Key: ownedAsset.object_key }))
      .then(
        () => "present",
        () => "gone",
      );

    expect(object).toBe("gone");

    const deleted = await sql<
      ReadonlyArray<{ status: string }>
    >`SELECT status FROM feastjourney.menu_scan_assets WHERE id=${fixture.assetId}::uuid`;

    expect([...deleted]).toEqual([{ status: "deleted" }]);
  });
});
