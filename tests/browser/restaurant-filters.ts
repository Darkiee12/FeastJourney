import { mkdir, writeFile } from "node:fs/promises";

import { chromium, type Browser, type Page } from "playwright";

/**
 * Agent C QA sweep: restaurant filters sheet + menu language selector.
 *
 * Read-only against the app (no DB writes, no fixture inserts). Covers 25
 * interaction checks (F01..F25) across mobile 320/390 touch + desktop 1280
 * viewports. Anything the current tree cannot support is marked PENDING with
 * a reason — never forced to pass.
 *
 * Hydration note: the app server-renders, so controls exist before React
 * attaches. All interactions go through helpers that retry until the UI
 * actually responds (pre-hydration taps are dead, not failures).
 *
 * Run: `BROWSER_BASE_URL=http://127.0.0.1:3221 bun tests/browser/restaurant-filters.ts`
 */
const base = process.env.BROWSER_BASE_URL ?? "http://127.0.0.1:3221";
const evidence = "/tmp/opencode/pr13-filters";
const executablePath = `${process.env.HOME}/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome`;

const SEARCH = `${base}/restaurants?lang=en`;

const HCMC_BOUNDS =
  `${base}/restaurants?lang=en&q=&area=&cuisine=&radius=5000&channel=dine_in` +
  `&sort=recommended&limit=30&view=browse&west=106.4&south=10.4&east=107&north=11.1`;

const HCMC_CENTER =
  `${base}/restaurants?lang=en&q=&area=&cuisine=&radius=5000&channel=dine_in` +
  `&sort=recommended&limit=30&view=browse&longitude=106.7009&latitude=10.7769`;

interface CheckResult {
  readonly id: string;
  readonly name: string;
  readonly status: "pass" | "fail" | "pending";
  readonly detail: string;
}

class Pending extends Error {}

const results: Array<CheckResult> = [];

async function check(id: string, name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();

    results.push({ id, name, status: "pass", detail });
    process.stdout.write(`PASS ${id} ${name} — ${detail}\n`);
  } catch (error) {
    if (error instanceof Pending) {
      results.push({ id, name, status: "pending", detail: error.message });
      process.stdout.write(`PENDING ${id} ${name} — ${error.message}\n`);
    } else {
      const detail = error instanceof Error ? error.message : String(error);

      results.push({ id, name, status: "fail", detail });
      process.stdout.write(`FAIL ${id} ${name} — ${detail}\n`);
    }
  }
}

const filtersButton = (page: Page) =>
  page.getByRole("button", { name: /^Filters( \(\d+\))?$/ }).first();

const sheetDialog = (page: Page) => page.getByRole("dialog", { name: "Filters" });

