import { describe, expect, test } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DISCOVERY_WORLDWIDE_NOTE_FALLBACK,
  DiscoveryCatalogEmptyPanel,
  DiscoveryErrorPanel,
  DiscoveryFallback,
  DiscoveryLoadingState,
  DiscoveryRegionEmptyPanel,
  DiscoveryUnknownPanel,
  DiscoveryWorldwideNote,
  resolveDiscoveryFallbackState,
  type DiscoveryResultInput,
} from "@/components/home/discovery-fallback";
import { messagesFor } from "@/shared/i18n";

/**
 * Discovery fallback shell contracts. State resolution is pure and the
 * panels render through `renderToStaticMarkup` (the same no-DOM-harness
 * approach as `tests/dish-carousel.test.ts`); interaction (button clicks,
 * autoplay, swipe) stays with Playwright.
 */

const baseInput = (overrides?: Partial<DiscoveryResultInput>): DiscoveryResultInput => ({
  failed: false,
  geoSettled: true,
  isAutoWorldwide: false,
  loading: false,
  located: true,
  total: 0,
  worldwide: false,
  ...overrides,
});

describe("resolveDiscoveryFallbackState", () => {
  test("loading wins over every other signal", () => {
    expect(
      resolveDiscoveryFallbackState(baseInput({ failed: true, loading: true, total: 3 })),
    ).toBe("loading");
  });

  test("failure beats empty results once loading settles", () => {
    expect(resolveDiscoveryFallbackState(baseInput({ failed: true }))).toBe("error");
  });

  test("served items are ready even when a failure flag lingers", () => {
    expect(resolveDiscoveryFallbackState(baseInput({ failed: false, total: 4 }))).toBe("ready");
  });

  test("unlocated plus settled geography renders the unknown panel, not nothing", () => {
    expect(resolveDiscoveryFallbackState(baseInput({ located: false }))).toBe("unknown");
  });

  test("unlocated plus unsettled geography holds the loading footprint", () => {
    expect(resolveDiscoveryFallbackState(baseInput({ geoSettled: false, located: false }))).toBe(
      "loading",
    );
  });

  test("a scoped query with nothing served offers the worldwide escape hatch", () => {
    expect(resolveDiscoveryFallbackState(baseInput())).toBe("region-empty");
  });

  test("a worldwide scope with nothing served means the catalog itself is empty", () => {
    expect(resolveDiscoveryFallbackState(baseInput({ worldwide: true }))).toBe("catalog-empty");
    expect(resolveDiscoveryFallbackState(baseInput({ isAutoWorldwide: true }))).toBe(
      "catalog-empty",
    );
  });
});

describe("discovery loading state", () => {
  test("announces loading and reuses the shared skeleton footprint", () => {
    const html = renderToStaticMarkup(
      createElement(DiscoveryLoadingState, { copy: messagesFor("en") }),
    );

    expect(html).toContain("Finding dishes for you…");
    expect(html).toContain("rounded-3xl");
    expect(html).toContain("--dish-feature-media-mobile");
    expect(html).toContain("--dish-feature-stage-desktop");
    expect(html).not.toContain("aspect-[4/3]");
    expect(html).not.toContain("md:min-h-[22rem]");
    expect(html).toContain("<output");
  });
});

describe("discovery worldwide note", () => {
  test("names the worldwide scope and never reads as local", () => {
    const html = renderToStaticMarkup(
      createElement(DiscoveryWorldwideNote, { copy: messagesFor("en") }),
    );

    expect(html).toContain("Dishes from around the world");
    expect(html).toContain(DISCOVERY_WORLDWIDE_NOTE_FALLBACK);
    expect(html).not.toContain("Near your precise location");
    expect(html).not.toContain("Network area");
  });

  test("honors an explicit note override (future i18n key path)", () => {
    const html = renderToStaticMarkup(
      createElement(DiscoveryWorldwideNote, {
        copy: messagesFor("vi"),
        note: "Ghi chú tùy chỉnh",
      }),
    );

    expect(html).toContain("Ghi chú tùy chỉnh");
    expect(html).not.toContain(DISCOVERY_WORLDWIDE_NOTE_FALLBACK);
  });
});

