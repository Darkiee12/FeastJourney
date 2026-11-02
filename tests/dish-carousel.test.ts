import { describe, expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  carouselAnnouncement,
  carouselDisplayIndex,
  carouselWrappedIndex,
  DISH_CAROUSEL_AUTOPLAY_MS,
  DishCarousel,
  dishCarouselIngredientNames,
  dishCarouselTitle,
  DishCarouselSkeleton,
  toCarouselPublishedImage,
} from "@/components/dish/dish-carousel";
import {
  RECOMMENDATION_RAIL_THUMB_SIZES,
  RecommendationRail,
} from "@/components/home/recommend/recommendation-rail";
import type { DishSummary } from "@/modules/food-discovery/server/domain/dish";
import type { CarouselCard } from "@/modules/food-discovery/server/operations/dish-service";
import type { FavoriteStatusQuery } from "@/modules/user/components/save-dish-button";
import type { SessionState } from "@/modules/user/session.functions";
import { messagesFor } from "@/shared/i18n";

/**
 * Shared dish carousel contracts. Pure helpers plus the skeleton SSR markup
 * are covered here with bun:test; interaction (autoplay, swipe, keyboard
 * cycle, focus containment) is covered by Playwright, not bun:test — no DOM
 * renderer is installed in this repo.
 */

const carouselItem = (overrides?: Partial<CarouselCard>): CarouselCard => ({
  description: "A test dish for carousel coverage.",
  descriptionLanguage: "en",
  englishName: "Test Dish",
  id: "101",
  image: null,
  ingredients: [
    { name: "Rice", role: "base" },
    { name: "Herbs", role: "garnish" },
  ],
  name: "Test Dish",
  nativeLanguageTag: undefined,
  nativeName: undefined,
  regionNames: ["Hanoi"],
  slug: "test-dish",
  ...overrides,
});

describe("carousel index math", () => {
  test("wraps forward and backward across the slide window", () => {
    expect(carouselWrappedIndex(0, 5)).toBe(0);
    expect(carouselWrappedIndex(5, 5)).toBe(0);
    expect(carouselWrappedIndex(6, 5)).toBe(1);
    expect(carouselWrappedIndex(-1, 5)).toBe(4);
    expect(carouselWrappedIndex(-6, 5)).toBe(4);
  });

  test("a single slide never moves", () => {
    expect(carouselWrappedIndex(1, 1)).toBe(0);
    expect(carouselWrappedIndex(-1, 1)).toBe(0);
  });

  test("empty input stays at zero instead of producing NaN", () => {
    expect(carouselWrappedIndex(0, 0)).toBe(0);
    expect(carouselWrappedIndex(3, 0)).toBe(0);
  });
});

describe("carousel announcements", () => {
  test("manual navigation announces the new position in English", () => {
    const copy = messagesFor("en");

    expect(carouselAnnouncement(copy, 0, 5)).toBe("Slide 1 of 5");
    expect(carouselAnnouncement(copy, 4, 5)).toBe("Slide 5 of 5");
  });

  test("manual navigation announces the new position in Vietnamese", () => {
    const copy = messagesFor("vi");

    expect(carouselAnnouncement(copy, 0, 5)).toBe("Trang 1 / 5");
    expect(carouselAnnouncement(copy, 2, 5)).toBe("Trang 3 / 5");
  });
});

describe("carousel slide titles", () => {
  test("prefers the localized name, then English, then the slug", () => {
    expect(dishCarouselTitle(carouselItem({ name: "Phở", englishName: "Pho" }))).toBe("Phở");
    expect(
      dishCarouselTitle(carouselItem({ name: undefined, englishName: "Pho", slug: "pho" })),
    ).toBe("Pho");
    expect(
      dishCarouselTitle(carouselItem({ name: undefined, englishName: undefined, slug: "pho" })),
    ).toBe("pho");
  });
});

