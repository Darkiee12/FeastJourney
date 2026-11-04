import "@/modules/food-discovery/server/agent/test-env";
import { describe, expect, test } from "bun:test";

import { summarizeCandidate } from "@/modules/food-discovery/server/agent/catalog-tools";
import {
  buildAgentEligibility,
  type AgentEligibility,
} from "@/modules/food-discovery/server/agent/eligibility";
import {
  AGENT_TOOL_DEFINITIONS,
  buildAgentSystemPrompt,
  buildAgentUserBlock,
  parseFinalSelection,
} from "@/modules/food-discovery/server/agent/model-client";
import type { AgentToolName } from "@/modules/food-discovery/server/agent/protocol";
import type { RecommendationCandidateRow } from "@/modules/food-discovery/server/operations/recommendation-service";

const eligibility: AgentEligibility = (() => {
  const snapshot = buildAgentEligibility({
    scope: "city",
    cuisine: undefined,
    excludedIds: ["11"],
    canonicalExclusions: ["Peanut"],
    locale: "en",
    meal: "dinner",
    regionLabel: "VN",
  });

  if (snapshot === null) {
    throw new Error("test eligibility must be valid");
  }

  return snapshot;
})();

describe("parseFinalSelection", () => {
  test("parses a bare array and an enveloped object", () => {
    const raw = JSON.stringify([
      { dishId: "101", reason: "A grounded dinner fit for the requested occasion." },
    ]);

    const parsed: unknown = JSON.parse(raw);

    expect(parseFinalSelection(raw)?.selections).toHaveLength(1);
    expect(parseFinalSelection(JSON.stringify({ selections: parsed }))?.selections).toHaveLength(1);
  });

  test("rejects garbage, oversized, and structurally invalid payloads", () => {
    expect(parseFinalSelection("not json")).toBeNull();
    expect(parseFinalSelection("")).toBeNull();
    expect(parseFinalSelection("x".repeat(17 * 1024))).toBeNull();
    expect(parseFinalSelection(JSON.stringify([{ dishId: "101" }]))).toBeNull();
  });
});

describe("agent prompt construction", () => {
  test("tool definitions expose exactly the protocol tools", () => {
    const names = AGENT_TOOL_DEFINITIONS.map((tool) => tool.name).toSorted();

    expect(names).toEqual(["getDishDetails", "searchDishes"] satisfies Array<AgentToolName>);
  });

  test("user block carries context and overview but never coordinates or raw terms", () => {
    const row = {
      id: "101",
      slug: "pho",
      name: "Pho",
      englishName: null,
      cuisines: ["vietnamese"],
      categories: ["dinner"],
      description: "Noodle soup",
      ingredientNames: [],
      updatedAt: "2026-01-01",
    } as RecommendationCandidateRow;

    const block = buildAgentUserBlock({
      eligibility,
      mood: "comforting",
      occasion: "dinner",
      overview: [summarizeCandidate(row)],
    });

    expect(block).toContain("Pho");
    expect(block).toContain("Peanut");
    expect(block).not.toContain("12.34");

    const system = buildAgentSystemPrompt();

    expect(system).toContain("read-only");
    expect(system.length).toBeGreaterThan(0);
  });
});
