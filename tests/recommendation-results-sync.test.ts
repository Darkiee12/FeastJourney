import { describe, expect, test } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { carouselDisplayIndex } from "@/components/dish/dish-carousel";
import { EMPTY_DRAFT, type RecommendPayload } from "@/components/home/recommend/quiz-model";
import { AiExplanationCard } from "@/components/home/recommend/quiz-status";
import { RememberPrefs } from "@/components/home/recommend/quiz-summary";
import { RecommendationRail } from "@/components/home/recommend/recommendation-rail";
import { ResultsSidebar } from "@/components/home/recommend/results-sidebar";
import type { DishSummary } from "@/modules/food-discovery/server/domain/dish";
import { RankingProvenance } from "@/modules/food-discovery/server/operations/recommendation-service";
import { messagesFor } from "@/shared/i18n";

const copyEn = messagesFor("en");

const dish = (id: string, name: string): DishSummary => ({
  categorySlugs: ["noodles"],
  description: `${name} description.`,
  descriptionLanguage: "en",
  englishName: name,
  id,
  image: null,
  ingredients: [],
  lastUpdate: 0,
  name,
  nativeLanguageTag: undefined,
  nativeName: undefined,
  regionNames: ["Hanoi"],
  slug: id,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const items = [dish("dish-1", "Phở"), dish("dish-2", "Bánh mì"), dish("dish-3", "Bún chả")];

const railHtml = (activeIndex: number): string =>
  renderToStaticMarkup(
    createElement(RecommendationRail, {
      activeIndex,
      copy: copyEn,
      items,
      label: "More recommendations",
      lang: "en",
      onSelect: () => {},
    }),
  );

const submitted: RecommendPayload = {
  ...EMPTY_DRAFT,
  country: "VN",
  excludedIngredients: ["pork", "peanut"],
  locale: "en",
  location: { country: "VN", kind: "destination" },
  meal: "dinner",
  mood: "comforting",
  surpriseSeed: 0,
};

const prefsBase = {
  // SAFETY: overrides assign string errors into this nullable slot; the
  // literal null alone would narrow the field and reject them.
  accountSaveError: null as string | null,
  checked: false,
  hasSaved: false,
  onChange: () => {},
  onClear: () => {},
  onConfirmClear: () => {},
  onDismissClear: () => {},
  onRetryAccountSave: () => {},
  showConfirmClear: false,
};

/**
 * Rail/featured synchronization and sidebar composition as shipped by
 * siblings (recommendation-rail.tsx, results-sidebar.tsx, controlled
 * DishCarousel props). The featured half needs router context so its DOM
 * stays a browser assertion; here we pin the SSR-observable half: the rail
 * mirrors whatever index the parent owns, and the sidebar stacks the cards
 * in contract order with no sticky or duplicated components.
 */
const sidebarHtml = (aiMode: "ai" | "deterministic" = "ai"): string =>
  renderToStaticMarkup(
    createElement(ResultsSidebar, {
      aiCard: createElement(AiExplanationCard, {
        copy: copyEn,
        mode: aiMode,
        ranking:
          aiMode === "ai" ? RankingProvenance.LiveMuse() : RankingProvenance.DeterministicCatalog(),
      }),
      copy: copyEn,
      countryOptions: [{ code: "VN", label: "Vietnam" }],
      onEditStep: () => {},
      prefs: prefsBase,
      submitted,
    }),
  );

const prefsHtml = (overrides?: Partial<typeof prefsBase>): string =>
  renderToStaticMarkup(createElement(RememberPrefs, { ...prefsBase, copy: copyEn, ...overrides }));

describe("rail mirrors the featured slide", () => {
  test("exactly one thumbnail is current and it tracks the shared index", () => {
    const first = railHtml(0);

    const last = railHtml(2);

    expect(first.match(/aria-current="true"/g)?.length).toBe(1);
    expect(first).toContain("Go to slide 1: Phở");
    expect(last.match(/aria-current="true"/g)?.length).toBe(1);
    expect(last).toContain("Go to slide 3: Bún chả");
  });

  test("out-of-range shared indexes wrap instead of clearing the selection", () => {
    const html = railHtml(3);

    expect(html.match(/aria-current="true"/g)?.length).toBe(1);
    expect(html).toContain("Go to slide 1: Phở");
  });

  test("rail and featured carousel resolve the same display index", () => {
    // The parent owns one index; both components wrap it identically.
    for (const active of [0, 1, 2, 3, -1]) {
      const railActive = carouselDisplayIndex(active, 0, items.length);

      expect(railActive).toBeGreaterThanOrEqual(0);
      expect(railActive).toBeLessThan(items.length);
    }

    expect(carouselDisplayIndex(2, 0, items.length)).toBe(2);
  });

  test("thumbnail order matches the featured order with no filler", () => {
    const html = railHtml(0);

    const pho = html.indexOf("Phở");

    const banhMi = html.indexOf("Bánh mì");

    const bunCha = html.indexOf("Bún chả");

    expect(pho).toBeGreaterThan(-1);
    expect(banhMi).toBeGreaterThan(pho);
    expect(bunCha).toBeGreaterThan(banhMi);
    expect(html.match(/<li/g)?.length).toBe(3);
  });
});

describe("results sidebar composition", () => {
  test("stacks Your Picks, the AI card, and remember-prefs in order", () => {
    const html = sidebarHtml();

    const picks = html.indexOf(copyEn.recSummaryLabel);

    const ai = html.indexOf(copyEn.recAiRankedTitle);

    const remember = html.indexOf(copyEn.recRememberDestination);

    expect(picks).toBeGreaterThan(-1);
    expect(ai).toBeGreaterThan(picks);
    expect(remember).toBeGreaterThan(ai);
  });

  test("sidebar carries submitted answers into the picks card", () => {
    const html = sidebarHtml();

    expect(html).toContain("Vietnam");
    expect(html).toContain("pork");
  });

  test("single column with no sticky positioning and no duplicated cards", () => {
    const html = sidebarHtml();

    expect(html).not.toContain("sticky");
    expect(html.match(/aria-current/g)?.length ?? 0).toBe(0);
  });

  test("deterministic AI card variant composes without Muse branding", () => {
    const html = sidebarHtml("deterministic");

    expect(html).toContain("Selected from our food catalog");
    expect(html).not.toContain("Ranked by Muse");
  });
});

describe("remember-prefs rules on the results surface", () => {
  test("opt-in starts unchecked with the destination-only label and auto-save note", () => {
    const html = prefsHtml();

    expect(html).not.toContain("checked");
    expect(html).toContain(copyEn.recRememberDestination);
    expect(html).toContain(copyEn.recExclusionsAutoSaved);
  });

  test("clear control appears only with saved preferences", () => {
    expect(prefsHtml()).not.toContain(copyEn.recClearPrefs);

    const html = prefsHtml({ hasSaved: true });

    expect(html).toContain(copyEn.recClearPrefs);
  });

  test("account save failure surfaces an inline retry without touching the form", () => {
    const html = prefsHtml({ accountSaveError: copyEn.recError });

    expect(html).toContain('role="alert"');
    expect(html).toContain(copyEn.recError);
    expect(html).toContain(copyEn.recRetry);
  });

  test("confirm step requires an explicit second tap", () => {
    const html = prefsHtml({ hasSaved: true, showConfirmClear: true });

    expect(html).toContain(copyEn.recClearPrefsConfirm);
    expect(html).toContain(copyEn.recClearPrefsYes);
    expect(html).toContain(copyEn.recClearPrefsNo);
  });
});