describe("discovery error panel", () => {
  test("is an alert with retry, visually distinct from the empty panels", () => {
    const html = renderToStaticMarkup(
      createElement(DiscoveryErrorPanel, {
        copy: messagesFor("en"),
        onRetry: () => {},
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not load dishes. Try again shortly.");
    expect(html).toContain("Try again");
    expect(html).toContain("<button");
    expect(html).toContain("text-danger");
  });

  test("holds the carousel footprint on mobile and desktop", () => {
    const html = renderToStaticMarkup(
      createElement(DiscoveryErrorPanel, {
        copy: messagesFor("en"),
        onRetry: () => {},
      }),
    );

    expect(html).toContain("rounded-3xl");
    expect(html).toContain("border-border-soft");
    expect(html).toContain("min-h-[20rem]");
    expect(html).toContain("md:min-h-[22rem]");
  });
});

describe("discovery unknown panel", () => {
  test("renders the unknown-location copy without a call to action", () => {
    const html = renderToStaticMarkup(
      createElement(DiscoveryUnknownPanel, { copy: messagesFor("en") }),
    );

    expect(html).toContain("Browse traveler favorites from around the world.");
    expect(html).not.toContain("<button");
    expect(html).not.toContain('role="alert"');
  });
});

describe("discovery region-empty panel", () => {
  test("pairs the scoped-empty copy with the worldwide escape hatch", () => {
    const html = renderToStaticMarkup(
      createElement(DiscoveryRegionEmptyPanel, {
        copy: messagesFor("en"),
        onExploreWorldwide: () => {},
      }),
    );

    expect(html).toContain("No dishes listed for this area yet.");
    expect(html).toContain("Explore worldwide dishes");
    expect(html).toContain("<button");
    expect(html).toContain("rounded-3xl");
  });
});

describe("discovery catalog-empty panel", () => {
  test("pairs the catalog-empty copy with the collecting-discoveries tagline", () => {
    const html = renderToStaticMarkup(
      createElement(DiscoveryCatalogEmptyPanel, { copy: messagesFor("en") }),
    );

    expect(html).toContain("No dishes in our catalog yet.");
    // Note: the apostrophe HTML-escapes to &#x27; in static markup.
    expect(html).toContain("still collecting delicious discoveries");
    // No escape hatch: worldwide was already tried.
    expect(html).not.toContain("<button");
  });

  test("honors an explicit tagline override (future i18n key path)", () => {
    const html = renderToStaticMarkup(
      createElement(DiscoveryCatalogEmptyPanel, {
        copy: messagesFor("vi"),
        tagline: "Dòng tùy chỉnh",
      }),
    );

    expect(html).toContain("Dòng tùy chỉnh");
  });
});

describe("DiscoveryFallback switch", () => {
  test("renders nothing for loading and ready (caller owns those)", () => {
    expect(
      renderToStaticMarkup(
        createElement(DiscoveryFallback, { copy: messagesFor("en"), state: "loading" }),
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(DiscoveryFallback, { copy: messagesFor("en"), state: "ready" }),
      ),
    ).toBe("");
  });

  test("mounts the error panel only with a retry handler", () => {
    expect(
      renderToStaticMarkup(
        createElement(DiscoveryFallback, { copy: messagesFor("en"), state: "error" }),
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(DiscoveryFallback, {
          copy: messagesFor("en"),
          onRetry: () => {},
          state: "error",
        }),
      ),
    ).toContain('role="alert"');
  });

  test("mounts the region-empty panel only with a worldwide handler", () => {
    expect(
      renderToStaticMarkup(
        createElement(DiscoveryFallback, { copy: messagesFor("en"), state: "region-empty" }),
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(DiscoveryFallback, {
          copy: messagesFor("en"),
          onExploreWorldwide: () => {},
          state: "region-empty",
        }),
      ),
    ).toContain("Explore worldwide dishes");
  });

  test("mounts unknown and catalog-empty panels without handlers", () => {
    expect(
      renderToStaticMarkup(
        createElement(DiscoveryFallback, { copy: messagesFor("en"), state: "unknown" }),
      ),
    ).toContain("Browse traveler favorites");
    expect(
      renderToStaticMarkup(
        createElement(DiscoveryFallback, { copy: messagesFor("en"), state: "catalog-empty" }),
      ),
    ).toContain("still collecting delicious discoveries");
  });
});
