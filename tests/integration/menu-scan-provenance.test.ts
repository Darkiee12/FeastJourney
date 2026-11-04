import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { Effect, Layer, ManagedRuntime } from "effect";
import postgres from "postgres";
import sharp from "sharp";

import type {
  MenuExtraction,
  MenuScanDocument,
} from "@/modules/restaurant-discovery/menu-scan.schema";
import {
  attachMenuPhoto,
  createMenuScan,
  extractMenu,
  getMenuScan,
  reviseMenuScan,
  type ScanPrincipal,
} from "@/modules/restaurant-discovery/server/operations/menu-scans";
import { DatabaseLive, type Database } from "@/server/database/client";
import { resetServerEnvCache } from "@/server/env";
import { MenuExtractor } from "@/server/integrations/muse-menu";
import { PrivateMenuStorage, StorageUnavailable } from "@/server/integrations/private-menu-storage";

const sql = postgres(process.env.DATABASE_URL ?? "", { max: 3 });
const stamp = crypto.randomUUID().slice(0, 8);

const guest: ScanPrincipal = {
  userId: null,
  guestHash: createHash("sha256").update(`provenance-${stamp}`).digest("hex"),
};

const scanIds: Array<string> = [];

const originalScannerEnabled = process.env["MENU_SCANNER_ENABLED"];
const originalApiKey = process.env["MODEL_API_KEY"];

const enableScanner = (): void => {
  process.env["MENU_SCANNER_ENABLED"] = "true";
  process.env["MODEL_API_KEY"] = "synthetic-provenance-key";
  resetServerEnvCache();
};

const disableScanner = (): void => {
  delete process.env["MENU_SCANNER_ENABLED"];
  resetServerEnvCache();
};

const restoreScannerEnv = (): void => {
  if (originalScannerEnabled === undefined) delete process.env["MENU_SCANNER_ENABLED"];
  else process.env["MENU_SCANNER_ENABLED"] = originalScannerEnabled;

  if (originalApiKey === undefined) delete process.env["MODEL_API_KEY"];
  else process.env["MODEL_API_KEY"] = originalApiKey;

  resetServerEnvCache();
};

const extraction = (assetId: string): MenuExtraction => ({
  sourceLanguage: "vi",
  menuTitle: "Synthetic provenance menu",
  orderIntroduction: { original: "Tôi muốn gọi", translated: "I would like" },
  items: ["Phở bò"].map((originalName) => ({
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

const objects = new Map<string, Uint8Array>();

const memoryStorage = Layer.succeed(PrivateMenuStorage, {
  put: (key: string, bytes: Uint8Array) => {
    objects.set(key, bytes);

    return Effect.void;
  },
  read: (key: string) => {
    const bytes = objects.get(key);

    if (bytes === undefined) return Effect.fail(new StorageUnavailable());

    return Effect.succeed(bytes);
  },
  remove: (key: string) => {
    objects.delete(key);

    return Effect.void;
  },
});

const runtime = ManagedRuntime.make(Layer.mergeAll(DatabaseLive, memoryStorage, fakeExtractor));

type TestServices = Database | PrivateMenuStorage | MenuExtractor;

const run = <A, E, R extends TestServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  runtime.runPromise(effect);

async function expectFailure<A, E, R extends TestServices>(
  effect: Effect.Effect<A, E, R>,
  tag: string,
): Promise<void> {
  const failure = await run(Effect.flip(effect));
  expect(failure).toMatchObject({ _tag: tag });
}

const photo = sharp({ create: { width: 48, height: 48, channels: 3, background: "#304080" } })
  .png()
  .toBuffer();

async function waitForExtractionDocument(scanId: string) {
  const deadline = Date.now() + 10000;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- Status polling is sequential by design.
    const current = await run(getMenuScan(guest, scanId));

    if (current.document !== null) return current;

    if (Date.now() >= deadline) throw new Error("synthetic extraction document missing");

    // oxlint-disable-next-line no-await-in-loop -- Status polling is sequential by design.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function extractedScan(): Promise<{ scanId: string; document: MenuScanDocument }> {
  const created = await run(createMenuScan(guest, { targetLanguage: "en", venueId: null }));
  scanIds.push(created.id);
  await run(attachMenuPhoto(guest, created.id, 1, await photo, "image/png"));
  // Extraction runs detached server-side; the accept returns the processing
  // view promptly, so poll the scan view until the document lands.
  await run(extractMenu(guest, created.id, crypto.randomUUID()));
  const view = await waitForExtractionDocument(created.id);

  if (view.document === null) throw new Error("synthetic extraction document missing");

  return { scanId: created.id, document: view.document };
}

afterAll(async () => {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM feastjourney.menu_scan_contributions WHERE session_id=ANY(${scanIds}::uuid[])`;
    await tx`UPDATE feastjourney.menu_scan_sessions SET current_revision=NULL WHERE id=ANY(${scanIds}::uuid[])`;
    await tx`DELETE FROM feastjourney.menu_scan_revisions WHERE session_id=ANY(${scanIds}::uuid[])`;
    await tx`DELETE FROM feastjourney.menu_scan_assets WHERE session_id=ANY(${scanIds}::uuid[])`;
    await tx`DELETE FROM feastjourney.menu_scan_sessions WHERE id=ANY(${scanIds}::uuid[])`;
  });
  restoreScannerEnv();
  await runtime.dispose();
  await sql.end();
});

describe("scan revision model provenance", () => {
  beforeEach(() => {
    enableScanner();
  });

  test("model revisions record the configured model, customer revisions record null", async () => {
    const fixture = await extractedScan();

    const rows = await sql<
      ReadonlyArray<{ revision: number; origin: string; model: string | null }>
    >`SELECT revision,origin,model FROM feastjourney.menu_scan_revisions WHERE session_id=${fixture.scanId}::uuid ORDER BY revision`;

    expect([...rows]).toEqual([{ revision: 1, origin: "model", model: "muse-spark-1.3" }]);

    const corrected = {
      ...fixture.document,
      items: fixture.document.items.map((item) => ({
        ...item,
        translatedName: "Customer corrected name",
      })),
    };

    const revised = await run(
      reviseMenuScan(guest, { scanId: fixture.scanId, expectedRevision: 1, document: corrected }),
    );

    expect(revised.scan.current_revision).toBe(2);

    const after = await sql<
      ReadonlyArray<{ revision: number; origin: string; model: string | null }>
    >`SELECT revision,origin,model FROM feastjourney.menu_scan_revisions WHERE session_id=${fixture.scanId}::uuid ORDER BY revision`;

    expect([...after]).toEqual([
      { revision: 1, origin: "model", model: "muse-spark-1.3" },
      { revision: 2, origin: "customer", model: null },
    ]);
  });

  test("a disabled scanner fails extraction before any revision is recorded", async () => {
    disableScanner();
    const created = await run(createMenuScan(guest, { targetLanguage: "en", venueId: null }));
    scanIds.push(created.id);
    await run(attachMenuPhoto(guest, created.id, 1, await photo, "image/png"));
    await expectFailure(
      extractMenu(guest, created.id, crypto.randomUUID()),
      "ExtractionUnavailable",
    );

    const rows =
      await sql`SELECT revision FROM feastjourney.menu_scan_revisions WHERE session_id=${created.id}::uuid`;

    expect(rows.length).toBe(0);
  });
});
