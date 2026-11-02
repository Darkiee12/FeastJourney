import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { restaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import { ResultsDrawer } from "@/modules/restaurant-discovery/components/results-drawer";
import {
  ResultsSheet,
  sheetSnapHeight,
  snapForRatio,
} from "@/modules/restaurant-discovery/components/results-sheet";

const copy = restaurantCopy("en");
const noop = () => {};

const sheet = (snap: 0 | 1 | 2) =>
  renderToStaticMarkup(
    <ResultsSheet
      copy={copy}
      snap={snap}
      onSnapChange={noop}
      title="Restaurants"
      summary="2 places"
    >
      <p>result list</p>
    </ResultsSheet>,
  );

const drawer = (open: boolean) =>
  renderToStaticMarkup(
    <ResultsDrawer copy={copy} open={open} onToggle={noop} title="Restaurants">
      <p>result list</p>
    </ResultsDrawer>,
  );

describe("snapForRatio", () => {
  test("drag ratios below 0.27 settle on peek", () => {
    expect(snapForRatio(-0.5)).toBe(0);
    expect(snapForRatio(0)).toBe(0);
    expect(snapForRatio(0.269)).toBe(0);
  });

  test("ratios from 0.27 settle on half", () => {
    expect(snapForRatio(0.27)).toBe(1);
    expect(snapForRatio(0.45)).toBe(1);
    expect(snapForRatio(0.659)).toBe(1);
  });

  test("ratios from 0.66 settle on full", () => {
    expect(snapForRatio(0.66)).toBe(2);
    expect(snapForRatio(0.88)).toBe(2);
    expect(snapForRatio(1.5)).toBe(2);
  });
});

describe("sheetSnapHeight", () => {
  test("keeps the 128px / 45% / 88% contract", () => {
    expect(sheetSnapHeight(0)).toBe("128px");
    expect(sheetSnapHeight(1)).toBe("45%");
    expect(sheetSnapHeight(2)).toBe("88%");
  });
});

describe("ResultsSheet collapse states", () => {
  test("peek hides the body and marks only the peek button pressed", () => {
    const html = sheet(0);

    expect(html).toContain('data-snap="0"');
    expect(html).toContain("mapapp-sheet-body");
    expect(html).toContain(" hidden=");
    expect(html).toContain(copy.sheetPeek);
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
  });

  test("half exposes the body with independent scroll region intact", () => {
    const html = sheet(1);

    expect(html).toContain('data-snap="1"');
    expect(html).not.toContain(" hidden=");
    expect(html).toContain("result list");
    expect(html).toContain(copy.sheetHalf);
  });

  test("all three snap buttons stay keyboard-reachable with pressed state", () => {
    const html = sheet(2);

    expect(html).toContain(copy.sheetPeek);
    expect(html).toContain(copy.sheetHalf);
    expect(html).toContain(copy.sheetFull);
    expect(html.match(/<button/g) ?? []).toHaveLength(3);
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
  });
});

describe("ResultsDrawer collapse states", () => {
  test("open panel is labelled, focusable heading, not inert", () => {
    const html = drawer(true);

    expect(html).toContain('data-open="true"');
    expect(html).not.toContain("inert");
    expect(html).toContain('aria-hidden="false"');
    expect(html).toContain("result list");
    expect(html).toContain(copy.collapseDrawer);
  });

  test("collapse keeps the panel mounted (transform-only) but inert and hidden", () => {
    const html = drawer(false);

    // Transform-only collapse: content stays mounted so the map never
    // remounts, while inert + aria-hidden remove it from keyboard/AT order.
    expect(html).toContain('data-open="false"');
    expect(html).toContain("inert");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("result list");
    expect(html).toContain(copy.expandDrawer);
    expect(html).toContain("mapapp-drawer-fab");
  });
});
