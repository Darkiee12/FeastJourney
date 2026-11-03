import { mkdir } from "node:fs/promises";

import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { chromium, request, type BrowserContext } from "playwright";
import { expect } from "playwright/test";
import postgres from "postgres";
import sharp from "sharp";
import { z } from "zod";

import {
  contributionViewSchema,
  scanViewSchema,
} from "@/modules/restaurant-discovery/menu-scan-client";

import { createFoodAuth } from "../integration/food-auth";

/** Actual application, PostgreSQL and Garage; only the external Muse endpoint is a fixture. */
const base = process.env.BROWSER_BASE_URL ?? "http://localhost:3104";
const databaseUrl = process.env.DATABASE_URL ?? "";
const endpoint = process.env.S3_ENDPOINT_INTERNAL ?? "";
const database = new URL(databaseUrl);
const storage = new URL(endpoint);

if (
  new URL(base).hostname !== "localhost" ||
  database.hostname !== "127.0.0.1" ||
  database.port !== "55434" ||
  database.pathname !== "/feastjourney_pr4_v2" ||
  storage.hostname !== "127.0.0.1" ||
  storage.port !== "53904"
) {
  throw new Error(
    "Browser fixtures require task-owned disposable DB55434 and Garage53904, plus a localhost application.",
  );
}

const sql = postgres(databaseUrl, { max: 2 });
const auth = createFoodAuth();
const bucket = z.string().min(1).parse(process.env.S3_BUCKET_PRIVATE);

const s3 = new S3Client({
  endpoint,
  region: "garage",
  forcePathStyle: true,
  credentials: {
    accessKeyId: z.string().min(1).parse(process.env.S3_ACCESS_KEY_ID),
    secretAccessKey: z.string().min(1).parse(process.env.S3_SECRET_ACCESS_KEY),
  },
});

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

const provider = await request.newContext({
  baseURL: "https://127.0.0.1:54444",
  ignoreHTTPSErrors: true,
});

const guest = await browser.newContext({
  viewport: { width: 320, height: 740 },
  reducedMotion: "reduce",
});

const outsider = await browser.newContext();
const curator = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await guest.newPage();
const navigation = page.getByRole("navigation", { name: "FeastJourney", exact: true });
const stamp = crypto.randomUUID().slice(0, 8);
const businessId = crypto.randomUUID();
const venueId = crypto.randomUUID();
const scanIds = new Set<string>();
const evidence = "/tmp/fj-pr4-browser-evidence";
const check = expect.configure({ timeout: 20000 });

type BrowserScanRead =
  | { readonly action: "get"; readonly scanId: string }
  | { readonly action: "getContribution"; readonly contributionId: string };

const api = (context: BrowserContext, input: BrowserScanRead) =>
  context.request.post(`${base}/api/menu-scans`, {
    headers: { origin: new URL(base).origin },
    data: input,
  });

const signIn = async (context: BrowserContext, email: string) => {
  const response = await context.request.post(`${base}/api/auth/sign-in/email`, {
    headers: { origin: new URL(base).origin },
    data: { email, password: "correct-horse-123" },
  });

  check(response.status()).toBe(200);
};

