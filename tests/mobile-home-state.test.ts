import { describe, expect, test } from "bun:test";

import { filterCountryOptions } from "@/components/home/discovery-location";
import {
  computeMobileGlobeGeometry,
  INITIAL_MOBILE_HOME_STATE,
  mobileHomeReducer,
  mobileSheetHeightPx,
} from "@/components/home/mobile/mobile-home-state";

describe("mobile sheet state machine", () => {
  test("only one primary mode is active and location returns to its opener", () => {
    let state = mobileHomeReducer(INITIAL_MOBILE_HOME_STATE, { type: "open-discovery" });
    expect(state.mode).toBe("discovery");

    state = mobileHomeReducer(state, { type: "open-location" });
    expect(state).toMatchObject({ mode: "location", returnTo: "discovery" });

    state = mobileHomeReducer(state, { type: "back" });
    expect(state.mode).toBe("discovery");

    state = mobileHomeReducer(state, { type: "open-quiz" });
    state = mobileHomeReducer(state, { type: "show-results" });
    expect(state.mode).toBe("results");

    state = mobileHomeReducer(state, { type: "close" });
    expect(state.mode).toBe("collapsed");
  });

  test("location opened from results returns to results, preserving quiz state owner", () => {
    let state = mobileHomeReducer(INITIAL_MOBILE_HOME_STATE, { type: "show-results" });
    state = mobileHomeReducer(state, { type: "open-location" });
    state = mobileHomeReducer(state, { type: "back" });
    expect(state.mode).toBe("results");
  });
});

describe("mobile sheet sizing", () => {
  test("quiz and discovery share one height, all fit short viewports", () => {
    expect(mobileSheetHeightPx("collapsed", 844)).toBe(76);
    expect(mobileSheetHeightPx("quiz", 844)).toBeGreaterThan(400);
    expect(mobileSheetHeightPx("discovery", 844)).toBe(mobileSheetHeightPx("quiz", 844));
    expect(mobileSheetHeightPx("location", 568)).toBeLessThanOrEqual(568 - 56);
    expect(mobileSheetHeightPx("quiz", 568)).toBeGreaterThanOrEqual(280);
  });
});

describe("mobile globe geometry", () => {
  test("sheet top and globe lift share one coordinate system", () => {
    const collapsed = computeMobileGlobeGeometry({
      viewportWidth: 390,
      viewportHeight: 844,
      sheetHeightPx: mobileSheetHeightPx("collapsed", 844),
    });

    const quiz = computeMobileGlobeGeometry({
      viewportWidth: 390,
      viewportHeight: 844,
      sheetHeightPx: mobileSheetHeightPx("quiz", 844),
    });

    expect(collapsed.globeLiftPx).toBe(0);
    expect(quiz.sheetTopPx).toBe(844 - mobileSheetHeightPx("quiz", 844));
    expect(quiz.globeLiftPx).toBeGreaterThan(0);
    expect(quiz.visibleGlobeHeightPx).toBe(quiz.sheetTopPx);
    expect(quiz.globeDiameterPx).toBe(390 - 32);
  });

  test("degenerate viewport never yields NaN or negative lift", () => {
    const geometry = computeMobileGlobeGeometry({
      viewportWidth: 0,
      viewportHeight: 0,
      sheetHeightPx: 0,
    });

    expect(Number.isFinite(geometry.globeLiftPx)).toBe(true);
    expect(geometry.globeLiftPx).toBeGreaterThanOrEqual(0);
    expect(geometry.globeDiameterPx).toBeGreaterThanOrEqual(1);
  });
});

describe("country search filtering", () => {
  const countries = [
    { code: "VN", label: "Vietnam" },
    { code: "JP", label: "Japan" },
    { code: "IN", label: "India" },
  ];

  test("matches localized name and ISO code, unmatched returns empty", () => {
    const vietnam = countries[0];
    const japan = countries[1];

    if (vietnam === undefined || japan === undefined) throw new Error("fixture missing");

    expect(filterCountryOptions(countries, "viet")).toEqual([vietnam]);
    expect(filterCountryOptions(countries, "jp")).toEqual([japan]);
    expect(filterCountryOptions(countries, "  JAPAN ")).toEqual([japan]);
    expect(filterCountryOptions(countries, "atlantis")).toEqual([]);
    expect(filterCountryOptions(countries, "")).toEqual(countries);
  });
});
