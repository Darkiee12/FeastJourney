import { describe, expect, test } from "bun:test";

import { isAgentEnabled, resolveAgentBounds } from "@/modules/food-discovery/server/agent/bounds";
import { AGENT_BOUNDS } from "@/modules/food-discovery/server/agent/protocol";
import { TEST_AGENT_BOUND_VALUES } from "@/modules/food-discovery/server/agent/test-env";

describe("env-required contract bounds", () => {
  test("AGENT_BOUNDS carries the explicitly stated test values", () => {
    expect(AGENT_BOUNDS.maxRounds).toBe(Number(TEST_AGENT_BOUND_VALUES.RECOMMEND_AGENT_MAX_ROUNDS));
    expect(AGENT_BOUNDS.maxToolCalls).toBe(
      Number(TEST_AGENT_BOUND_VALUES.RECOMMEND_AGENT_MAX_TOOL_CALLS),
    );
    expect(AGENT_BOUNDS.detailsPerCall).toBe(
      Number(TEST_AGENT_BOUND_VALUES.RECOMMEND_AGENT_DETAILS_PER_CALL),
    );
    expect(AGENT_BOUNDS.candidatePoolCap).toBe(
      Number(TEST_AGENT_BOUND_VALUES.RECOMMEND_AGENT_CANDIDATE_POOL_CAP),
    );
    expect(AGENT_BOUNDS.finalLimit).toBe(
      Number(TEST_AGENT_BOUND_VALUES.RECOMMEND_AGENT_FINAL_LIMIT),
    );
    expect(AGENT_BOUNDS.providerTimeoutMs).toBe(
      Number(TEST_AGENT_BOUND_VALUES.MODEL_AGENT_TIMEOUT_MS),
    );
    expect(AGENT_BOUNDS.orchestrationDeadlineMs).toBe(
      Number(TEST_AGENT_BOUND_VALUES.RECOMMEND_AGENT_DEADLINE_MS),
    );
  });

  test("every contract bound is a positive safe integer", () => {
    for (const value of Object.values(AGENT_BOUNDS)) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});

describe("resolveAgentBounds", () => {
  test("derives workstream mechanics from the contract with no literal of its own", () => {
    const bounds = resolveAgentBounds();

    expect(bounds.toolPageLimit).toBe(bounds.finalLimit);
    expect(bounds.initialOverviewLimit).toBe(bounds.finalLimit);
    expect(bounds.maxToolCallsPerRound).toBe(Math.ceil(bounds.maxToolCalls / bounds.maxRounds));
    expect(bounds.maxToolCallsPerRound).toBeGreaterThanOrEqual(1);
  });
});

describe("isAgentEnabled", () => {
  test("is off when unset, empty, or explicitly false", () => {
    expect(isAgentEnabled({})).toBe(false);
    expect(isAgentEnabled({ RECOMMEND_AGENT_FLAG: "" })).toBe(false);
    expect(isAgentEnabled({ RECOMMEND_AGENT_FLAG: "0" })).toBe(false);
    expect(isAgentEnabled({ RECOMMEND_AGENT_FLAG: "false" })).toBe(false);
  });

  test("is on for 1/true in any case", () => {
    expect(isAgentEnabled({ RECOMMEND_AGENT_FLAG: "1" })).toBe(true);
    expect(isAgentEnabled({ RECOMMEND_AGENT_FLAG: "true" })).toBe(true);
    expect(isAgentEnabled({ RECOMMEND_AGENT_FLAG: "TRUE" })).toBe(true);
  });
});
