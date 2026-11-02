import { describe, expect, test } from "bun:test";

import { restaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import {
  formatSheetSummary,
  nextSheetSnap,
  sheetHandleAction,
  sheetSnapForKey,
  shouldSuppressSheetTap,
  snapForRatio,
} from "@/modules/restaurant-discovery/components/results-sheet";

const readSource = async (path: string): Promise<string> => Bun.file(path).text();
const copy = restaurantCopy("en");

describe("nextSheetSnap", () => {
  test("tap cycles forward through all three snaps", () => {
    expect(nextSheetSnap(0)).toBe(1);
    expect(nextSheetSnap(1)).toBe(2);
    expect(nextSheetSnap(2)).toBe(0);
  });
});

describe("sheetSnapForKey", () => {
  test("arrows step one snap and clamp at the ends", () => {
    expect(sheetSnapForKey("ArrowUp", 0)).toBe(1);
    expect(sheetSnapForKey("ArrowUp", 1)).toBe(2);
    expect(sheetSnapForKey("ArrowUp", 2)).toBe(2);
    expect(sheetSnapForKey("ArrowDown", 2)).toBe(1);
    expect(sheetSnapForKey("ArrowDown", 1)).toBe(0);
    expect(sheetSnapForKey("ArrowDown", 0)).toBe(0);
  });

  test("Home, End, and Escape jump directly", () => {
    expect(sheetSnapForKey("Home", 2)).toBe(0);
    expect(sheetSnapForKey("End", 0)).toBe(2);
    expect(sheetSnapForKey("Escape", 2)).toBe(0);
  });

  test("unhandled keys return null", () => {
    expect(sheetSnapForKey("Enter", 0)).toBeNull();
    expect(sheetSnapForKey("a", 1)).toBeNull();
  });
});

describe("formatSheetSummary", () => {
  test("renders the verified count verbatim", () => {
    expect(formatSheetSummary("5 places", null)).toBe("5 places");
    expect(formatSheetSummary("1 place", "")).toBe("1 place");
  });

  test("appends the capped note instead of hiding the limit", () => {
    expect(formatSheetSummary("20 places", "First 20 shown — zoom in.")).toBe(
      "20 places · First 20 shown — zoom in.",
    );
  });
});

describe("shouldSuppressSheetTap", () => {
  test("a tap barely moves, so the click may toggle", () => {
    expect(shouldSuppressSheetTap(400, 400)).toBe(false);
    expect(shouldSuppressSheetTap(400, 407)).toBe(false);
  });

  test("a drag moves past the threshold, so the click is swallowed", () => {
    expect(shouldSuppressSheetTap(400, 409)).toBe(true);
    expect(shouldSuppressSheetTap(400, 200)).toBe(true);
  });
});

describe("sheetHandleAction", () => {
  test("every snap state names its action from existing copy", () => {
    expect(sheetHandleAction(0, copy)).toBe(copy.sheetExpand);
    expect(sheetHandleAction(1, copy)).toBe(copy.sheetFullList);
    expect(sheetHandleAction(2, copy)).toBe(copy.sheetCollapse);
  });
});

describe("snap thresholds (drag release contract)", () => {
  test("ratios below 0.27 settle on peek", () => {
    expect(snapForRatio(0)).toBe(0);
    expect(snapForRatio(0.269)).toBe(0);
  });

  test("ratios from 0.27 settle on half, from 0.66 on full", () => {
    expect(snapForRatio(0.27)).toBe(1);
    expect(snapForRatio(0.659)).toBe(1);
    expect(snapForRatio(0.66)).toBe(2);
  });
});

describe("sheet single-handle contract (static guards)", () => {
  test("no nested snap buttons: the handle is the only button", async () => {
    const sheet = await readSource("src/modules/restaurant-discovery/components/results-sheet.tsx");

    expect(sheet.match(/<button/g) ?? []).toHaveLength(1);
    expect(sheet).not.toContain("mapapp-sheet-snapbtn");
    expect(sheet).not.toContain('closest("button")');
  });

  test("three snaps, drag physics, keyboard, and reduced motion are kept", async () => {
    const sheet = await readSource("src/modules/restaurant-discovery/components/results-sheet.tsx");
    const css = await readSource("src/modules/restaurant-discovery/components/mapapp.css");

    expect(sheet).toContain("snapForRatio");
    expect(sheet).toContain("sheetSnapHeight");
    expect(sheet).toContain("aria-expanded");
    expect(sheet).toContain("aria-controls");
    expect(sheet).toContain("Escape");
    expect(css).toContain(".mapapp-sheet-chevron");
    expect(css).toContain("prefers-reduced-motion");
  });
});

describe("map one-finger pan contract (static guards)", () => {
  test("cooperativeGestures stays off for the fullscreen map", async () => {
    const map = await readSource("src/modules/restaurant-discovery/components/restaurant-map.tsx");

    expect(map).not.toMatch(/^\s*cooperativeGestures\s*$/m);
  });

  test("marker sync, selection framing, and camera contracts are kept", async () => {
    const map = await readSource("src/modules/restaurant-discovery/components/restaurant-map.tsx");

    expect(map).toContain("RestaurantPinButton");
    expect(map).toContain("selectionPadding");
    expect(map).toContain("event.originalEvent === undefined");
    expect(map).toContain("onCamera");
  });
});

describe("recenter control contract (static guards)", () => {
  test("Crosshair icon with accessible name; no floating accuracy pill", async () => {
    const page = await readSource(
      "src/modules/restaurant-discovery/components/restaurant-search-page.tsx",
    );

    expect(page).toContain("Crosshair");
    expect(page).not.toContain("mapapp-accuracy");
    expect(page).not.toContain("mapapp-recenter-dot");
    expect(page).toContain("mapapp-recenter-desc");
  });
});
