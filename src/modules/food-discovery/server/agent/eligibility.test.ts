import "@/modules/food-discovery/server/agent/test-env";
import { describe, expect, test } from "bun:test";

import {
  buildAgentEligibility,
  type AgentEligibilityInput,
} from "@/modules/food-discovery/server/agent/eligibility";

const base: AgentEligibilityInput = {
  scope: "country",
  cuisine: "vietnamese",
  excludedIds: ["11", "22", "11"],
  canonicalExclusions: ["Peanut"],
  locale: "en",
  meal: "dinner",
  regionLabel: "VN",
};

describe("buildAgentEligibility", () => {
  test("builds a frozen snapshot and dedupes exclusion ids", () => {
    const snapshot = buildAgentEligibility(base);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.scope).toBe("country");
    expect(snapshot?.cuisine).toBe("vietnamese");
    expect(snapshot?.excludedIds).toEqual(["11", "22"]);
    expect(snapshot?.canonicalExclusions).toEqual(["Peanut"]);
    expect(snapshot?.regionLabel).toBe("VN");
  });

  test("normalizes an absent cuisine to null", () => {
    const snapshot = buildAgentEligibility({ ...base, cuisine: undefined });

    expect(snapshot?.cuisine).toBeNull();
  });

  test("fails closed on a non-decimal exclusion id", () => {
    expect(buildAgentEligibility({ ...base, excludedIds: ["11", "dish-9"] })).toBeNull();
  });

  test("fails closed on a non-tag locale", () => {
    expect(buildAgentEligibility({ ...base, locale: "not a locale!!" })).toBeNull();
  });

  test("fails closed on an unknown scope", () => {
    expect(
      buildAgentEligibility({ ...base, scope: "galaxy" as AgentEligibilityInput["scope"] }),
    ).toBeNull();
  });

  test("fails closed on an empty meal signal", () => {
    expect(buildAgentEligibility({ ...base, meal: "   " })).toBeNull();
  });

  test("fails closed on a blank explicit cuisine", () => {
    expect(buildAgentEligibility({ ...base, cuisine: "  " })).toBeNull();
  });
});