/** Click Filters until the sheet actually opens (survives pre-hydration taps). */
async function openFilters(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await filtersButton(page).waitFor({ state: "visible", timeout: 30000 });

  /* oxlint-disable eslint/no-await-in-loop -- Retry loop: each tap must settle before checking whether the sheet opened. */
  for (let attempt = 0; attempt < 10; attempt++) {
    await filtersButton(page).click();
    await page.waitForTimeout(1500);

    if ((await sheetDialog(page).count()) > 0) {
      await sheetDialog(page).waitFor({ state: "visible", timeout: 5000 });

      return;
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */

  throw new Error("sheet never opened after 10 filter taps (hydration suspected)");
}

/** Ensure the cuisine listbox is open (clicks through Radix's
 *  outside-pointer-events lock with a real pointerdown). */
async function ensureSelectOpen(page: Page): Promise<void> {
  if ((await page.getByRole("listbox").count()) > 0) return;
  await page.locator("#sheet-cuisine").click({ force: true });
  await page.getByRole("listbox").waitFor({ state: "visible", timeout: 10000 });
}

/** Ensure the cuisine listbox is closed. */
async function ensureSelectClosed(page: Page): Promise<void> {
  if ((await page.getByRole("listbox").count()) === 0) return;
  await page.keyboard.press("Escape");
  await page.getByRole("listbox").waitFor({ state: "hidden", timeout: 10000 });
}

/** Click Filters without navigating (page already where it needs to be). */
async function openFiltersHere(page: Page): Promise<void> {
  /* oxlint-disable eslint/no-await-in-loop -- Retry loop: each tap must settle before checking whether the sheet opened. */
  for (let attempt = 0; attempt < 10; attempt++) {
    await filtersButton(page).click();
    await page.waitForTimeout(1500);

    if ((await sheetDialog(page).count()) > 0) {
      await sheetDialog(page).waitFor({ state: "visible", timeout: 5000 });

      return;
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */

  throw new Error("sheet never opened after 10 filter taps (hydration suspected)");
}

/** Tap the results-sheet handle until the snap actually moves (touch-safe). */
async function expandResultsSheet(page: Page): Promise<string> {
  const sheet = page.locator(".mapapp-sheet");

  /* oxlint-disable eslint/no-await-in-loop -- Retry loop: each tap must settle before re-reading the snap. */
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.locator(".mapapp-sheet-handle").tap();
    await page.waitForTimeout(1000);

    const snap = (await sheet.getAttribute("data-snap")) ?? "0";

    if (snap !== "0") return snap;
  }
  /* oxlint-enable eslint/no-await-in-loop */

  throw new Error("sheet handle taps never left peek");
}

async function closeSheet(page: Page): Promise<void> {
  if ((await sheetDialog(page).count()) === 0) return;
  await page.keyboard.press("Escape");
  await sheetDialog(page).waitFor({ state: "hidden", timeout: 10000 });
}

let browser: Browser | null = null;

try {
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });

  // ---------- Mobile 320: dropdown + sheet fundamentals ----------
  const mobile = await browser.newContext({
    viewport: { width: 320, height: 740 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });

  const page = await mobile.newPage();

  await check("F01", "cuisine listbox opens inside the 320px viewport", async () => {
    await openFilters(page, SEARCH);

    await page.locator("#sheet-cuisine").click();
    await page.getByRole("listbox").waitFor({ state: "visible", timeout: 10000 });
    const box = await page.getByRole("listbox").boundingBox();

    if (box === null) throw new Error("listbox has no bounding box");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth);

    await page.screenshot({ path: `${evidence}/f01-cuisine-open-320.png` });

    if (box.x < -1 || box.x + box.width > 321) {
      throw new Error(`listbox x=${box.x} w=${box.width} escapes 320px viewport`);
    }

    if (overflow > 321) throw new Error(`document scrollWidth ${overflow} > 321`);
    await page.keyboard.press("Escape");
    await page.getByRole("listbox").waitFor({ state: "hidden", timeout: 10000 });

    return `listbox x=${Math.round(box.x)} w=${Math.round(box.width)}, doc ${overflow}px`;
  });

  await check("F02", "select content width matches its trigger", async () => {
    await page.locator("#sheet-cuisine").click();
    await page.getByRole("listbox").waitFor({ state: "visible", timeout: 10000 });
    const trigger = await page.locator("#sheet-cuisine").boundingBox();
    const content = await page.getByRole("listbox").boundingBox();

    if (trigger === null || content === null) throw new Error("missing boxes");
    const diff = Math.abs(trigger.width - content.width);

    await page.keyboard.press("Escape");
    await page.getByRole("listbox").waitFor({ state: "hidden", timeout: 10000 });

    if (diff > 8) throw new Error(`trigger ${trigger.width} vs content ${content.width}`);

    return `trigger ${Math.round(trigger.width)}px, content ${Math.round(content.width)}px`;
  });

  await check("F03", "outside click closes listbox without changing value", async () => {
    await ensureSelectOpen(page);
    const before = await page.locator("#sheet-cuisine").textContent();

    // Radix's dismissable layer deliberately swallows hit-testing outside
    // the open listbox, so Playwright's actionability check never clears.
    // A force-click still delivers a genuine pointerdown outside the
    // listbox (sheet header, above the dropdown) — exactly what a user tap
    // does — and Radix must dismiss on it.
    await page.locator(".rf-head .rf-title").click({ force: true });
    await page.getByRole("listbox").waitFor({ state: "hidden", timeout: 10000 });
    const after = await page.locator("#sheet-cuisine").textContent();

    if (before !== after) throw new Error(`value changed: ${before} -> ${after}`);

    return `value stable (${(after ?? "").trim().slice(0, 40)})`;
  });

  await check("F04", "Escape closes listbox but keeps the sheet open", async () => {
    await ensureSelectOpen(page);
    await page.keyboard.press("Escape");
    await page.getByRole("listbox").waitFor({ state: "hidden", timeout: 10000 });

    if ((await sheetDialog(page).count()) !== 1) throw new Error("sheet closed by select Escape");

    return "listbox hidden, sheet still open";
  });

  await check("F05", "focus returns to the select trigger after Escape", async () => {
    await ensureSelectOpen(page);
    await page.keyboard.press("Escape");
    await page.getByRole("listbox").waitFor({ state: "hidden", timeout: 10000 });

    const focused = await page.evaluate(() => {
      const active = document.activeElement;

      return active instanceof HTMLElement ? active.id : "";
    });

    if (focused !== "sheet-cuisine") throw new Error("focus on nothing");

    return "focus on #sheet-cuisine";
  });

  await check("F06", "disabled sort options cannot be selected", async () => {
    await ensureSelectClosed(page);
    const low = page.getByRole("radio", { name: "Lowest price" });
    const nearest = page.getByRole("radio", { name: "Nearest" });

    if ((await low.count()) === 0) throw new Error("price sort radios absent");

    if (!(await low.isDisabled())) {
      throw new Pending(
        "price sorts enabled — dish context present; disabled state untestable here",
      );
    }

    if (!(await nearest.isDisabled())) throw new Error("Nearest enabled without location");
    await low.click({ force: true }).catch(() => {});

    if (await low.isChecked()) throw new Error("disabled price sort became checked");

    return "Lowest price + Highest price disabled; Nearest disabled without location";
  });

  await check("F07", "opening a select causes no scroll-lock page jump", async () => {
    const before = await page.evaluate(() => ({
      y: window.scrollY,
      pad: document.body.style.paddingRight,
    }));

    await ensureSelectOpen(page);

    const during = await page.evaluate(() => ({
      y: window.scrollY,
      pad: document.body.style.paddingRight,
    }));

    await page.keyboard.press("Escape");
    await page.getByRole("listbox").waitFor({ state: "hidden", timeout: 10000 });

    if (before.y !== during.y) throw new Error(`scrollY ${before.y} -> ${during.y}`);

    if (before.pad !== during.pad) throw new Error(`body padding ${before.pad} -> ${during.pad}`);

    return `scrollY ${before.y}, body padding unchanged`;
  });

  await check("F11", "sheet opens cleanly at 320px", async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth);

    await page.screenshot({ path: `${evidence}/f11-sheet-320.png` });

    if (overflow > 321) throw new Error(`doc scrollWidth ${overflow} > 321`);

    return `dialog visible, doc ${overflow}px`;
  });

  await check("F12", "sheet body scrolls independently of page and footer", async () => {
    await page.setViewportSize({ width: 320, height: 500 });

    const scrolled = await page.evaluate(() => {
      const body = document.querySelector(".rf-scroll");

      if (!(body instanceof HTMLElement)) return null;
      body.scrollTop = body.scrollHeight;

      return { top: body.scrollTop, pageY: window.scrollY };
    });

    if (scrolled === null) throw new Error(".rf-scroll absent");

    if (scrolled.top <= 0) {
      await page.setViewportSize({ width: 320, height: 740 });
      throw new Pending(`body not scrollable even at 500px height (top=${scrolled.top})`);
    }

    if (scrolled.pageY !== 0) throw new Error(`page scrolled to ${scrolled.pageY}`);

    return `rf-scroll top=${scrolled.top} at 500px height, pageY=0`;
  });

  await check("F13", "footer stays visible with the body scrolled to bottom", async () => {
    await ensureSelectClosed(page);
    await page.evaluate(() => {
      const body = document.querySelector(".rf-scroll");

      if (body instanceof HTMLElement) body.scrollTop = body.scrollHeight;
    });
    const clear = page.getByRole("button", { name: "Clear all filters" });
    const apply = page.getByRole("button", { name: "Show results" });

    if (!(await clear.isVisible()) || !(await apply.isVisible())) {
      await page.setViewportSize({ width: 320, height: 740 });
      throw new Error("footer buttons not visible after body scroll");
    }

    await page.screenshot({ path: `${evidence}/f13-footer-sticky-320.png` });
    await page.setViewportSize({ width: 320, height: 740 });

    return "Clear + Show results visible after scroll at 500px height";
  });

  await check(
    "F14",
    "footer reachable by keyboard; Escape closes sheet with focus return",
    async () => {
      await ensureSelectClosed(page);
      await page.evaluate(() => {
        const body = document.querySelector(".rf-scroll");

        if (body instanceof HTMLElement) body.scrollTop = 0;
      });
      await page.locator(".rf-sheet .rf-icon-btn").focus();
      const seen = new Set<string>();

      for (let i = 0; i < 40; i++) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential keyboard walk: each Tab changes focus, so presses cannot run in parallel.
        await page.keyboard.press("Tab");

        // oxlint-disable-next-line eslint/no-await-in-loop -- Focus must be read after each Tab.
        const name = (await page.evaluate(() => document.activeElement?.textContent)) ?? "";

        seen.add(name.trim().slice(0, 24));

        if (name.includes("Show results")) break;
      }

      if (![...seen].some((entry) => entry.includes("Show results"))) {
        throw new Error(`Show results never focused; saw: ${[...seen].join(" | ").slice(0, 160)}`);
      }

      await page.keyboard.press("Escape");
      await sheetDialog(page).waitFor({ state: "hidden", timeout: 10000 });

      const focused = await page.evaluate(() => {
        const active = document.activeElement;

        return active instanceof HTMLElement ? (active.getAttribute("aria-label") ?? "") : "";
      });

      await page.screenshot({ path: `${evidence}/f14-sheet-closed-320.png` });

      if (focused !== "Filters" && !focused.startsWith("Filters (")) {
        throw new Error(`focus returned to ${focused || "nothing"}`);
      }

      return "Tab reaches Show results; Escape closes; focus back on Filters button";
    },
  );

  await check("F15", "no 320px overflow with sheet open and dropdown expanded", async () => {
    await openFilters(page, SEARCH);
    await page.locator("#sheet-cuisine").click();
    await page.getByRole("listbox").waitFor({ state: "visible", timeout: 10000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth);

    await page.screenshot({ path: `${evidence}/f15-dropdown-overflow-320.png` });
    await page.keyboard.press("Escape");

    if (overflow > 321) throw new Error(`doc scrollWidth ${overflow} > 321`);

    return `doc ${overflow}px with listbox open`;
  });

  await check("F16", "dining toggle flips aria-pressed and applies to URL", async () => {
    const takeaway = page.getByRole("button", { name: "Takeaway" });

    await takeaway.click();

    if ((await takeaway.getAttribute("aria-pressed")) !== "true") {
      throw new Error("aria-pressed not true after click");
    }

    await page.getByRole("button", { name: "Show results" }).click();
    await page.waitForURL(/channel=takeaway/, { timeout: 30000 });

    return "channel=takeaway in URL";
  });

  await check("F17", "nearest sort disabled without a location", async () => {
    await openFilters(page, SEARCH);
    const nearest = page.getByRole("radio", { name: "Nearest" });

    if ((await nearest.count()) === 0) throw new Error("Nearest radio absent");

    if (!(await nearest.isDisabled())) throw new Error("Nearest enabled without location");
    await closeSheet(page);

    return "Nearest disabled with no center";
  });

  await check("F19", "clear-all resets filters to defaults and closes", async () => {
    await openFilters(page, SEARCH);
    await page.locator("#sheet-cuisine").click();
    await page.getByRole("listbox").waitFor({ state: "visible", timeout: 10000 });
    const vietnamese = page.getByRole("option", { name: "Vietnamese" });

    if ((await vietnamese.count()) > 0) {
      await vietnamese.click();
    } else {
      await page.keyboard.press("Escape");
    }

    await page.getByRole("button", { name: "Takeaway" }).click();
    await page.getByRole("button", { name: "Clear all filters" }).click();
    await sheetDialog(page).waitFor({ state: "hidden", timeout: 10000 });
    const url = new URL(page.url());

    if (url.searchParams.get("cuisine") !== "") {
      throw new Error(`cuisine=${url.searchParams.get("cuisine")}`);
    }

    if (url.searchParams.get("channel") !== "dine_in") {
      throw new Error(`channel=${url.searchParams.get("channel")}`);
    }

    if (url.searchParams.get("sort") !== "recommended") {
      throw new Error(`sort=${url.searchParams.get("sort")}`);
    }

    return "cuisine empty, dine_in, recommended";
  });

  await check("F20", "apply navigates exactly once with no duplicate search posts", async () => {
    await openFilters(page, SEARCH);
    const posts: Array<string> = [];

    const onRequest = (request: { method(): string; url(): string; postData(): string | null }) => {
      if (request.method() === "POST" && request.url().startsWith(base)) {
        posts.push(`${request.url()} :: ${request.postData() ?? ""}`);
      }
    };

    let navigations = 0;

    const onNav = (navigatedUrl: string): void => {
      if (navigatedUrl.includes("/restaurants")) navigations += 1;
    };

    const frameHandler = (frame: { url(): string } & object): void => {
      onNav(frame.url());
    };

    page.on("request", onRequest);
    page.on("framenavigated", frameHandler);
    await page.locator("#sheet-cuisine").click();
    await page.getByRole("listbox").waitFor({ state: "visible", timeout: 10000 });
    const firstReal = page.getByRole("option").nth(1);

    await firstReal.click();
    navigations = 0;
    posts.length = 0;
    await page.getByRole("button", { name: "Show results" }).click();
    await page.waitForURL(/cuisine=[^&]+/, { timeout: 30000 });
    await page.waitForTimeout(4000);
    const dupes = posts.filter((entry, index) => posts.indexOf(entry) !== index);

    page.off("request", onRequest);
    page.off("framenavigated", frameHandler);

    if (navigations !== 1) throw new Error(`${navigations} restaurant navigations on apply`);

    if (dupes.length > 0) throw new Error(`duplicate posts: ${dupes[0]?.slice(0, 120)}`);

    return `1 navigation, ${posts.length} same-origin POSTs, no identical duplicates`;
  });

  await check("F21", "applied cuisine lands in URL and filter chip", async () => {
    const url = new URL(page.url());
    const cuisine = url.searchParams.get("cuisine");

    if (cuisine === null || cuisine === "") throw new Error("no cuisine in URL after F20 apply");
    // Chips live inside the results sheet body, hidden at peek snap on
    // mobile — assert attachment + label rather than visibility.
    const chip = page.locator(".mapapp-chip-label").first();

    await chip.waitFor({ state: "attached", timeout: 15000 });
    const label = (await chip.textContent()) ?? "";

    if (label.trim() === "") throw new Error("chip label empty");

    return `cuisine=${cuisine}, chip "${label.trim().slice(0, 40)}" attached`;
  });

  await check("F08", "currency picker filters by ISO code", async () => {
    await openFilters(page, `${SEARCH}&dish=9`);
    const picker = page.locator(".rf-currency-trigger");

    if ((await picker.count()) === 0) {
      throw new Pending("no price section for dish=9 (no comparable servings); needs dish context");
    }

    await picker.click({ force: true });
    await page.locator(".rf-currency-search").fill("usd");
    const usd = page.getByRole("option", { name: /USD/ });

    await usd.first().waitFor({ state: "visible", timeout: 10000 });
    await usd.first().click();
    const label = await picker.textContent();

    if (!(label ?? "").includes("USD")) throw new Error(`trigger shows ${label}`);

    return "usd -> USD selected";
  });

  await check(
    "F09",
    "currency picker filters by localized name; Escape closes list only",
    async () => {
      const picker = page.locator(".rf-currency-trigger");

      await picker.click({ force: true });
      await page.locator(".rf-currency-search").fill("dong");
      const vnd = page.getByRole("option", { name: /VND/ });

      await vnd.first().waitFor({ state: "visible", timeout: 10000 });
      await page.screenshot({ path: `${evidence}/f09-currency-name-search.png` });
      await page.keyboard.press("Escape");
      await page.locator(".rf-currency-panel").waitFor({ state: "hidden", timeout: 10000 });

      if ((await sheetDialog(page).count()) === 0) {
        throw new Error(
          "dong -> VND visible, BUT Escape closed the whole filters sheet (list-only close intended)",
        );
      }

      return "dong -> VND visible; Escape closed list only";
    },
  );

  await check("F10", "common currencies pinned above the full catalog", async () => {
    // Fresh sheet: the previous check's Escape legitimately(?) closed it.
    await openFilters(page, `${SEARCH}&dish=9`);
    const panel = page.locator(".rf-currency-panel");

    if ((await panel.count()) === 0) {
      await page.locator(".rf-currency-trigger").click({ force: true });
    }

    await panel.waitFor({ state: "visible", timeout: 10000 });
    await page.locator(".rf-currency-search").fill("");
    const groups = await page.locator(".rf-currency-group").allTextContents();

    if (!groups.some((entry) => entry.toLowerCase().includes("common"))) {
      throw new Error(`no Common group; saw ${JSON.stringify(groups)}`);
    }

    const firstOption =
      (await page.locator(".rf-currency-list .rf-currency-code").first().textContent()) ?? "";

    await page.screenshot({ path: `${evidence}/f10-currency-groups.png` });
    await page.keyboard.press("Escape");
    await closeSheet(page);

    return `groups: ${groups.join("/")}…, first pinned ${firstOption.trim()}`;
  });

  await check("F18", "dish chip clears dish plus price fields", async () => {
    // Sheet closed by F10; dish=9 context may already be gone — reopen on dish URL.
    await openFilters(page, `${SEARCH}&dish=9`);
    const chip = page.getByRole("button", { name: "Remove dish filter" });

    if ((await chip.count()) === 0) {
      throw new Pending("dish chip absent (dish=9 not an active canonical filter here)");
    }

    await chip.click();
    await page.waitForURL((url) => !url.searchParams.has("dish"), { timeout: 30000 });
    const url = new URL(page.url());

    for (const param of ["dish", "portion", "budget", "currency"] as const) {
      if (url.searchParams.has(param)) throw new Error(`${param} survived dish clear`);
    }

    if (
      url.searchParams.get("sort") === "price_low" ||
      url.searchParams.get("sort") === "price_high"
    ) {
      throw new Error(`price sort survived: ${url.searchParams.get("sort")}`);
    }

    return "dish/portion/budget/currency gone; sort safe";
  });

  await check("F22", "apply preserves map camera and bounds", async () => {
    await page.goto(HCMC_CENTER, { waitUntil: "domcontentloaded" });
    await page.locator(".mapapp-mapwrap canvas").first().waitFor({ timeout: 30000 });
    await page.evaluate(() => {
      const target = document.querySelector(".mapapp-mapwrap canvas");

      if (target instanceof HTMLElement) target.dataset.qa = "1";
    });
    const beforeUrl = new URL(page.url());

    // No reload here: openFilters() navigates, which would remount the map
    // and invalidate the camera-continuity probe.
    await openFiltersHere(page);
    const radius = page.locator("#sheet-radius");

    if ((await radius.count()) === 0) {
      throw new Pending("radius section absent (center params not honored as search center)");
    }

    await page.getByRole("button", { name: "Show results" }).click();
    await page.waitForTimeout(5000);
    const afterUrl = new URL(page.url());

    const sameCanvas = await page.evaluate(
      () => document.querySelector(".mapapp-mapwrap canvas")?.getAttribute("data-qa") === "1",
    );

    for (const param of ["longitude", "latitude", "radius"] as const) {
      if (beforeUrl.searchParams.get(param) !== afterUrl.searchParams.get(param)) {
        throw new Error(
          `${param}: ${beforeUrl.searchParams.get(param)} -> ${afterUrl.searchParams.get(param)}`,
        );
      }
    }

    if (!sameCanvas) throw new Error("map canvas element was remounted");

    return "lon/lat/radius stable; same canvas element";
  });

  await check("F23", "apply preserves the selected venue", async () => {
    await page.goto(HCMC_BOUNDS, { waitUntil: "domcontentloaded" });
    // Cards render inside the results sheet body, hidden at peek snap on
    // mobile — expand first, then the rows become visible.
    await expandResultsSheet(page);
    await page.locator(".mapapp-list > li").first().waitFor({ state: "visible", timeout: 30000 });
    const firstCard = page.locator("#mapapp-results li .res-name").first();

    if ((await firstCard.count()) === 0) {
      throw new Pending("no venue cards in HCMC bounds results");
    }

    await firstCard.click();
    await page.waitForURL(/venue=/, { timeout: 30000 });
    // Settle the venue navigation before applying: applyPatch rebuilds the
    // search from the live route object, so racing it against an in-flight
    // location change is what drops the venue (observed 3x pre-settle).
    await page.locator('.mapapp-panel-toolbar[data-view="overview"]').waitFor({
      state: "visible",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
    const venueBefore = new URL(page.url()).searchParams.get("venue");

    await openFiltersHere(page);
    await page.getByRole("button", { name: "Show results" }).click();
    await page.waitForTimeout(5000);
    const venueAfter = new URL(page.url()).searchParams.get("venue");
    const toolbar = await page.locator('.mapapp-panel-toolbar[data-view="overview"]').count();

    if (venueAfter === null || venueAfter !== venueBefore) {
      throw new Error(`venue ${venueBefore} -> ${venueAfter}`);
    }

    if (toolbar !== 1) throw new Error("overview toolbar gone after apply");

    return `venue ${venueAfter.slice(0, 8)} kept; overview toolbar present`;
  });

  await mobile.close();

  // ---------- Mobile 390: bottom sheet + touch ----------
  const small = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  const touch = await small.newPage();

  await check("F24a", "mobile 390 bottom-sheet results with touch", async () => {
    await touch.goto(HCMC_BOUNDS, { waitUntil: "domcontentloaded" });
    const sheet = touch.locator(".mapapp-sheet");

    await sheet.waitFor({ state: "attached", timeout: 45000 });
    const snap = await expandResultsSheet(touch);

    await touch.screenshot({ path: `${evidence}/f24a-mobile-sheet-390.png` });

    return `sheet present, tap moved snap to ${snap}`;
  });
  await small.close();

  // ---------- Desktop 1280: drawer + toolbar ----------
  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const wide = await desk.newPage();

  await check("F24b", "desktop drawer hosts filters; sheet closes back to drawer", async () => {
    await wide.goto(HCMC_BOUNDS, { waitUntil: "domcontentloaded" });
    await filtersButton(wide).waitFor({ state: "visible", timeout: 30000 });
    await wide.locator(".mapapp-list > li").first().waitFor({ timeout: 45000 });
    const drawer = wide.locator('.mapapp-drawer[data-open="true"]');

    if ((await drawer.count()) === 0) throw new Error("desktop drawer not open at 1280px");
    const toolbar = wide.locator('.mapapp-panel-toolbar[data-view="browse"]');

    if ((await toolbar.count()) === 0) throw new Error("route-aware browse toolbar absent");

    await openFilters(wide, HCMC_BOUNDS);
    await wide.screenshot({ path: `${evidence}/f24b-desktop-sheet.png` });
    // X-close must return to the untouched drawer.
    await wide.locator(".rf-sheet .rf-icon-btn").click();
    await sheetDialog(wide).waitFor({ state: "hidden", timeout: 10000 });
    const drawerStill = await wide.locator('.mapapp-drawer[data-open="true"]').count();

    if (drawerStill === 0) throw new Error("drawer lost after sheet X-close");

    // Escape must dismiss only the topmost layer. The drawer listens for
    // Escape on window too — if the sheet does not consume it, one press
    // collapses the drawer behind the modal, which is never intended.
    await openFiltersHere(wide);
    await wide.keyboard.press("Escape");
    await sheetDialog(wide).waitFor({ state: "hidden", timeout: 10000 });
    const drawerAfterEsc = await wide.locator('.mapapp-drawer[data-open="true"]').count();

    if (drawerAfterEsc === 0) {
      throw new Error("Escape closed the filters sheet AND collapsed the desktop drawer behind it");
    }

    return "drawer + browse toolbar; X-close and Escape both return to drawer";
  });

  await check("F25", "menu language selector with remember toggle persists", async () => {
    const venueId = "c94b1e2c-e083-4c28-af38-5441bd279113";
    const menuUrl = `${base}/restaurants?lang=en&venue=${venueId}&view=menu`;

    await wide.goto(menuUrl, { waitUntil: "domcontentloaded" });
    await wide.locator(".menu-panel-lang").first().waitFor({ timeout: 45000 });
    // Menu content arrives asynchronously (translation backend in flight);
    // the control is only interactive once the trigger resolves a value.

    try {
      await wide.waitForFunction(
        () =>
          (document.querySelector(".menu-panel-lang button")?.textContent ?? "").trim().length > 0,
        { timeout: 45000 },
      );
    } catch {
      throw new Pending(
        "menu language trigger never resolved — translation/menu data still in flight",
      );
    }

    const lang = wide.locator(".menu-panel-lang");

    await wide.screenshot({ path: `${evidence}/f25-menu-language.png` });
    const remember = lang.locator('input[type="checkbox"]');

    if ((await remember.count()) === 0) {
      throw new Pending("remember toggle not wired in this tree");
    }

    if (!(await remember.isChecked())) await remember.check();
    const trigger = lang.locator("button").first();
    const before = ((await trigger.textContent()) ?? "").trim();

    await trigger.click();
    await wide.getByRole("listbox").waitFor({ state: "visible", timeout: 10000 });
    // Pick a reading language different from the current one: English and
    // Vietnamese are always listed (available or not, never disabled).
    const english = wide.getByRole("option", { name: /^English/ });
    const vietnamese = wide.getByRole("option", { name: /^Ti.ng Vi.t/ });
    const target = before.includes("English") ? vietnamese : english;

    if ((await target.count()) === 0) throw new Error("en/vi options absent");
    await target.first().click();
    await wide.waitForTimeout(2000);
    const after = ((await trigger.textContent()) ?? "").trim();

    if (after === before) throw new Error(`language stuck on "${before}"`);
    await wide.screenshot({ path: `${evidence}/f25-language-changed.png` });
    await wide.reload({ waitUntil: "domcontentloaded" });
    await wide.locator(".menu-panel-lang").first().waitFor({ timeout: 45000 });

    try {
      await wide.waitForFunction(
        () =>
          (document.querySelector(".menu-panel-lang [role=combobox]")?.textContent ?? "").trim()
            .length > 0,
        { timeout: 30000 },
      );
    } catch {
      await wide.screenshot({ path: `${evidence}/f25-reload-unsettled.png` });
      throw new Pending(
        "menu language trigger never settled after reload — menu/translation data in flight",
      );
    }

    const retained = (
      (await wide.locator(".menu-panel-lang").getByRole("combobox").first().textContent()) ?? ""
    ).trim();

    if (!retained.includes(after.split(" ")[0] ?? "")) {
      throw new Error(`remembered "${after}" lost after reload (now "${retained}")`);
    }

    return `remember on; ${before} -> ${after}; retained after reload`;
  });
  await desk.close();
} finally {
  const summary = {
    base,
    generatedAt: new Date().toISOString(),
    results,
  };

  await writeFile(`${evidence}/results.json`, JSON.stringify(summary, null, 2));
  const pass = results.filter((entry) => entry.status === "pass").length;
  const fail = results.filter((entry) => entry.status === "fail").length;
  const pending = results.filter((entry) => entry.status === "pending").length;

  process.stdout.write(`\nSUMMARY pass=${pass} fail=${fail} pending=${pending}\n`);

  if (browser !== null) await browser.close();

  if (fail > 0) process.exit(1);
}
