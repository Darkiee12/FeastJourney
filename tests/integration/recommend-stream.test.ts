import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect, Layer, ManagedRuntime } from "effect";

import {
  handleRecommendStream,
  isAgentStreamEnabled,
  mergeExcludedIngredients,
  type StreamPipeline,
} from "@/modules/food-discovery/server/agent/progress-transport";
import { SseParser } from "@/modules/food-discovery/server/agent/stream-codec";
import type { ProgressEvent } from "@/modules/food-discovery/server/agent/protocol";
import { CatalogServicesLive, RepositoriesLive } from "@/modules/food-discovery/server/index";
import { CatalogImportServiceLive } from "@/modules/food-discovery/server/operations/catalog-import-service";
import { CurationServiceLive } from "@/modules/food-discovery/server/operations/curation-service";
import {
  RecommendationOutcome,
  RecommendationMisconfigured,
  RecommendationServiceLive,
} from "@/modules/food-discovery/server/operations/recommendation-service";
import { DatabaseLive } from "@/server/database/client";
import { RateLimitExceeded } from "@/server/http/api-error";
import { RateLimitPolicy, RateLimiterLive, RateLimitPolicyLive } from "@/server/http/rate-limit";
import { MetaClient } from "@/server/integrations/meta-client";
import { resetServerEnvCache } from "@/server/env";

// Stream transport tests: guards run BEFORE expensive work, the SSE body
// carries exactly one terminal event plus one result, and disconnects
// interrupt the pipeline. The catalog reads hit the real disposable
// database; the provider is never configured here (deterministic path).

const CurationLive = Layer.provide(CurationServiceLive, RepositoriesLive);

const DomainLive = Layer.provide(
  Layer.mergeAll(CatalogServicesLive, CatalogImportServiceLive),
  Layer.mergeAll(RepositoriesLive, CurationLive),
);

const fakeMeta = Layer.succeed(MetaClient, {
  rank: () => Effect.die("MetaClient must not be called on the deterministic path"),
});

const recommendationLive = Layer.provide(
  RecommendationServiceLive,
  Layer.mergeAll(RepositoriesLive, fakeMeta),
);

const makeRuntime = (policy: Layer.Layer<RateLimitPolicy> = RateLimitPolicyLive) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      DatabaseLive,
      RepositoriesLive,
      CurationLive,
      DomainLive,
      recommendationLive,
      fakeMeta,
      RateLimiterLive,
      policy,
    ),
  );

type TestRuntime = ReturnType<typeof makeRuntime>;

const runtimes: Array<TestRuntime> = [];

const track = (runtime: TestRuntime): TestRuntime => {
  runtimes.push(runtime);
  return runtime;
};

const limitedPolicy = Layer.succeed(RateLimitPolicy, {
  check: () => Effect.fail(new RateLimitExceeded({ retryAfterSeconds: 5, limit: 1 })),
});

const withAgentFlag = (value: string | undefined): void => {
  if (value === undefined) {
    delete process.env.RECOMMEND_AGENT_ENABLED;
  } else {
    process.env.RECOMMEND_AGENT_ENABLED = value;
  }
};

const streamRequest = (body: unknown, headers: Record<string, string> = {}): Request =>
  new Request("http://localhost/api/v1/recommendations/stream", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const validBody = { meal: "dinner", mood: "comfort", locale: "en" };

interface CollectedStream {
  readonly response: Response;
  readonly text: string;
  readonly progress: Array<ProgressEvent>;
  readonly results: Array<unknown>;
  readonly errors: Array<unknown>;
}

const collectStream = async (response: Response): Promise<CollectedStream> => {
  const text = await response.text();
  const parser = new SseParser();
  const frames = parser.push(text);
  return {
    response,
    text,
    progress: frames.flatMap((frame) => (frame.kind === "progress" ? [frame.event] : [])),
    results: frames.flatMap((frame) => (frame.kind === "result" ? [frame.wire] : [])),
    errors: frames.flatMap((frame) => (frame.kind === "error" ? [frame.error] : [])),
  };
};

beforeAll(() => {
  delete process.env.RECOMMENDATION_PROVIDER;
  delete process.env.MODEL_API_KEY;
  resetServerEnvCache();
});

afterAll(async () => {
  withAgentFlag(undefined);
  for (const runtime of runtimes) {
    await runtime.dispose();
  }
  runtimes.length = 0;
});

describe("agent stream guards (pure)", () => {
  test("flag parsing accepts explicit opt-ins only", () => {
    expect(isAgentStreamEnabled({ RECOMMEND_AGENT_ENABLED: "1" })).toBe(true);
    expect(isAgentStreamEnabled({ RECOMMEND_AGENT_ENABLED: "true" })).toBe(true);
    expect(isAgentStreamEnabled({ RECOMMEND_AGENT_ENABLED: " yes " })).toBe(true);
    expect(isAgentStreamEnabled({})).toBe(false);
    expect(isAgentStreamEnabled({ RECOMMEND_AGENT_ENABLED: "0" })).toBe(false);
    expect(isAgentStreamEnabled({ RECOMMEND_AGENT_ENABLED: "false" })).toBe(false);
    expect(isAgentStreamEnabled({ RECOMMEND_AGENT_ENABLED: "" })).toBe(false);
  });

  test("exclusion merge is canonical-first with exact dedupe", () => {
    expect(
      mergeExcludedIngredients({ excludedIngredients: ["beef", "egg"], avoid: ["beef", "pork"], allergies: ["egg", "milk"] }),
    ).toEqual(["beef", "egg", "pork", "milk"]);
  });
});

describe("agent stream pre-work rejections", () => {
  test("disabled flag returns JSON 404 without touching the pipeline", async () => {
    withAgentFlag(undefined);
    const runtime = track(makeRuntime());

    let pipelineCalls = 0;
    const pipeline: StreamPipeline = () => {
      pipelineCalls += 1;
      return Effect.die("pipeline must not run when the flag is off");
    };

    const response = await runtime.runPromise(handleRecommendStream(streamRequest(validBody), pipeline));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "agent_disabled" });
    expect(pipelineCalls).toBe(0);
  });

  test("malformed JSON returns 400", async () => {
    withAgentFlag("1");
    const runtime = track(makeRuntime());

    const response = await runtime.runPromise(handleRecommendStream(streamRequest("{oops")));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_input" });
  });

  test("schema-invalid body returns 400 with a message", async () => {
    withAgentFlag("1");
    const runtime = track(makeRuntime());

    const response = await runtime.runPromise(
      handleRecommendStream(streamRequest({ meal: "brunch-at-midnight" })),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message?: string };
    expect(body.error).toBe("invalid_input");
    expect(typeof body.message).toBe("string");
  });

  test("rate limiting rejects with 429 + Retry-After before any pipeline work", async () => {
    withAgentFlag("1");
    const runtime = track(makeRuntime(limitedPolicy));

    let pipelineCalls = 0;
    const pipeline: StreamPipeline = () => {
      pipelineCalls += 1;
      return Effect.die("pipeline must not run when rate-limited");
    };

    const response = await runtime.runPromise(handleRecommendStream(streamRequest(validBody), pipeline));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 5 });
    expect(pipelineCalls).toBe(0);
  });
});