try {
  await mkdir(evidence, { recursive: true });
  await sql`INSERT INTO feastjourney.restaurant_businesses(id,name) VALUES(${businessId},${`Browser fixture ${stamp}`})`;
  await sql`INSERT INTO feastjourney.restaurant_venues(id,business_id,name,address,area,country_code,location,status)
    VALUES(${venueId},${businessId},${`Browser branch ${stamp}`},'Synthetic test address','Synthetic test area','VN',public.ST_SetSRID(public.ST_MakePoint(106.8,10.77),4326)::public.geography,'published')`;
  const editor = await auth.signupSignin("browser-curator");
  await auth.grantRole(editor.userId, "curator");
  await signIn(curator, editor.email);

  await page.goto(`${base}/scan?lang=en&venueId=${venueId}`);

  const first = await sharp(
    new Uint8Array(await Bun.file("tests/fixtures/menu-scans/browser-page-1.svg").arrayBuffer()),
  )
    .png()
    .toBuffer();

  const second = await sharp(
    new Uint8Array(await Bun.file("tests/fixtures/menu-scans/browser-page-2.svg").arrayBuffer()),
  )
    .png()
    .toBuffer();

  await page.locator("#scan-gallery").setInputFiles([
    { name: "synthetic-page-1.png", mimeType: "image/png", buffer: first },
    { name: "synthetic-page-2.png", mimeType: "image/png", buffer: second },
    { name: "synthetic-remove.png", mimeType: "image/png", buffer: second },
  ]);
  await page.getByRole("button", { name: "Remove photograph", exact: true }).last().click();
  await page.getByRole("button", { name: "Move earlier: 2", exact: true }).click();

  const created = page.waitForResponse(
    (response) =>
      response.url() === `${base}/api/menu-scans` &&
      response.request().postData()?.includes('"action":"create"') === true,
  );

  await page.getByRole("button", { name: "Analyze menu", exact: true }).click();
  const createdScan = z.object({ id: z.uuid() }).parse(await (await created).json());
  scanIds.add(createdScan.id);
  await check(page.getByRole("heading", { name: "Phở bò", exact: true })).toBeVisible({
    timeout: 65000,
  });
  await page.getByText("Check or correct the extraction", { exact: true }).click();
  await page.locator(".scan-corrections details summary").first().click();
  await page
    .getByLabel("Translated dish name", { exact: true })
    .first()
    .fill("Beef noodle soup, corrected");
  await check(page.locator(".menu-order-item").first()).toContainText(
    "Beef noodle soup, corrected",
  );

  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${base}/api/menu-scans` &&
      response.request().postData()?.includes('"action":"revise"') === true,
  );

  await page.getByRole("button", { name: "Save my scan", exact: true }).click();
  check((await saved).status()).toBe(200);
  await check(page.getByRole("button", { name: "Save my scan", exact: true })).toBeDisabled();
  const card = page.locator(".menu-order-item").first();
  await card.getByRole("combobox").selectOption({ label: "Tô lớn / Large bowl" });
  await card.getByRole("button", { name: "Add one: Phở bò", exact: true }).click({ clickCount: 2 });
  const show = page.getByRole("button", { name: "Show waiter card", exact: true });
  await show.click();
  const dialog = page.getByRole("dialog", { name: "Your order to show" });
  await check(dialog).toContainText("Phở bò");
  await check(dialog).toContainText("Tô lớn");
  await check(dialog).toContainText("160,000");
  await check(dialog).toContainText("No order has been submitted");
  await page.screenshot({ path: `${evidence}/guest-waiter-card.png`, fullPage: true });
  await dialog.screenshot({ path: `${evidence}/waiter-card-detail.png` });
  await page.keyboard.press("Escape");
  await check(show).toBeFocused();
  await page.getByRole("button", { name: "Add one: Gỏi cuốn", exact: true }).click();
  await show.click();
  await check(dialog).toContainText("Some prices or currencies are unknown");
  await page.keyboard.press("Escape");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );

  const view = scanViewSchema.parse(
    await (await api(guest, { action: "get", scanId: createdScan.id })).json(),
  );

  check((await api(outsider, { action: "get", scanId: createdScan.id })).status()).toBe(404);
  const asset = view.assets[0];

  if (asset === undefined) throw new Error("Uploaded page missing");
  check(
    (
      await outsider.request.get(
        `${base}/api/menu-scans?scanId=${createdScan.id}&assetId=${asset.id}`,
      )
    ).status(),
  ).toBe(404);

  const consent = page.getByRole("checkbox", {
    name: /I agree to submit this exact saved revision/,
  });

  await check(consent).not.toBeChecked();
  await check(
    page.getByRole("button", { name: "Contribute saved menu", exact: true }),
  ).toBeDisabled();
  await consent.check();
  await page.getByRole("button", { name: "Contribute saved menu", exact: true }).click();
  await check(page.getByText(/Contribution status: pending/)).toBeVisible();

  let contributed = scanViewSchema.parse(
    await (await api(guest, { action: "get", scanId: createdScan.id })).json(),
  );

  if (contributed.contribution === null) throw new Error("Contribution missing");
  const reviewPage = await curator.newPage();
  await reviewPage.goto(`${base}/admin/restaurants?lang=en`);
  await reviewPage
    .getByRole("button", { name: new RegExp(contributed.contribution.id.slice(0, 8)) })
    .click();
  const rejectedId = contributed.contribution.id;
  await reviewPage
    .getByLabel("Review notes (required)", { exact: true })
    .fill("Synthetic rejection: correct the source description before resubmitting.");

  const rejection = reviewPage.waitForResponse(
    (response) =>
      response.url() === `${base}/api/menu-scans` &&
      response.request().postData()?.includes('"action":"review"') === true,
  );

  await reviewPage.getByRole("button", { name: "Reject submission", exact: true }).click();
  check((await rejection).status()).toBe(200);
  await page.reload();
  await check(page.getByText(/Contribution status: rejected/)).toBeVisible();
  await check(page.getByRole("button", { name: "Contribute saved menu", exact: true })).toHaveCount(
    0,
  );
  await page.getByText("Check or correct the extraction", { exact: true }).click();
  await page.locator(".scan-corrections details summary").first().click();
  await page
    .getByLabel("Original description", { exact: true })
    .first()
    .fill("Nước dùng bò đã kiểm tra");

  const corrected = page.waitForResponse(
    (response) =>
      response.url() === `${base}/api/menu-scans` &&
      response.request().postData()?.includes('"action":"revise"') === true,
  );

  await page.getByRole("button", { name: "Save my scan", exact: true }).click();
  check((await corrected).status()).toBe(200);
  await check(consent).not.toBeChecked();
  await consent.check();
  await page.getByRole("button", { name: "Contribute saved menu", exact: true }).click();
  await check(page.getByText(/Contribution status: pending/)).toBeVisible();
  contributed = scanViewSchema.parse(
    await (await api(guest, { action: "get", scanId: createdScan.id })).json(),
  );

  if (contributed.contribution === null) throw new Error("Corrected contribution missing");
  check(contributed.contribution.id).not.toBe(rejectedId);
  check(contributed.contribution.revision).toBe(3);

  const rejected = contributionViewSchema.parse(
    await (await api(curator, { action: "getContribution", contributionId: rejectedId })).json(),
  );

  check(rejected.contribution.status).toBe("rejected");
  check(rejected.contribution.revision).toBe(2);
  await reviewPage.reload();
  await reviewPage
    .getByRole("button", { name: new RegExp(contributed.contribution.id.slice(0, 8)) })
    .click();
  await reviewPage.getByLabel("Confirmed branch ID", { exact: true }).fill(venueId);
  await reviewPage.getByLabel("Confirmed sales channel", { exact: true }).selectOption("dine_in");
  await reviewPage
    .getByLabel("Review notes (required)", { exact: true })
    .fill("Synthetic browser review: source pages and prices checked.");
  await reviewPage.getByRole("checkbox", { name: /Phở bò/ }).check();
  await reviewPage.getByRole("checkbox", { name: /Tô lớn.*80.000/ }).check();
  await reviewPage
    .getByRole("checkbox", { name: /I checked these photographs for personal data/ })
    .check();

  const reviewed = reviewPage.waitForResponse(
    (response) =>
      response.url() === `${base}/api/menu-scans` &&
      response.request().postData()?.includes('"action":"review"') === true,
  );

  await reviewPage.getByRole("button", { name: "Approve selected facts", exact: true }).click();
  check((await reviewed).status()).toBe(200);

  const approved = contributionViewSchema.parse(
    await (
      await api(curator, { action: "getContribution", contributionId: contributed.contribution.id })
    ).json(),
  );

  check(approved.contribution.status).toBe("approved");
  const metricsSchema = z.object({ requests: z.number() });
  const beforeReuse = metricsSchema.parse(await (await provider.get("/metrics")).json());
  await page.goto(`${base}/restaurants/${venueId}?lang=en`);
  await check(page.locator(".menu-order-item")).toHaveCount(1);
  await check(page.locator(".menu-order-item")).toContainText("Beef noodle soup, corrected");
  await page.screenshot({ path: `${evidence}/reviewed-reuse.png`, fullPage: true });
  check(metricsSchema.parse(await (await provider.get("/metrics")).json()).requests).toBe(
    beforeReuse.requests,
  );

  const memberA = await auth.signupSignin("browser-member-a");
  const memberB = await auth.signupSignin("browser-member-b");
  await signIn(guest, memberA.email);
  await navigation.getByRole("link", { name: "Scan menu", exact: true }).click();
  await page
    .getByRole("button", { name: "Keep my previous guest scan in this account", exact: true })
    .click();
  await check(page.locator(".menu-order-item")).toHaveCount(2);
  check((await api(guest, { action: "get", scanId: createdScan.id })).status()).toBe(200);

  await navigation.getByRole("link", { name: "Restaurants", exact: true }).click();
  const preference = page.getByLabel("Show approximate equivalents in", { exact: true });
  await preference.selectOption("VND");
  await check
    .poll(async () => {
      const rows = await sql<
        ReadonlyArray<{ preferred_currency: string | null }>
      >`SELECT preferred_currency FROM feastjourney.user_profiles WHERE user_id=${memberA.userId}`;

      return rows[0]?.preferred_currency;
    })
    .toBe("VND");

  const signedOut = await guest.request.post(`${base}/api/auth/sign-out`, {
    headers: { origin: new URL(base).origin },
    data: {},
  });

  check(signedOut.status()).toBe(200);
  await signIn(guest, memberB.email);
  // Keep the same mounted application and QueryClient across this account switch.
  await navigation.getByRole("link", { name: "Scan menu", exact: true }).click();
  await check(page.locator(".menu-order-item")).toHaveCount(0);
  await check(
    page.getByRole("button", { name: "Keep my previous guest scan in this account", exact: true }),
  ).toHaveCount(0);
  check((await api(guest, { action: "get", scanId: createdScan.id })).status()).toBe(404);
  await navigation.getByRole("link", { name: "Restaurants", exact: true }).click();
  await check(preference).toHaveValue("");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: `${evidence}/account-switch-isolation.png`, fullPage: true });

  process.stdout.write(
    "Browser guest, uncertainty, contribution, review, reuse, private-isolation and account-switch journeys passed. Muse was a synthetic provider fixture.\n",
  );
} finally {
  await browser.close();
  await provider.dispose();
  const ids = [...scanIds];

  const assets = await sql<
    ReadonlyArray<{ object_key: string }>
  >`SELECT object_key FROM feastjourney.menu_scan_assets WHERE session_id=ANY(${ids}::uuid[])`;

  await Promise.all(
    assets.map((asset) =>
      s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: asset.object_key })),
    ),
  );
  await sql.begin(async (tx) => {
    await tx`DELETE FROM feastjourney.menu_scan_contribution_menus WHERE contribution_id IN(SELECT id FROM feastjourney.menu_scan_contributions WHERE session_id=ANY(${ids}::uuid[]))`;
    await tx`DELETE FROM feastjourney.menu_scan_contributions WHERE session_id=ANY(${ids}::uuid[])`;
    await tx`UPDATE feastjourney.menu_scan_sessions SET current_revision=NULL WHERE id=ANY(${ids}::uuid[])`;
    await tx`DELETE FROM feastjourney.menu_scan_revisions WHERE session_id=ANY(${ids}::uuid[])`;
    await tx`DELETE FROM feastjourney.menu_scan_assets WHERE session_id=ANY(${ids}::uuid[])`;
    await tx`DELETE FROM feastjourney.menu_scan_sessions WHERE id=ANY(${ids}::uuid[])`;
    await tx`DELETE FROM feastjourney.restaurant_price_observations WHERE venue_id=${venueId}::uuid`;
    await tx`DELETE FROM feastjourney.restaurant_serving_evidence WHERE venue_id=${venueId}::uuid`;
    await tx`DELETE FROM feastjourney.restaurant_menu_item_variants WHERE venue_id=${venueId}::uuid`;
    await tx`DELETE FROM feastjourney.restaurant_menu_items WHERE venue_id=${venueId}::uuid`;
    await tx`DELETE FROM feastjourney.restaurant_menus WHERE venue_id=${venueId}::uuid`;
    await tx`DELETE FROM feastjourney.restaurant_sources WHERE venue_id=${venueId}::uuid`;
    await tx`DELETE FROM feastjourney.restaurant_venues WHERE id=${venueId}::uuid`;
    await tx`DELETE FROM feastjourney.restaurant_businesses WHERE id=${businessId}::uuid`;
  });
  await sql.end();
  await auth.close();
  s3.destroy();
}