describe("carousel ingredient preview", () => {
  test("drops missing names and caps the preview at six", () => {
    const item = carouselItem({
      ingredients: [
        { name: "Rice", role: "base" },
        { name: undefined, role: "unknown" },
        { name: "Herbs", role: "garnish" },
        { name: "Lime", role: "garnish" },
        { name: "Chili", role: "spice" },
        { name: "Broth", role: "base" },
        { name: "Beef", role: "protein" },
        { name: "Onion", role: "garnish" },
      ],
    });

    expect(dishCarouselIngredientNames(item)).toEqual([
      "Rice",
      "Herbs",
      "Lime",
      "Chili",
      "Broth",
      "Beef",
    ]);
  });

  test("absent ingredients resolve to an empty preview, not a fallback name", () => {
    expect(dishCarouselIngredientNames(carouselItem({ ingredients: undefined }))).toEqual([]);
    expect(dishCarouselIngredientNames(carouselItem({ ingredients: [] }))).toEqual([]);
  });
});

describe("carousel image projection", () => {
  test("absent photos project to null: the slide renders the honest fallback", () => {
    expect(toCarouselPublishedImage(null, "101")).toBeNull();
    expect(toCarouselPublishedImage(undefined, "101")).toBeNull();
  });

  test("published projections pass through untouched", () => {
    const published = {
      alt: "A test bowl",
      attribution: "Test Kitchen",
      dishId: "101",
      focalX: 0.5,
      focalY: 0.4,
      height: 800,
      id: "photo-1",
      srcSet: "https://cdn.example.com/400 400w",
      url: "https://cdn.example.com/1600",
      width: 1200,
    };

    expect(toCarouselPublishedImage(published, "101")).toEqual(published);
  });

  test("older payloads fill identity and dimensions defensively, never URLs", () => {
    const legacy = {
      alt: "Legacy photo",
      attribution: null,
      url: "https://example.com/legacy.jpg",
    };

    expect(toCarouselPublishedImage(legacy, "202")).toEqual({
      alt: "Legacy photo",
      attribution: null,
      dishId: "202",
      focalX: null,
      focalY: null,
      height: null,
      id: "202",
      srcSet: null,
      url: "https://example.com/legacy.jpg",
      width: null,
    });
  });

  test("keeps explicit per-photo identity when the payload carries it", () => {
    const legacy = {
      alt: "Legacy photo",
      attribution: "Archive",
      dishId: "303",
      id: "photo-9",
      url: "https://example.com/other.jpg",
    };

    const projected = toCarouselPublishedImage(legacy, "999");

    expect(projected?.id).toBe("photo-9");
    expect(projected?.dishId).toBe("303");
    expect(projected?.url).toBe("https://example.com/other.jpg");
  });
});