describe("agent stream happy path", () => {
  test("guest deterministic stream carries one terminal plus one result", async () => {
    withAgentFlag("true");
    const runtime = track(makeRuntime());

    const response = await runtime.runPromise(
      handleRecommendStream(streamRequest(validBody, { "x-request-id": "stream-happy-1" })),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("X-Request-Id")).toBe("stream-happy-1");

    const collected = await collectStream(response);
    const { progress, results, errors } = collected;

    expect(errors).toEqual([]);
    expect(results).toHaveLength(1);

    // Exactly one terminal event; seq strictly increases from 0.
    const terminals = progress.filter((event) => event.terminal);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.stage === "completed" || terminals[0]?.stage === "degraded").toBe(true);

    const seqs = progress.map((event) => event.seq);
    expect(seqs[0]).toBe(0);
    for (let index = 1; index < seqs.length; index += 1) {
      expect((seqs[index] as number) > (seqs[index - 1] as number)).toBe(true);
    }

    // Every event carries the request id; the stream never leaks
    // coordinates (keys or raw pairs) into details or results.
    for (const event of progress) {
      expect(event.requestId).toBe("stream-happy-1");
    }
    expect(collected.text).not.toContain("latitude");
    expect(collected.text).not.toContain("longitude");

    const wire = results[0] as { mode: string; dishes: Array<unknown> };
    expect(["deterministic", "empty"]).toContain(wire.mode);
  });
});

describe("agent stream failure paths", () => {
  test("typed pipeline failure emits failed terminal plus error event, then closes", async () => {
    withAgentFlag("1");
    const runtime = track(makeRuntime());

    const failing: StreamPipeline = () =>
      Effect.fail(new RecommendationMisconfigured({ reason: "test misconfiguration" }));

    const response = await runtime.runPromise(
      handleRecommendStream(streamRequest(validBody, { "x-request-id": "stream-fail-1" }), failing),
    );
    expect(response.status).toBe(200);

    const collected = await collectStream(response);
    expect(collected.results).toEqual([]);
    expect(collected.progress).toHaveLength(2);
    expect(collected.progress[0]?.terminal).toBe(false);
    expect(collected.progress[1]).toMatchObject({ stage: "failed", terminal: true });
    expect(collected.errors).toHaveLength(1);
  });

  test("client disconnect interrupts the pipeline and closes the stream", async () => {
    withAgentFlag("1");
    const runtime = track(makeRuntime());

    let interrupted = false;
    const hanging: StreamPipeline = (_input, report) =>
      Effect.gen(function* () {
        report("searching-catalog", "Scanning eligible dishes");
        yield* Effect.never.pipe(
          Effect.onInterrupt(() => Effect.sync(() => { interrupted = true; })),
        );
        return RecommendationOutcome.Empty({ reasons: ["unreachable"] });
      });

    const aborter = new AbortController();
    const request = new Request("http://localhost/api/v1/recommendations/stream", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "stream-abort-1" },
      body: JSON.stringify(validBody),
      signal: aborter.signal,
    });

    const response = await runtime.runPromise(handleRecommendStream(request, hanging));
    expect(response.status).toBe(200);

    aborter.abort();
    // The stream must settle (not hang) after disconnect.
    await response.text();
    expect(interrupted).toBe(true);
  });
});
