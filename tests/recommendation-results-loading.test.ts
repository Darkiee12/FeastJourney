import { describe, expect, test } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DishCarouselCompactSkeleton, DishCarouselSkeleton } from "@/components/dish/dish-carousel";
import {
  clampResultsLoadingCount,
  RESULTS_LOADING_SKELETON_DEFAULT_CARDS,
  RESULTS_LOADING_SKELETON_MAX_CARDS,
  RESULTS_LOADING_SKELETON_MIN_CARDS,
  ResultsExplanationSkeleton,
  ResultsLoadingSkeleton,
} from "@/components/home/recommend/results-loading";
import { messagesFor } from "@/shared/i18n";

const copyEn = messagesFor("en");
const copyVi = messagesFor("vi");

const renderLoading = (dishCount?: number): string =>
  renderToStaticMarkup(createElement(ResultsLoadingSkeleton, { copy: copyEn, dishCount }));

const countOccurrences = (html: string, needle: string): number => html.split(needle).length - 1;

/**
 * Results loading composition (Agent A): the pending branch of quiz-flow
 * renderOutcome must reserve the loaded layout's footprint — featured
 * carousel, controls row, rail heading + cards, sidebar explanation slot —
 * with zero new i18n strings, no fake mode labels, and a single
 * screen-reader announcement owned by the caller's live region.
 */
describe("results loading count contract", () => {
  test("clamps into the 3–5 window with a default of 4", () => {
    expect(clampResultsLoadingCount(undefined)).toBe(RESULTS_LOADING_SKELETON_DEFAULT_CARDS);
    expect(RESULTS_LOADING_SKELETON_DEFAULT_CARDS).toBe(4);
    expect(clampResultsLoadingCount(4)).toBe(4);
    expect(clampResultsLoadingCount(1)).toBe(RESULTS_LOADING_SKELETON_MIN_CARDS);
    expect(clampResultsLoadingCount(10)).toBe(RESULTS_LOADING_SKELETON_MAX_CARDS);
    expect(clampResultsLoadingCount(Number.NaN)).toBe(RESULTS_LOADING_SKELETON_DEFAULT_CARDS);
  });

  test("default renders four rail cards, never ten", () => {
    expect(countOccurrences(renderLoading(), "<li")).toBe(4);
    expect(countOccurrences(renderLoading(10), "<li")).toBe(5);
    expect(countOccurrences(renderLoading(1), "<li")).toBe(3);
  });

  test("extra cards hide on small screens instead of overflowing", () => {
    const html = renderLoading(5);

    expect(html).toContain("hidden sm:block");
    expect(html).toContain("hidden lg:block");
  });
});

describe("results loading reuses shared geometry", () => {
  test("featured block is the shared carousel skeleton, not a copy", () => {
    const shared = renderToStaticMarkup(DishCarouselSkeleton());
    const loading = renderLoading();

    expect(loading).toContain(shared);
    expect(loading).toContain("md:min-h-[22rem]");
  });

  test("controls row reserves the real row offset at button height", () => {
    const html = renderLoading();

    expect(html).toContain("mt-4 flex flex-wrap items-center gap-3");
    expect(html).toContain("h-11 w-11");
    expect(html).toContain("rounded-full");
  });

  test("rail cards match real card geometry with stable heights", () => {
    const html = renderLoading();

    expect(html).toContain("w-36 flex-none sm:w-40");
    expect(html).toContain("aspect-[4/3]");
    expect(html).toContain("rounded-2xl border-2 border-border-soft bg-white");
  });

  test("rail heading is real text in both locales", () => {
    expect(renderLoading()).toContain(copyEn.recRailHeading);
    expect(renderToStaticMarkup(createElement(ResultsLoadingSkeleton, { copy: copyVi }))).toContain(
      copyVi.recRailHeading,
    );
  });

  test("sidebar footprint mirrors the neutral explanation card", () => {
    const html = renderToStaticMarkup(createElement(ResultsExplanationSkeleton));

    expect(html).toContain("rounded-2xl border-2 border-border-soft bg-white px-4 py-3");
  });
});

describe("results loading honesty and a11y", () => {
  test("renders no AI/deterministic/catalog label before the backend responds", () => {
    const html = renderLoading() + renderToStaticMarkup(createElement(ResultsExplanationSkeleton));

    expect(html).not.toContain(copyEn.recAiRankedTitle);
    expect(html).not.toContain(copyEn.recAiExplainer);
    expect(html).not.toContain(copyEn.recCatalogNote);
    expect(html).not.toContain(copyEn.recFallbackNote);
  });

  test("single announcement: sr-only loading text, no own live region", () => {
    const html = renderLoading();

    expect(html).toContain(copyEn.recLoading);
    expect(countOccurrences(html, copyEn.recLoading)).toBe(1);
    expect(html).not.toContain("aria-live");
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("<output");
  });

  test("keyboard neutral: no interactive elements or focus targets", () => {
    const html = renderLoading() + renderToStaticMarkup(createElement(ResultsExplanationSkeleton));

    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("tabindex");
  });

  test("subtle pulse only: every pulse bar opts out under reduced motion", () => {
    const html = renderLoading() + renderToStaticMarkup(createElement(ResultsExplanationSkeleton));

    expect(countOccurrences(html, "animate-pulse")).toBeGreaterThan(0);
    expect(countOccurrences(html, "animate-pulse")).toBe(
      countOccurrences(html, "motion-reduce:animate-none"),
    );
  });

  test("reuses existing copy only — no new strings required", () => {
    expect(copyEn.recLoading.length).toBeGreaterThan(0);
    expect(copyVi.recLoading.length).toBeGreaterThan(0);
    expect(copyEn.recRailHeading.length).toBeGreaterThan(0);
    expect(copyVi.recRailHeading.length).toBeGreaterThan(0);
  });
});

const renderCompact = (): string =>
  renderToStaticMarkup(createElement(ResultsLoadingSkeleton, { compact: true, copy: copyEn }));

describe("compact loading reserves the drawer card footprint", () => {
  test("compact uses the shared compact skeleton, never the full one", () => {
    const shared = renderToStaticMarkup(DishCarouselCompactSkeleton());
    const loading = renderCompact();

    expect(loading).toContain(shared);
    expect(loading).not.toContain("md:min-h-[22rem]");
  });

  test("compact renders no rail heading, rail cards, or controls row", () => {
    const html = renderCompact();

    expect(html).not.toContain(copyEn.recRailHeading);
    expect(html).not.toContain("<li");
    expect(html).not.toContain("h-11 w-11");
  });

  test("compact keeps the single sr-only announcement with no live region", () => {
    const html = renderCompact();

    expect(html).toContain(copyEn.recLoading);
    expect(countOccurrences(html, copyEn.recLoading)).toBe(1);
    expect(html).not.toContain("aria-live");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
  });
});
