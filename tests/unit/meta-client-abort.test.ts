import { afterEach, describe, expect, test } from "bun:test";

import { Cause, Effect, Exit } from "effect";

import { RankingConfig } from "@/server/env";
import { MetaClient, MetaClientLive } from "@/server/integrations/meta-client";

const museConfig = RankingConfig.Muse({
  apiKey: "synthetic-ranking-test-key",
  modelId: "muse-spark-1.3",
  baseUrl: "https://api.meta.ai/v1",
  timeoutMs: 5000,
  candidateLimit: 60,
  outputLimit: 10,
  maxTokens: 4000,
});

const context = { occasion: "dinner", mood: "comforting", cuisineOrRegion: null, excludedIngredients: [] } as const;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Meta ranking request cancellation", () => {
  test("external interruption aborts the in-flight provider request", async () => {
    let aborted = false;

    const stub = Object.assign(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("synthetic interruption"));
            },
            { once: true },
          );
        }),
      {
        preconnect: (_url: string | URL) => {
          // Synthetic stub: preconnect is irrelevant to abort semantics.
        },
      },
    ) satisfies typeof fetch;

    globalThis.fetch = stub;

    const rank = Effect.flatMap(MetaClient, (client) => client.rank([], context, museConfig));

    const result = await Effect.runPromise(
      Effect.raceFirst(
        Effect.provide(rank, MetaClientLive),
        Effect.interrupt.pipe(Effect.delay("10 millis")),
      ).pipe(Effect.exit),
    );

    expect(Exit.isFailure(result)).toBe(true);

    if (!Exit.isFailure(result)) throw new Error("Expected interrupted exit");

    expect(Cause.hasInterruptsOnly(result.cause)).toBe(true);
    expect(aborted).toBe(true);
  });
});
