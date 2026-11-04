import { describe, expect, test } from "bun:test";

import { runAgentEval, evalTable } from "../eval/agent-recommend-eval";

// Offline eval: deterministic stub provider, hand-maintained fixture.
// Asserts structural invariants for BOTH strategies and reports the
// computed metrics table. No quality/speed claims beyond this table.

describe("agentic recommendation eval", () => {
  test("both strategies stay eligible-correct and valid on every query", () => {
    const summary = runAgentEval(2);

    for (const metrics of summary.cases) {
      expect(metrics.eligibleCount).toBeGreaterThan(0);
      expect(metrics.singleShot.eligibleCorrect).toBe(true);
      expect(metrics.agentic.eligibleCorrect).toBe(true);
      expect(metrics.singleShot.valid).toBe(true);
      expect(metrics.agentic.valid).toBe(true);
      // No strategy may claim dishes beyond the configured final limit.
      expect(metrics.singleShot.ids.length).toBeLessThanOrEqual(10);
      expect(metrics.agentic.ids.length).toBeLessThanOrEqual(10);
    }

    expect(summary.singleShot.eligibleCorrectRate).toBe(1);
    expect(summary.agentic.eligibleCorrectRate).toBe(1);
    expect(summary.singleShot.validityRate).toBe(1);
    expect(summary.agentic.validityRate).toBe(1);
  });

  test("agentic explores at least as many unique dishes as single-shot", () => {
    const summary = runAgentEval(2);

    for (const metrics of summary.cases) {
      expect(metrics.agentic.uniqueDishesExplored).toBeGreaterThanOrEqual(
        metrics.singleShot.uniqueDishesExplored,
      );
    }

    expect((summary.agentic.meanUniqueExplored as number) >= (summary.singleShot.meanUniqueExplored as number)).toBe(true);
  });

  test("agentic respects round/call caps and degrades on provider failure", () => {
    const summary = runAgentEval(2);

    for (const metrics of summary.cases) {
      expect(metrics.agentic.rounds).toBeLessThanOrEqual(3);
      expect(metrics.agentic.providerCalls).toBeLessThanOrEqual(8);
    }

    // First 2 of 12 queries run provider-down: fallback rate is exactly that.
    expect(summary.agentic.fallbackRate).toBeCloseTo(2 / 12, 5);
    expect(summary.singleShot.fallbackRate).toBe(0);

    // Degraded runs still select eligible, valid dishes.
    const degraded = summary.cases.filter((metrics) => metrics.agentic.fallback);
    expect(degraded.length).toBe(2);
    for (const metrics of degraded) {
      expect(metrics.agentic.eligibleCorrect).toBe(true);
      expect(metrics.agentic.valid).toBe(true);
    }
  });

  test("provider latency is unevaluated offline (never extrapolated)", () => {
    const summary = runAgentEval(2);
    expect(summary.singleShot.p50LatencyMs).toBeNull();
    expect(summary.singleShot.p95LatencyMs).toBeNull();
    expect(summary.agentic.p50LatencyMs).toBeNull();
    expect(summary.agentic.p95LatencyMs).toBeNull();
  });

  test("evidence table (computed from the fixture)", () => {
    const table = evalTable(runAgentEval(2));
    console.log(`\n${table}\n`);
    expect(table).toContain("single-shot");
    expect(table).toContain("agentic");
  });
});
