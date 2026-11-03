import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { ObservedPrice } from "@/modules/restaurant-discovery/components/currency-tools";
import { normalizedMapBounds } from "@/modules/restaurant-discovery/map-bounds";

describe("observed price SSR", () => {
  test("keeps the original primary and places an approximate italic conversion below it", () => {
    const html = renderToStaticMarkup(
      <ObservedPrice
        amount="55000"
        currency="VND"
        locale="vi-VN"
        rate={{
          base: "VND",
          quote: "USD",
          rate: "0.00004",
          effectiveDate: "2026-10-28",
          provider: "synthetic-test-provider",
        }}
      />,
    );

    expect(html).toContain("55.000");
    expect(html).toContain("VND");
    expect(html).toContain("≈");
    expect(html).toContain("italic");
    expect(html).toContain("USD");
    expect(html).toContain("2026-10-28");
    expect(html.indexOf("55.000")).toBeLessThan(html.indexOf("≈"));
  });
  test("missing FX and same-currency display contain only the original price", () => {
    const unavailable = renderToStaticMarkup(
      <ObservedPrice amount="55000" currency="VND" locale="en" />,
    );

    const same = renderToStaticMarkup(
      <ObservedPrice
        amount="55000"
        currency="VND"
        locale="en"
        rate={{
          base: "VND",
          quote: "VND",
          rate: "1",
          effectiveDate: "2026-10-28",
          provider: "synthetic-test-provider",
        }}
      />,
    );

    expect(unavailable).not.toContain("≈");
    expect(same).not.toContain("≈");
    expect(unavailable).toContain("55,000");
    expect(same).toContain("55,000");
  });
});

describe("map viewport normalization", () => {
  test("wrapped coordinates preserve antimeridian semantics", () => {
    expect(normalizedMapBounds(170, -10, 190, 10)).toEqual({
      west: 170,
      south: -10,
      east: -170,
      north: 10,
    });
    expect(normalizedMapBounds(181, -10, 191, 10)).toEqual({
      west: -179,
      south: -10,
      east: -169,
      north: 10,
    });
    expect(normalizedMapBounds(-200, -95, 200, 95)).toEqual({
      west: -180,
      south: -90,
      east: 180,
      north: 90,
    });
  });
});
