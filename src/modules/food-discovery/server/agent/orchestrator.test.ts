// oxlint-disable-next-line import/no-unassigned-import -- side-effectful test environment setup, runs before server modules initialize.
import "@/modules/food-discovery/server/agent/test-env";
import { afterEach, describe, expect, test } from "bun:test";

import { Effect, Layer, ManagedRuntime, Predicate } from "effect";

import { resolveAgentBounds } from "@/modules/food-discovery/server/agent/bounds";
import type { ResolvedAgentBounds } from "@/modules/food-discovery/server/agent/bounds";
import {
  buildAgentEligibility,
  type AgentEligibility,
} from "@/modules/food-discovery/server/agent/eligibility";
import {
  AgentModelClient,
  AgentTranscriptEntry,
  AgentTurnOutput,
  type AgentTurnInput,
  type AgentTurnOutput as TurnOutput,
} from "@/modules/food-discovery/server/agent/model-client";
import {
  runAgentLoop,
  type AgentRunError,
} from "@/modules/food-discovery/server/agent/orchestrator";
import type { ProgressEvent } from "@/modules/food-discovery/server/agent/protocol";
import { RepositoriesLive } from "@/modules/food-discovery/server/index";
import type { RecommendationCandidateRow } from "@/modules/food-discovery/server/operations/recommendation-service";
import { DatabaseLive } from "@/server/database/client";
import { MetaAuthError, MetaRateLimited, type MetaError } from "@/server/integrations/meta-client";

/**
 * Orchestrator integration coverage with a scripted provider (no network,
 * no model spend) and real repository layers for the details path shape.
 * Search-only flows never touch the database; layer construction is lazy.
 */

const rowFor = (
  id: string,
  overrides?: Partial<RecommendationCandidateRow>,
): RecommendationCandidateRow =>
  // SAFETY: pool fixtures carry only the fields the loop and tools read; the remaining columns are never touched.
  ({
    id,
    slug: `dish-${id}`,
    name: `Dish ${id}`,
    englishName: null,
    cuisines: [],
    categories: [],
    description: `Description for dish ${id}`,
    ingredientNames: [],
    updatedAt: "2026-01-01",
    ...overrides,
  }) as RecommendationCandidateRow;

const pool: ReadonlyArray<RecommendationCandidateRow> = [
  rowFor("101", { cuisines: ["vietnamese"], name: "Pho" }),
  rowFor("202", { cuisines: ["vietnamese"], name: "Banh mi" }),
  rowFor("303", { cuisines: ["mexican"], name: "Taco" }),
];

const eligibility: AgentEligibility = (() => {
  const snapshot = buildAgentEligibility({
    scope: "country",
    cuisine: undefined,
    excludedIds: [],
    canonicalExclusions: [],
    locale: "en",
    meal: "dinner",
    regionLabel: "VN",
  });

  if (snapshot === null) {
    throw new Error("test eligibility must be valid");
  }

  return snapshot;
})();

const runtimes: Array<{ dispose: () => Promise<void> }> = [];

afterEach(async () => {
  const pending = [...runtimes];
  runtimes.length = 0;

  for (const runtime of pending) {
    // oxlint-disable-next-line no-await-in-loop -- Cleanup disposes runtimes in order so layer finalizers never race.
    await runtime.dispose();
  }
});

type ScriptStep = () => Effect.Effect<TurnOutput, MetaError>;

const scriptedClient = (seen: Array<AgentTurnInput>, steps: Array<ScriptStep>) =>
  Layer.succeed(AgentModelClient, {
    runTurn: (input: AgentTurnInput) => {
      seen.push(input);

      const next = steps.shift();

      if (next === undefined) {
        return Effect.die(new Error("provider script exhausted"));
      }

      return next();
    },
  });

