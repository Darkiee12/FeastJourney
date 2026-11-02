import { describe, expect, test } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  isPinSelected,
  RESTAURANT_PIN_CUTOUT,
  RESTAURANT_PIN_FILL,
  RESTAURANT_PIN_GLYPH_PX,
  RESTAURANT_PIN_REST_PX,
  RESTAURANT_PIN_SELECTED_PX,
  restaurantPinClassName,
  restaurantPinLabel,
  RestaurantPinButton,
} from "@/modules/restaurant-discovery/components/restaurant-pins";
import { normalizedMapBounds } from "@/modules/restaurant-discovery/map-bounds";

const readSource = async (path: string): Promise<string> => Bun.file(path).text();

describe("restaurant pin selection logic", () => {
  test("selects only the matching venue id", () => {
    expect(isPinSelected("venue-1", "venue-1")).toBe(true);
    expect(isPinSelected("venue-2", "venue-1")).toBe(false);
  });

  test("nothing is selected without a selection", () => {
    expect(isPinSelected("venue-1", null)).toBe(false);
  });

  test("selected pin carries a distinct class", () => {
    expect(restaurantPinClassName(true)).toBe("restaurant-pin is-selected");
    expect(restaurantPinClassName(false)).toBe("restaurant-pin");
  });

  test("pin label names the venue for assistive tech", () => {
    expect(restaurantPinLabel("Pho Hoa")).toBe("Show Pho Hoa");
  });
});

describe("restaurant pin visual contract", () => {
  test("brand red fill with white stroke and cutout", () => {
    expect(RESTAURANT_PIN_FILL).toBe("#E53935");
    expect(RESTAURANT_PIN_CUTOUT).toBe("#FFFFFF");
  });

  test("rest glyph ~30px, selected glyph ~38px", () => {
    expect(RESTAURANT_PIN_GLYPH_PX).toBe(38);
    expect(RESTAURANT_PIN_REST_PX).toBe(30);
    expect(RESTAURANT_PIN_SELECTED_PX).toBe(38);
  });

  test("pin renders as a labelled button with pressed state, never a rank badge", () => {
    const selected = renderToStaticMarkup(
      createElement(RestaurantPinButton, {
        name: "Pho Hoa",
        selected: true,
        onSelect: () => undefined,
      }),
    );

    const rest = renderToStaticMarkup(
      createElement(RestaurantPinButton, {
        name: "Pho Hoa",
        selected: false,
        onSelect: () => undefined,
      }),
    );

    for (const markup of [selected, rest]) {
      expect(markup).toContain('type="button"');
      expect(markup).toContain('aria-label="Show Pho Hoa"');
      expect(markup).toContain(RESTAURANT_PIN_FILL);
      expect(markup).not.toContain("<text");
    }

    expect(selected).toContain('aria-pressed="true"');
    expect(selected).toContain("is-selected");
    expect(rest).toContain('aria-pressed="false"');
    expect(rest).not.toContain("is-selected");
  });
});

describe("map bounds normalization reuse", () => {
  test("passes through a city viewport unchanged", () => {
    const bounds = normalizedMapBounds(106.4, 10.4, 107.0, 11.1);

    expect(bounds.west).toBeCloseTo(106.4, 10);
    expect(bounds.south).toBe(10.4);
    expect(bounds.east).toBeCloseTo(107.0, 10);
    expect(bounds.north).toBe(11.1);
  });

  test("unwraps antimeridian-spanning bounds", () => {
    expect(normalizedMapBounds(170, -10, 190, 10)).toEqual({
      west: 170,
      south: -10,
      east: -170,
      north: 10,
    });
  });

  test("clamps latitude to valid range", () => {
    expect(normalizedMapBounds(0, -100, 10, 100)).toEqual({
      west: 0,
      south: -90,
      east: 10,
      north: 90,
    });
  });

  test("collapses a full-world span to the whole longitude range", () => {
    expect(normalizedMapBounds(-200, -10, 200, 10)).toEqual({
      west: -180,
      south: -10,
      east: 180,
      north: 10,
    });
  });
});

describe("map module contracts (static guards)", () => {
  test("UserPosition is defined once in location-storage and reused by the map", async () => {
    const storage = await readSource("src/modules/restaurant-discovery/location-storage.ts");

    const map = await readSource("src/modules/restaurant-discovery/components/restaurant-map.tsx");

    expect(storage).toContain("export interface UserPosition");

    expect(storage).toContain("export interface UserPosition");
    expect(map).not.toMatch(/(export\s+)?interface UserPosition/);
    expect(map).toContain("type UserPosition");
    expect(map).toContain("location-storage");
  });

  test("map reuses shared bounds normalization and pin components", async () => {
    const map = await readSource("src/modules/restaurant-discovery/components/restaurant-map.tsx");

    expect(map).toContain("normalizedMapBounds");
    expect(map).toContain("RestaurantPinButton");
    expect(map).toContain("isPinSelected");
  });

  test("area-search affordance stays gated on real user gestures", async () => {
    const map = await readSource("src/modules/restaurant-discovery/components/restaurant-map.tsx");

    expect(map).toContain("event.originalEvent === undefined");
  });

  test("panel never remounts the map with a key prop", async () => {
    const panel = await readSource(
      "src/modules/restaurant-discovery/components/restaurant-map-panel.tsx",
    );

    expect(panel).not.toContain("key={");
  });
});
