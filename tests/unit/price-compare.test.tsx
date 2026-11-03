import { describe, expect, test } from "bun:test";

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  priceAvailability,
  PriceUnavailable,
} from "@/modules/restaurant-discovery/components/currency-tools";
import {
  DishPriceActions,
  dishPriceTargets,
} from "@/modules/restaurant-discovery/components/dish-price-actions";
import {
  PriceComparePanel,
  type PriceCompareRow,
} from "@/modules/restaurant-discovery/components/price-compare-panel";
import type { ExchangeRate } from "@/shared/money";

const rate = (base: string, quote: string, value: string): ExchangeRate => ({
  base,
  quote,
  rate: value,
  effectiveDate: "2026-10-28",
  provider: "test-fixture",
});

const renderWithRouter = async (node: ReactNode): Promise<string> => {
  const rootRoute = createRootRoute();

  const restaurantsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/restaurants",
    component: () => null,
  });

  const testRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => node,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([restaurantsRoute, testRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  await router.load();

  return renderToStaticMarkup(<RouterProvider router={router} />);
};

const row = (overrides: Partial<PriceCompareRow>): PriceCompareRow => ({
  venueId: "11111111-1111-4111-8111-111111111111",
  venueName: "Quán Phở Thật",
  area: "District 1",
  itemName: "Phở bò",
  variantName: "Regular",
  amount: "65000",
  currency: "VND",
  evidenceDate: "2026-10-24",
  stale: false,
  channelLabel: "Dine-in",
  sourceCategory: "menu_photo",
  rate: undefined,
  venueHref: "/restaurants/11111111-1111-4111-8111-111111111111",
  ...overrides,
});

describe("dish price entry targets", () => {
  test("compare deep-links into price sorting only with portion and currency", () => {
    const full = dishPriceTargets({
      dishId: "12",
      fromDish: "pho-bo",
      lang: "en",
      channel: "dine_in",
      portion: "regular",
      currency: "USD",
    });

    expect(full.compareSearch).toMatchObject({
      sort: "price_low",
      portion: "regular",
      currency: "USD",
    });

    const bare = dishPriceTargets({
      dishId: "12",
      fromDish: "pho-bo",
      lang: "en",
      channel: "dine_in",
    });

    expect("sort" in bare.compareSearch).toBe(false);
    expect(bare.compareSearch).toMatchObject({ dish: "12", fromDish: "pho-bo" });
  });

  test("renders compact Restaurants + Compare prices actions with icons", async () => {
    const html = await renderWithRouter(
      <DishPriceActions dishId="12" dishSlug="pho-bo" lang="en" portion="regular" currency="USD" />,
    );

    expect(html).toContain("Restaurants");
    expect(html).toContain("Compare prices");
    expect(html).toContain("price_low");
    expect(html).toContain("portion");
  });
});

describe("price availability", () => {
  test("unknown prices are unavailable, never zero-like", () => {
    expect(priceAvailability(null, "VND")).toBe("unavailable");
    expect(priceAvailability("65000", null)).toBe("unavailable");
    expect(priceAvailability("free", "VND")).toBe("unavailable");
    expect(priceAvailability("65000", "VND")).toBe("priced");
  });

  test("unavailable renders an explicit label, never ₫0/Free/From", () => {
    const html = renderToStaticMarkup(<PriceUnavailable />);

    expect(html).toContain("Price unavailable");
    expect(html).not.toContain("₫0");
    expect(html).not.toContain("Free");
    expect(html).not.toContain("From");
  });
});

describe("price comparison panel", () => {
  test("no priced rows render the empty state without cheapest claims", () => {
    const html = renderToStaticMarkup(
      <PriceComparePanel
        rows={[row({ amount: null, currency: null })]}
        sortMode="price_low"
        ratesAvailable
        locale="en"
      />,
    );

    expect(html).toContain("No comparable menu prices yet");
    expect(html).toContain("explore restaurants");
    expect(html).not.toContain("Lowest");
    expect(html).not.toContain("cheapest");
  });

  test("one price renders as-is with no cheapest claim", () => {
    const html = renderToStaticMarkup(
      <PriceComparePanel rows={[row({})]} sortMode="price_low" ratesAvailable locale="en" />,
    );

    expect(html).toContain("65,000");
    expect(html).not.toContain("Lowest comparable");
    expect(html).toContain("Only one comparable price");
  });

  test("rank badge needs a price sort and at least two comparable prices", () => {
    const two = [
      row({}),
      row({
        venueId: "22222222-2222-4222-8222-222222222222",
        venueName: "Quán Hai",
        amount: "80000",
      }),
    ];

    const ranked = renderToStaticMarkup(
      <PriceComparePanel rows={two} sortMode="price_low" ratesAvailable locale="en" />,
    );

    expect(ranked).toContain("Lowest comparable price");

    const unranked = renderToStaticMarkup(
      <PriceComparePanel rows={two} sortMode="recommended" ratesAvailable locale="en" />,
    );

    expect(unranked).not.toContain("Lowest comparable");
  });

  test("converted secondary renders only from a real rate with provenance", () => {
    const html = renderToStaticMarkup(
      <PriceComparePanel
        rows={[
          row({ rate: rate("VND", "USD", "0.00004") }),
          row({
            venueId: "22222222-2222-4222-8222-222222222222",
            venueName: "Quán Hai",
            amount: "80000",
          }),
        ]}
        sortMode="price_low"
        ratesAvailable
        locale="en"
      />,
    );

    expect(html).toContain("≈");
    expect(html).toContain("2026-10-28");
    expect(html).toContain("2026-10-24");
  });

  test("FX outage keeps original prices with an explicit note", () => {
    const html = renderToStaticMarkup(
      <PriceComparePanel
        rows={[
          row({}),
          row({
            venueId: "22222222-2222-4222-8222-222222222222",
            venueName: "Quán Hai",
            amount: "80000",
          }),
        ]}
        sortMode="price_low"
        ratesAvailable={false}
        locale="en"
      />,
    );

    expect(html).toContain("conversions are unavailable");
    expect(html).toContain("65,000");
    expect(html).not.toContain("≈");
  });
});
