import { describe, expect, test } from "bun:test";

import {
  browsePanel,
  menuPanel,
  overviewPanel,
  panelForRoute,
  reviewsPanel,
} from "@/modules/restaurant-discovery/panel-state";
import {
  restaurantSearchSchema,
  restaurantVenueViewSchema,
} from "@/modules/restaurant-discovery/restaurant.schema";

const VENUE = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";

describe("canonical restaurant panel URL state", () => {
  test("browse is the default with no venue", () => {
    const parsed = restaurantVenueViewSchema.parse({});

    expect(parsed.view).toBe("browse");
    expect(parsed.venue).toBeUndefined();
    expect(panelForRoute(parsed)).toEqual(browsePanel);
  });

  test("venue views derive the matching panel", () => {
    expect(
      panelForRoute(restaurantVenueViewSchema.parse({ venue: VENUE, view: "overview" })),
    ).toEqual(overviewPanel(VENUE));
    expect(panelForRoute(restaurantVenueViewSchema.parse({ venue: VENUE, view: "menu" }))).toEqual(
      menuPanel(VENUE),
    );
    expect(
      panelForRoute(restaurantVenueViewSchema.parse({ venue: VENUE, view: "reviews" })),
    ).toEqual(reviewsPanel(VENUE));
  });

  test("menu item focus requires the menu panel and a venue", () => {
    const parsed = restaurantVenueViewSchema.parse({ venue: VENUE, view: "menu", item: ITEM });

    expect(parsed.item).toBe(ITEM);
    expect(
      restaurantVenueViewSchema.safeParse({ venue: VENUE, view: "overview", item: ITEM }).success,
    ).toBe(false);
    expect(restaurantVenueViewSchema.safeParse({ view: "menu", item: ITEM }).success).toBe(false);
  });

  test("panel views without a venue are rejected", () => {
    expect(restaurantVenueViewSchema.safeParse({ view: "overview" }).success).toBe(false);
    expect(restaurantVenueViewSchema.safeParse({ view: "menu" }).success).toBe(false);
    expect(restaurantVenueViewSchema.safeParse({ view: "reviews" }).success).toBe(false);
  });

  test("invalid venue and item ids are rejected", () => {
    expect(
      restaurantVenueViewSchema.safeParse({ venue: "not-a-uuid", view: "overview" }).success,
    ).toBe(false);
    expect(
      restaurantVenueViewSchema.safeParse({ venue: VENUE, view: "menu", item: "nope" }).success,
    ).toBe(false);
  });

  test("panel identity never enters loader deps, so panels never refetch results", () => {
    const full = restaurantSearchSchema
      .and(restaurantVenueViewSchema)
      .parse({ venue: VENUE, view: "menu", item: ITEM, fromDish: "pho-bo" });

    const deps = restaurantSearchSchema.parse(full);

    expect("venue" in deps).toBe(false);
    expect("view" in deps).toBe(false);
    expect("item" in deps).toBe(false);
    expect("fromDish" in deps).toBe(false);
  });
});
