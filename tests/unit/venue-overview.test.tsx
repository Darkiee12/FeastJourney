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

import { MenuHighlights } from "@/modules/restaurant-discovery/components/menu-highlights";
import { restaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import { VenueActionBar } from "@/modules/restaurant-discovery/components/venue-action-bar";
import {
  VenueOverview,
  type VenueOverviewIdentity,
} from "@/modules/restaurant-discovery/components/venue-overview";
import type { MenuHighlight } from "@/modules/restaurant-discovery/menu-presentation";
import type { MenuOffering } from "@/modules/restaurant-discovery/server/operations/discovery";

const venueId = "11111111-1111-4111-8111-111111111111";

const offering = (overrides: Partial<MenuOffering>): MenuOffering => ({
  menu_id: "44444444-4444-4444-8444-444444444444",
  menu_name: "Main",
  source_language: "vi",
  translation_language: "en",
  translated_name: "Beef noodle soup",
  translated_description: null,
  explanatory_summary: null,
  item_id: "22222222-2222-4222-8222-222222222222",
  item_name: "Phở bò",
  description: "",
  variant_id: "33333333-3333-4333-8333-333333333333",
  variant_name: "Regular",
  variant_translation_language: "en",
  variant_translated_label: "Regular bowl",
  comparison_key: "regular",
  observation_id: "55555555-5555-4555-8555-555555555555",
  amount: "65000",
  raw_price_text: "65.000đ",
  currency: "VND",
  price_kind: "listed",
  sales_channel: "dine_in",
  tax_treatment: "included",
  observed_at: "2026-10-01T00:00:00.000Z",
  current_enough: true,
  source_category: "menu_photo",
  source_url: null,
  dish_id: null,
  match_kind: null,
  ...overrides,
});

const highlight = (overrides: Partial<MenuHighlight>): MenuHighlight => ({
  id: "22222222-2222-4222-8222-222222222222",
  name: "Phở bò",
  dishId: null,
  variantCount: 1,
  ...overrides,
});

const venue: VenueOverviewIdentity = {
  id: venueId,
  name: "Quán Phở Thật",
  businessName: null,
  area: "District 1",
  address: "12 Real Street",
  latitude: 10.7769,
  longitude: 106.7009,
  distanceKm: "1.2",
};

const renderWithRouter = async (node: ReactNode): Promise<string> => {
  const rootRoute = createRootRoute();

  const scanRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/scan",
    component: () => null,
  });

  const testRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => node,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([scanRoute, testRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  await router.load();

  return renderToStaticMarkup(<RouterProvider router={router} />);
};

const overviewNode = (extra: Partial<Parameters<typeof VenueOverview>[0]> = {}): ReactNode => (
  <VenueOverview
    copy={restaurantCopy("en")}
    highlights={[]}
    lang="en"
    locale="en"
    offerings={[]}
    onOpenMenuItem={() => {}}
    onShowMenu={() => {}}
    onShowReviews={() => {}}
    photos={[]}
    reviewSummary={null}
    venue={venue}
    {...extra}
  />
);

describe("menu highlights", () => {
  test("caps the row at three cards", async () => {
    const highlights = ["a", "b", "c", "d", "e"].map((suffix, index) =>
      highlight({ id: `${index}0000000-0000-4000-8000-000000000000`, name: `Dish ${suffix}` }),
    );

    const html = await renderWithRouter(
      <MenuHighlights
        highlights={highlights}
        lang="en"
        locale="en"
        offerings={[]}
        onOpenMenuItem={() => {}}
        priceUnknown="Price unavailable"
        venueId={venueId}
      />,
    );

    expect(html.split("venue-highlight-card").length - 1).toBe(3);
    expect(html).toContain("Dish a");
    expect(html).not.toContain("Dish d");
  });

  test("empty menu renders an honest empty state with a scan action", async () => {
    const html = await renderWithRouter(
      <MenuHighlights
        highlights={[]}
        lang="en"
        locale="en"
        offerings={[]}
        onOpenMenuItem={() => {}}
        priceUnknown="Price unavailable"
        venueId={venueId}
      />,
    );

    expect(html).toContain("No reviewed menu available yet");
    expect(html).toContain(`/scan?lang=en&amp;venueId=${venueId}`);
  });

  test("shows the real listed price when known", async () => {
    const itemId = "22222222-2222-4222-8222-222222222222";

    const html = await renderWithRouter(
      <MenuHighlights
        highlights={[highlight({ id: itemId })]}
        lang="en"
        locale="en"
        offerings={[offering({ item_id: itemId })]}
        onOpenMenuItem={() => {}}
        priceUnknown="Price unavailable"
        venueId={venueId}
      />,
    );

    expect(html).toContain("Phở bò");
    expect(html).toContain("65,000");
    expect(html).toContain("VND");
    expect(html).not.toContain("Price unavailable");
  });

  test("never promotes receipt-paid or unknown prices to menu prices", async () => {
    const paidId = "33333333-3333-4333-8333-333333333333";
    const unknownId = "44444444-4444-4444-8444-444444444444";

    const html = await renderWithRouter(
      <MenuHighlights
        highlights={[
          highlight({ id: paidId, name: "Paid dish" }),
          highlight({ id: unknownId, name: "Unknown dish" }),
        ]}
        lang="en"
        locale="en"
        offerings={[
          offering({ item_id: paidId, price_kind: "paid_unit", amount: "99000" }),
          offering({ item_id: unknownId, observation_id: null, amount: null, currency: null }),
        ]}
        onOpenMenuItem={() => {}}
        priceUnknown="Price unavailable"
        venueId={venueId}
      />,
    );

    expect(html).not.toContain("99,000");
    expect(html).not.toContain("99000");
    expect(html.split("Price unavailable").length - 1).toBe(2);
  });
});

describe("venue overview", () => {
  test("renders identity, area, address, and distance", async () => {
    const html = await renderWithRouter(overviewNode());

    expect(html).toContain("Quán Phở Thật");
    expect(html).toContain("District 1");
    expect(html).toContain("12 Real Street");
    expect(html).toContain("1.2 km away");
  });

  test("omits the rating row without a genuine summary", async () => {
    const missing = await renderWithRouter(overviewNode({ reviewSummary: null }));

    const zero = await renderWithRouter(overviewNode({ reviewSummary: { total: 0, average: 0 } }));

    expect(missing).not.toContain("venue-rating");
    expect(zero).not.toContain("venue-rating");
  });

  test("shows the genuine rating summary when available", async () => {
    const html = await renderWithRouter(
      overviewNode({ reviewSummary: { total: 4, average: 4.5 } }),
    );

    expect(html).toContain("venue-rating");
    expect(html).toContain("4.5");
    expect(html).toContain("(4)");
  });

  test("directions use the real venue coordinates", async () => {
    const html = await renderWithRouter(overviewNode());

    expect(html).toContain("destination=10.7769,106.7009");
  });
});

describe("venue action bar", () => {
  test("offers menu, reviews, scan, and directions with icon plus text label", async () => {
    const html = await renderWithRouter(
      <VenueActionBar
        lang="en"
        venueId={venueId}
        directionsHref="https://www.google.com/maps/dir/?api=1&destination=10.7769,106.7009"
        onShowMenu={() => {}}
        onShowReviews={() => {}}
      />,
    );

    expect(html).toContain("View menu");
    expect(html).toContain("Reviews");
    expect(html).toContain("Scan a menu");
    expect(html).toContain("Get directions");
    expect(html).toContain(`/scan?lang=en&amp;venueId=${venueId}`);
    expect(html).toContain("destination=10.7769,106.7009");
    expect(html).not.toContain("Use this restaurant");
  });
});