const runWithScript = (
  seen: Array<AgentTurnInput>,
  steps: Array<ScriptStep>,
  overrides?: {
    readonly bounds?: ResolvedAgentBounds | undefined;
    readonly eligibility?: AgentEligibility | undefined;
    readonly events?: Array<ProgressEvent> | undefined;
  },
) => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(DatabaseLive, RepositoriesLive, scriptedClient(seen, steps)),
  );

  runtimes.push(runtime);

  return runtime.runPromise(
    runAgentLoop({
      bounds: overrides?.bounds,
      eligibility: overrides?.eligibility ?? eligibility,
      emitProgress:
        overrides?.events === undefined
          ? undefined
          : (event: ProgressEvent) => Effect.sync(() => void overrides.events?.push(event)),
      mood: "comforting",
      occasion: "dinner",
      pool,
      requestId: "test-request-uuid",
    }),
  );
};

const toolCallsOf = (input: AgentTurnInput): ReadonlyArray<{ id: string; name: string }> => {
  const found: Array<{ id: string; name: string }> = [];

  for (const entry of input.transcript) {
    AgentTranscriptEntry.$match(entry, {
      User: () => undefined,
      AssistantTools: ({ calls }) => {
        for (const call of calls) {
          found.push({ id: call.id, name: call.name });
        }
      },
      ToolResults: () => undefined,
    });
  }

  return found;
};

const toolResultsOf = (
  input: AgentTurnInput,
): ReadonlyArray<{ toolCallId: string; ok: boolean }> => {
  const found: Array<{ toolCallId: string; ok: boolean }> = [];

  for (const entry of input.transcript) {
    AgentTranscriptEntry.$match(entry, {
      User: () => undefined,
      AssistantTools: () => undefined,
      ToolResults: ({ results }) => {
        for (const result of results) {
          found.push({ ok: result.ok, toolCallId: result.toolCallId });
        }
      },
    });
  }

  return found;
};

const goodReason = (dish: string): string =>
  `A dinner fit grounded in the supplied Vietnamese categories for ${dish} and the requested occasion.`;