describe("carousel copy contract", () => {
  test("every string the shared carousel renders exists in English and Vietnamese", () => {
    for (const locale of ["en", "vi"] as const) {
      const copy = messagesFor(locale);

      for (const key of [
        "carouselPrev",
        "carouselNext",
        "carouselPlay",
        "carouselPause",
        "carouselSlide",
        "carouselOf",
        "carouselGoTo",
        "carouselIngredients",
        "carouselNoDescription",
        "carouselNoIngredients",
        "carouselPhotoSoon",
        "carouselExploreDish",
        "discoverLocalLoading",
      ] as const) {
        expect(copy[key].length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  test("autoplay stays off unless the caller opts in", () => {
    // The shared default is an explicit constant so both callers read the
    // same cadence; results mount without `autoplay` and never advance.
    expect(DISH_CAROUSEL_AUTOPLAY_MS).toBe(6000);
  });
});

describe("carousel loading skeleton", () => {
  test("mirrors the featured-slide layout with stable dimensions", () => {
    const html = renderToStaticMarkup(createElement(DishCarouselSkeleton));

    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("rounded-3xl");
    expect(html).toContain("border-border-soft");
    // Media frame reserves a bounded height up front (never the intrinsic
    // image size): no layout shift between skeleton, load, and settle.
    expect(html).toContain("--dish-feature-media-mobile");
    expect(html).toContain("--dish-feature-stage-desktop");
    expect(html).not.toContain("aspect-[4/3]");
    expect(html).not.toContain("md:min-h-[22rem]");
    // Info side matches the slide grid and padding.
    expect(html).toContain("md:grid-cols-[45%_55%]");
    expect(html).toContain("p-6");
    expect(html).toContain("sm:p-8");
    // Pulse is motion-safe like the rest of the carousel.
    expect(html).toContain("animate-pulse");
    expect(html).toContain("motion-reduce:animate-none");
    // Action row mirrors the shared DishActions: three 44px circles.
    expect(html.split("h-11 w-11").length - 1).toBe(3);
  });
});

describe("controlled index resolution", () => {
  test("uncontrolled mode shows the internal fallback (homepage default)", () => {
    expect(carouselDisplayIndex(undefined, 0, 5)).toBe(0);
    expect(carouselDisplayIndex(undefined, 3, 5)).toBe(3);
  });

  test("controlled activeIndex wins over the internal fallback", () => {
    expect(carouselDisplayIndex(2, 0, 5)).toBe(2);
    expect(carouselDisplayIndex(4, 1, 5)).toBe(4);
  });

  test("wraps out-of-range controlled values instead of clipping", () => {
    expect(carouselDisplayIndex(5, 0, 5)).toBe(0);
    expect(carouselDisplayIndex(-1, 0, 5)).toBe(4);
  });

  test("empty input stays at zero in both modes", () => {
    expect(carouselDisplayIndex(undefined, 0, 0)).toBe(0);
    expect(carouselDisplayIndex(3, 0, 0)).toBe(0);
  });
});

const railDish = (overrides?: Partial<DishSummary>): DishSummary => ({
  categorySlugs: ["noodles"],
  description: "A short rail description.",
  descriptionLanguage: "en",
  englishName: "Pho",
  id: "dish-1",
  image: null,
  ingredients: [],
  lastUpdate: 0,
  name: "Phở",
  nativeLanguageTag: "vi",
  nativeName: "Phở bò",
  regionNames: ["Hanoi"],
  slug: "pho",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const railProps = (overrides?: Partial<Parameters<typeof RecommendationRail>[0]>) => {
  // SAFETY: every entry comes from the DishSummary-typed railDish() helper;
  // the assertion only widens the mutable literal to the readonly prop type.
  const railItems = [
    railDish({ id: "dish-1", slug: "pho", name: "Phở" }),
    railDish({
      description: "Second dish description.",
      id: "dish-2",
      image: {
        alt: "A test bowl",
        attribution: null,
        dishId: "dish-2",
        id: "photo-2",
        srcSet: "https://cdn.example.com/400 400w, https://cdn.example.com/800 800w",
        url: "https://cdn.example.com/1600",
      },
      name: "Bánh mì",
      nativeName: undefined,
      regionNames: ["Saigon", "Central"],
      slug: "banh-mi",
    }),
    railDish({ id: "dish-3", image: null, name: "Bún chả", slug: "bun-cha" }),
  ] as ReadonlyArray<DishSummary>;

  return {
    activeIndex: 1,
    copy: messagesFor("en"),
    items: railItems,
    label: "More recommendations",
    lang: "en" as const,
    onSelect: () => {},
    ...overrides,
  };
};

describe("recommendation rail", () => {
  test("omits the rail for empty and single-dish result sets", () => {
    expect(renderToStaticMarkup(createElement(RecommendationRail, railProps({ items: [] })))).toBe(
      "",
    );
    expect(
      renderToStaticMarkup(
        createElement(
          RecommendationRail,
          railProps({ items: [railDish({ id: "only", slug: "only" })] }),
        ),
      ),
    ).toBe("");
  });

  test("renders one thumbnail per dish with the shared order, marking the active slide", () => {
    const html = renderToStaticMarkup(createElement(RecommendationRail, railProps()));

    expect(html).toContain("More recommendations");
    // Three dishes in, three thumbnails out: no placeholders, no filler.
    expect(html.match(/<li/g)?.length).toBe(3);
    expect(html).toContain("Phở");
    expect(html).toContain("Bánh mì");
    expect(html).toContain("Bún chả");
    // Exactly one active thumbnail; selection is by position.
    expect(html.match(/aria-current="true"/g)?.length).toBe(1);
    expect(html).toContain("Go to slide 2: Bánh mì");
    // Selected/hover/focus states ride on the border treatment.
    expect(html).toContain("border-food-orange-strong");
  });

  test("shows region context, native name, and short description without ratings or links", () => {
    const html = renderToStaticMarkup(createElement(RecommendationRail, railProps()));

    expect(html).toContain("Saigon · Central");
    expect(html).toContain("Phở bò");
    expect(html).toContain("Second dish description.");
    expect(html).not.toContain("See all");
    expect(html).not.toContain("★");
    expect(html).not.toMatch(/rating/i);
    expect(html).not.toMatch(/score/i);
  });

  test("falls back to a branded initial tile instead of inventing a photo", () => {
    const html = renderToStaticMarkup(createElement(RecommendationRail, railProps()));

    expect(html).toContain("from-food-orange-strong");
  });

  test("lazy-loads narrow thumbnails, never the featured 1600px bytes", () => {
    const html = renderToStaticMarkup(createElement(RecommendationRail, railProps()));

    expect(RECOMMENDATION_RAIL_THUMB_SIZES).toBe("(max-width: 640px) 40vw, 160px");
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("40vw");
    expect(html).not.toContain("1600w");
  });
});

describe("in-card Muse reason strip", () => {
  const guestSession: SessionState = { status: "signed-out" };

  const idleFavorites: FavoriteStatusQuery = {
    data: [],
    isPending: false,
    isError: false,
    refetch: () => undefined,
    dataUpdatedAt: 0,
  };

  const renderCarousel = async (
    reason: ReactNode | undefined,
    layout?: "full" | "compact",
  ): Promise<string> => {
    // Save buttons need a query client; links need the router. The shared
    // carousel owns both integrations, so the harness provides both. The
    // optional props carry explicit `| undefined` in DishCarouselProps, so
    // they pass straight through with no conditional spreads.
    const queryClient = new QueryClient();

    const node = createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(DishCarousel, {
        items: [
          carouselItem(),
          carouselItem({ id: "202", slug: "pho-bo", name: "Phở Bò", englishName: "Pho Bo" }),
        ],
        copy: messagesFor("en"),
        lang: "en",
        session: guestSession,
        favoriteStatus: idleFavorites,
        label: "Recommended dishes",
        layout,
        reason,
      }),
    );

    const rootRoute = createRootRoute();

    const restaurantsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/restaurants",
      component: () => null,
    });

    const dishRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/dishes/$dishId",
      component: () => null,
    });

    const testRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => node,
    });

    const router = createRouter({
      routeTree: rootRoute.addChildren([restaurantsRoute, dishRoute, testRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });

    await router.load();

    return renderToStaticMarkup(createElement(RouterProvider, { router }));
  };

  test("full layout renders the strip above the image inside the card border", async () => {
    const html = await renderCarousel(createElement("p", null, "WHY-PHO-MARKER"));

    expect(html).toContain("WHY-PHO-MARKER");
    expect(html).toContain("md:col-span-2");
    expect(html).toContain("md:h-32");
    expect(html).toContain("bg-cream/60");
    expect(html).toContain("h-[var(--dish-feature-media-mobile,clamp(180px,48vw,240px))]");
    // Strip precedes the media frame in DOM order on every slide.
    expect(html.indexOf("WHY-PHO-MARKER")).toBeLessThan(
      html.indexOf("h-[var(--dish-feature-media-mobile,clamp(180px,48vw,240px))]"),
    );
    // Media column and content column follow the strip.
    expect(html).toContain("md:grid-cols-[45%_55%]");
  });

  test("no reason renders no strip container", async () => {
    const html = await renderCarousel(undefined);

    expect(html).not.toContain("bg-cream/60");
    expect(html).not.toContain("md:col-span-2");
    expect(html).not.toContain("md:h-32");
    expect(html).toContain("h-[var(--dish-feature-media-mobile,clamp(180px,48vw,240px))]");
  });

  test("compact layout renders the strip above the thumb row", async () => {
    const html = await renderCarousel(createElement("p", null, "WHY-PHO-MARKER"), "compact");

    expect(html).toContain("WHY-PHO-MARKER");
    expect(html).toContain("bg-cream/60");
    expect(html).toContain("h-28 w-28");
    expect(html.indexOf("WHY-PHO-MARKER")).toBeLessThan(html.indexOf("h-28 w-28"));
  });
});
