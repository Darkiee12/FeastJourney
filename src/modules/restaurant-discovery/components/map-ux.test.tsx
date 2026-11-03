import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { RestaurantCardSkeleton } from "@/modules/restaurant-discovery/components/restaurant-card";
import { restaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import {
  formatSheetSummary,
  nextSheetSnap,
  resolveResultsState,
  sheetHandleAction,
  sheetSnapForKey,
  shouldSuppressSheetTap,
  snapForRatio,
} from "@/modules/restaurant-discovery/components/results-sheet";
import { VenueOverviewSkeleton } from "@/modules/restaurant-discovery/components/venue-overview";

const readSource = async (path: string): Promise<string> => Bun.file(path).text();
const copy = restaurantCopy("en");

describe("resolveResultsState", () => {
  test("results beat every empty condition, even while navigating", () => {
    expect(
      resolveResultsState({
        rows: 3,
        isDishMode: true,
        datasetEmpty: false,
        hasScope: true,
        hasArea: true,
        isLoading: true,
      }),
    ).toBeNull();
  });

  test("loading is its own state, never a fake count", () => {
    expect(
      resolveResultsState({
        rows: 0,
        isDishMode: false,
        datasetEmpty: false,
        hasScope: true,
        hasArea: true,
        isLoading: true,
      }),
    ).toBe("loading");
  });

  test("an empty catalog beats the dish filter", () => {
    expect(
      resolveResultsState({
        rows: 0,
        isDishMode: true,
        datasetEmpty: true,
        hasScope: false,
        hasArea: false,
        isLoading: false,
      }),
    ).toBe("empty-catalog");
  });

  test("dish mode with catalog elsewhere is no-evidence, not no-area", () => {
    expect(
      resolveResultsState({
        rows: 0,
        isDishMode: true,
        datasetEmpty: false,
        hasScope: true,
        hasArea: true,
        isLoading: false,
      }),
    ).toBe("no-evidence");
  });

  test("no browsing scope yet is no-scope", () => {
    expect(
      resolveResultsState({
        rows: 0,
        isDishMode: false,
        datasetEmpty: false,
        hasScope: false,
        hasArea: false,
        isLoading: false,
      }),
    ).toBe("no-scope");
  });

  test("scoped region without mapped places is no-area", () => {
    expect(
      resolveResultsState({
        rows: 0,
        isDishMode: false,
        datasetEmpty: false,
        hasScope: true,
        hasArea: false,
        isLoading: false,
      }),
    ).toBe("no-area");
  });

  test("scoped region with places but zero hits is no-match", () => {
    expect(
      resolveResultsState({
        rows: 0,
        isDishMode: false,
        datasetEmpty: false,
        hasScope: true,
        hasArea: true,
        isLoading: false,
      }),
    ).toBe("no-match");
  });
});

describe("empty peek honesty", () => {
  test("verified counts render verbatim; capped notes stay attached", () => {
    expect(formatSheetSummary("5 places", null)).toBe("5 places");
    expect(formatSheetSummary("20 places", "First 20 shown — zoom in.")).toBe(
      "20 places · First 20 shown — zoom in.",
    );
  });

  test("empty sheet uses state titles, never a dominating zero count", async () => {
    const page = await readSource(
      "src/modules/restaurant-discovery/components/restaurant-search-page.tsx",
    );

    expect(page).toContain("emptyKind === null");
    expect(page).toContain("emptyPeekLabel(emptyKind, copy)");
    expect(page).not.toContain('"0 places"');
  });

  test("sheet and drawer expose the resolved state for styling and tests", async () => {
    const sheet = await readSource("src/modules/restaurant-discovery/components/results-sheet.tsx");

    const drawer = await readSource(
      "src/modules/restaurant-discovery/components/results-drawer.tsx",
    );

    const page = await readSource(
      "src/modules/restaurant-discovery/components/restaurant-search-page.tsx",
    );

    expect(sheet).toContain("data-state={state ?? undefined}");
    expect(drawer).toContain("data-state={state ?? undefined}");
    expect(page).toContain("state={emptyKind}");
  });
});

describe("loading skeletons (no fake progress)", () => {
  test("venue skeleton is labelled, busy, and invents nothing", () => {
    const html = renderToStaticMarkup(
      <VenueOverviewSkeleton
        label="Loading restaurant details"
        hint="Fetching the reviewed menu and photos…"
      />,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading restaurant details");
    expect(html).toContain("mapapp-skel-line");
    expect(html).not.toContain("%");
  });

  test("card skeleton carries layout only, no price semantics", () => {
    const html = renderToStaticMarkup(<RestaurantCardSkeleton />);

    expect(html).toContain("mapapp-skel");
    expect(html).not.toContain("ObservedPrice");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("</a>");
  });

  test("search page skeleton has no timers or percentages", async () => {
    const page = await readSource(
      "src/modules/restaurant-discovery/components/restaurant-search-page.tsx",
    );

    expect(page).toContain("SearchResultsSkeleton");
    expect(page).toContain('aria-busy="true"');
    expect(page).toContain("VenueOverviewSkeleton");
    expect(page).not.toContain("setTimeout");
    expect(page).not.toContain("setInterval");
  });

  test("sheet snap, keyboard, and drag contracts are unchanged", () => {
    expect(nextSheetSnap(0)).toBe(1);
    expect(nextSheetSnap(1)).toBe(2);
    expect(nextSheetSnap(2)).toBe(0);
    expect(snapForRatio(0.269)).toBe(0);
    expect(snapForRatio(0.66)).toBe(2);
    expect(sheetSnapForKey("Escape", 2)).toBe(0);
    expect(shouldSuppressSheetTap(400, 409)).toBe(true);
    expect(sheetHandleAction(0, copy)).toBe(copy.sheetExpand);
  });
});

describe("warm basemap contract (static guards)", () => {
  test("warming is decorative paint, never a replaced implementation", async () => {
    const map = await readSource("src/modules/restaurant-discovery/components/restaurant-map.tsx");

    expect(map).toContain("WARM_BASEMAP");
    expect(map).toContain("warmLayerPaint");
    expect(map).toContain("applyWarmBasemap");
    expect(map).toContain("setPaintProperty");
    expect(map).toContain("mapStyle={style.data}");
    expect(map).toContain("VITE_MAP_STYLE_URL");
    expect(map).not.toContain("tile.openstreetmap.org");
  });

  test("palette covers land, water, parks, roads, and label halos", async () => {
    const map = await readSource("src/modules/restaurant-discovery/components/restaurant-map.tsx");

    expect(map).toContain("#FAF6EC");
    expect(map).toContain("#BFDDF0");
    expect(map).toContain("#D8EACD");
    expect(map).toContain("#EFCF96");
    expect(map).toContain("text-halo-color");
  });

  test("pins stay red, attribution stays, gestures stay touch-friendly", async () => {
    const map = await readSource("src/modules/restaurant-discovery/components/restaurant-map.tsx");

    const pins = await readSource(
      "src/modules/restaurant-discovery/components/restaurant-pins.tsx",
    );

    expect(pins).toContain("#E53935");
    expect(map).toContain("RestaurantPinButton");
    expect(map).toContain("attributionControl");
    expect(map).not.toMatch(/cooperativeGestures\s*=\s*\{?\s*true/);
    expect(map).toContain("NavigationControl");
    expect(map).toContain("event.originalEvent === undefined");
  });

  test("map overlay distinguishes titles without hiding the map", async () => {
    const map = await readSource("src/modules/restaurant-discovery/components/restaurant-map.tsx");

    expect(map).toContain("emptyTitle");
    expect(map).toContain("discovery-map-empty-title");
  });
});

describe("search intent preserved (static guards)", () => {
  test("single compact bar plus chips; pan never resets the dish", async () => {
    const page = await readSource(
      "src/modules/restaurant-discovery/components/restaurant-search-page.tsx",
    );

    expect(page).toContain("MapSearchBar");
    expect(page).toContain("FilterChips");
    expect(page).toContain("onBounds={setProposedBounds}");
    expect(page).toContain("...search,");
    expect(page).toContain("...proposedBounds,");
  });

  test("canonical dish identity travels with every navigation", async () => {
    const page = await readSource(
      "src/modules/restaurant-discovery/components/restaurant-search-page.tsx",
    );

    expect(page).toContain("fromDish");
    expect(page).toContain("dish: pick.id");
  });

  test("empty areas offer Choose-city before Explore-wider", async () => {
    const page = await readSource(
      "src/modules/restaurant-discovery/components/restaurant-search-page.tsx",
    );

    expect(page).toContain("setChooserManual(true)");
    expect(page).toContain("copy.regionChoose");
    expect(page).toContain("copy.expandArea");
  });

  test("filters sheet removes the dish without touching price math", async () => {
    const sheet = await readSource(
      "src/modules/restaurant-discovery/components/restaurant-filters-sheet.tsx",
    );

    // Compact dish chip (name + ×) clears only the dish-scoped filters.
    expect(sheet).toContain("copy.clearDish");
    expect(sheet).toContain("dish: undefined");
    expect(sheet).toContain("clearDishPatch");
    // Backend restriction stays out of the sheet chrome: no repeated
    // "reviewed evidence" paragraph next to the chip.
    expect(sheet).not.toContain("copy.dishEvidence");
  });
});