describe("runAgentLoop", () => {
  test("multi-round flow keeps exact tool-call/result id mapping and selects served ids", async () => {
    const seen: Array<AgentTurnInput> = [];

    const outcome = await runWithScript(seen, [
      () =>
        Effect.succeed(
          AgentTurnOutput.ToolCalls({
            calls: [{ args: { limit: 3 }, id: "call-1", name: "searchDishes" }],
          }),
        ),
      () =>
        Effect.succeed(
          AgentTurnOutput.Final({
            rawJson: JSON.stringify([
              { dishId: "202", reason: goodReason("Banh mi") },
              { dishId: "101", reason: goodReason("Pho") },
            ]),
          }),
        ),
    ]);

    expect(outcome._tag).toBe("Selected");

    if (!Predicate.isTagged(outcome, "Selected")) {
      return;
    }

    expect(outcome.ids).toEqual(["202", "101"]);
    expect(outcome.reasons).toHaveLength(2);
    expect(seen).toHaveLength(2);

    const secondTurn = seen[1];

    if (secondTurn === undefined) {
      throw new Error("second turn must have been issued");
    }

    expect(toolCallsOf(secondTurn)).toEqual([{ id: "call-1", name: "searchDishes" }]);
    expect(toolResultsOf(secondTurn)).toEqual([{ ok: true, toolCallId: "call-1" }]);
  });

  test("invalid model arguments cannot widen eligibility; unserved selection falls back", async () => {
    const seen: Array<AgentTurnInput> = [];
    const events: Array<ProgressEvent> = [];
    const fixed = { ...eligibility, cuisine: "vietnamese" };

    const outcome = await runWithScript(
      seen,
      [
        () =>
          Effect.succeed(
            AgentTurnOutput.ToolCalls({
              calls: [{ args: { cuisine: "mexican" }, id: "call-1", name: "searchDishes" }],
            }),
          ),
        () =>
          Effect.succeed(
            AgentTurnOutput.Final({
              rawJson: JSON.stringify([{ dishId: "303", reason: goodReason("Taco") }]),
            }),
          ),
      ],
      { eligibility: fixed, events },
    );

    expect(outcome._tag).toBe("DeterministicFallback");

    if (!Predicate.isTagged(outcome, "DeterministicFallback")) {
      return;
    }

    expect(outcome.cause).toBe("invalid-output");
    expect(outcome.ids).toEqual(["101", "202"]);

    const secondTurn = seen[1];

    if (secondTurn === undefined) {
      throw new Error("second turn must have been issued");
    }

    expect(toolResultsOf(secondTurn)).toEqual([{ ok: false, toolCallId: "call-1" }]);

    const terminals = events.filter((event) => event.terminal);

    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.stage).toBe("degraded");
    expect(terminals[0]?.requestId).toBe("test-request-uuid");

    const seqs = events.map((event) => event.seq);

    expect(seqs).toEqual([...seqs].toSorted((left, right) => left - right));
  });

  test("exhausted rounds fall back without inventing a selection", async () => {
    const bounds: ResolvedAgentBounds = { ...resolveAgentBounds(), maxRounds: 1, maxToolCalls: 1 };

    const outcome = await runWithScript(
      [],
      [
        () =>
          Effect.succeed(
            AgentTurnOutput.ToolCalls({
              calls: [
                { args: { limit: 1 }, id: "call-1", name: "searchDishes" },
                { args: { limit: 1 }, id: "call-2", name: "searchDishes" },
              ],
            }),
          ),
      ],
      { bounds },
    );

    expect(outcome._tag).toBe("DeterministicFallback");

    if (!Predicate.isTagged(outcome, "DeterministicFallback")) {
      return;
    }

    expect(outcome.cause).toBe("budget-exhausted");
    expect(outcome.ids).toEqual(["101", "202", "303"]);
  });

  test("an empty model turn falls back instead of reprompting", async () => {
    const outcome = await runWithScript(
      [],
      [() => Effect.succeed(AgentTurnOutput.ToolCalls({ calls: [] }))],
    );

    expect(outcome._tag).toBe("DeterministicFallback");

    if (!Predicate.isTagged(outcome, "DeterministicFallback")) {
      return;
    }

    expect(outcome.cause).toBe("invalid-output");
  });

  test("auth failures stay loud and never degrade silently", async () => {
    const seen: Array<AgentTurnInput> = [];

    const failure = await runWithScript(seen, [
      () => Effect.fail(new MetaAuthError({ reason: "bad key", status: 401 })),
    ]).then(
      () => ({ thrown: null }),
      (error: AgentRunError) => ({ thrown: error }),
    );

    expect(failure.thrown).toBeInstanceOf(MetaAuthError);
  });

  test("rate limiting degrades to the deterministic head with provenance", async () => {
    const events: Array<ProgressEvent> = [];

    const outcome = await runWithScript(
      [],
      [() => Effect.fail(new MetaRateLimited({ reason: "slow down", retryAfterSeconds: 7 }))],
      { events },
    );

    expect(outcome._tag).toBe("DeterministicFallback");

    if (!Predicate.isTagged(outcome, "DeterministicFallback")) {
      return;
    }

    expect(outcome.cause).toBe("rate-limited");
    expect(outcome.ids).toEqual(["101", "202", "303"]);

    const terminals = events.filter((event) => event.terminal);

    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.stage).toBe("degraded");
  });

  test("a hung provider hits the per-turn timeout and falls back", async () => {
    const bounds: ResolvedAgentBounds = { ...resolveAgentBounds(), providerTimeoutMs: 50 };

    const outcome = await runWithScript([], [() => Effect.never], { bounds });

    expect(outcome._tag).toBe("DeterministicFallback");

    if (!Predicate.isTagged(outcome, "DeterministicFallback")) {
      return;
    }

    expect(outcome.cause).toBe("timeout");
  }, 10000);

  test("progress events carry the real request id and close exactly once", async () => {
    const events: Array<ProgressEvent> = [];

    const outcome = await runWithScript(
      [],
      [
        () =>
          Effect.succeed(
            AgentTurnOutput.Final({
              rawJson: JSON.stringify([{ dishId: "101", reason: goodReason("Pho") }]),
            }),
          ),
      ],
      { events },
    );

    expect(outcome._tag).toBe("Selected");

    for (const event of events) {
      expect(event.requestId).toBe("test-request-uuid");
    }

    const terminals = events.filter((event) => event.terminal);

    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.stage).toBe("completed");

    const stages = events.map((event) => event.stage);

    expect(stages[0]).toBe("preparing");
  });
});
