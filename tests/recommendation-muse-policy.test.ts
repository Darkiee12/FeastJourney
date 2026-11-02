import { describe, expect, test } from "bun:test";

import { Effect } from "effect";
import { z } from "zod";

import { RankingConfig, resolveRankingConfig, type ServerEnv } from "@/server/env";
import {
  dispositionForMetaError,
  MetaAuthError,
  MetaClient,
  MetaClientLive,
  MetaInvalidOutput,
  type MetaRankCandidate,
  type MetaRankContext,
  type MuseRankingConfig,
  MetaPermanentError,
  MetaRateLimited,
  MetaRequestError,
  RankingFailureDisposition,
  type RankingResult,
} from "@/server/integrations/meta-client";

/**
 * Remediation Agent D — Muse policy + failure-mode pins.
 *
 * DB-free by design: every assertion runs against pure config/disposition
 * functions, the real MetaClientLive adapter behind a stubbed fetch, and
 * static source invariants. Nothing here touches Postgres, the network, or
 * real credentials, so this file runs anywhere `bun test` runs.
 *
 * Ownership: this file is Agent D's exclusive write surface. It must not
 * import read-only regional files' runtime modules — source files under
 * review are read as text for structural pins only.
 */

const baseEnv: ServerEnv = {
  DATABASE_URL: "postgres://user:pw@localhost:5432/db",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "at-least-32-characters-long-secret",
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  FACEBOOK_CLIENT_ID: "facebook-id",
  FACEBOOK_CLIENT_SECRET: "facebook-secret",
  SMTP_HOST: "localhost",
  SMTP_PORT: 1025,
  SMTP_USERNAME: "user",
  SMTP_PASSWORD: "pw",
  EMAIL_FROM: "test@example.com",
  TRUSTED_PROXIES: "",
};

const withOverrides = (overrides: Partial<ServerEnv>): ServerEnv => ({
  ...baseEnv,
  ...overrides,
});

const CANDIDATES: ReadonlyArray<MetaRankCandidate> = [
  { id: "101", name: "Pho", cuisines: ["vietnamese"], categories: ["dinner"], description: null },
  { id: "202", name: "Sushi", cuisines: ["japanese"], categories: ["dinner"], description: "raw" },
];

const CONTEXT: MetaRankContext = {
  occasion: "dinner",
  mood: "any",
  cuisineOrRegion: null,
  excludedIngredients: [],
};

const testConfig: MuseRankingConfig = RankingConfig.Muse({
  apiKey: "test-secret-key-xyz",
  modelId: "muse-spark-1.3",
  baseUrl: "https://api.meta.ai/v1",
  timeoutMs: 1000,
  candidateLimit: 60,
  outputLimit: 10,
  maxTokens: 4000,
});

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const asFetch = (impl: FetchImpl): typeof fetch =>
  Object.assign(impl, { preconnect: () => undefined });

const rankWithFetch = (
  fetchImpl: FetchImpl,
  config: MuseRankingConfig = testConfig,
): Promise<RankingResult> => {
  const previous = globalThis.fetch;
  globalThis.fetch = asFetch(fetchImpl);

  const program = Effect.flatMap(MetaClient, (client) =>
    client.rank(CANDIDATES, CONTEXT, config),
  ).pipe(Effect.provide(MetaClientLive));

  return Effect.runPromise(program).finally(() => {
    globalThis.fetch = previous;
  });
};

const rankEither = async (
  fetchImpl: FetchImpl,
  config: MuseRankingConfig = testConfig,
): Promise<{ readonly data: RankingResult | null; readonly error: unknown }> => {
  try {
    return { data: await rankWithFetch(fetchImpl, config), error: null };
  } catch (error) {
    return { data: null, error };
  }
};

const jsonResponse = (payload: string, status: number, retryAfter?: string): Response => {
  const headers = new Headers({ "content-type": "application/json" });

  if (retryAfter !== undefined) {
    headers.set("retry-after", retryAfter);
  }

  return new Response(payload, { status, headers });
};

const hanging: FetchImpl = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError")),
    );
  });

const successEnvelope = (ids: ReadonlyArray<string>): Response =>
  jsonResponse(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              ranked_candidate_ids: [...ids],
              reasons: ids.map((id) => `Fits the requested meal ${id}`),
            }),
          },
        },
      ],
    }),
    200,
  );

describe("guest-deterministic / signed-in Muse policy (config layer)", () => {
  test("unset provider resolves deterministic: guests never need credentials", () => {
    const config = resolveRankingConfig(withOverrides({}));

    RankingConfig.$match(config, {
      Deterministic: ({ candidateLimit, outputLimit }) => {
        expect(candidateLimit).toBe(60);
        expect(outputLimit).toBe(10);
      },
      Muse: () => expect.unreachable("unset provider must stay deterministic"),
      Misconfigured: () => expect.unreachable("unset provider must stay deterministic"),
    });
  });

  test("muse with a key resolves the signed-in ranking path with bounded cost", () => {
    const config = resolveRankingConfig(
      withOverrides({ RECOMMENDATION_PROVIDER: "muse", MODEL_API_KEY: "key" }),
    );

    RankingConfig.$match(config, {
      Deterministic: () => expect.unreachable("expected Muse"),
      Muse: ({ timeoutMs, candidateLimit, outputLimit }) => {
        expect(timeoutMs).toBeGreaterThanOrEqual(1000);
        expect(timeoutMs).toBeLessThanOrEqual(60000);
        expect(candidateLimit).toBeLessThanOrEqual(100);
        expect(outputLimit).toBeLessThanOrEqual(10);
      },
      Misconfigured: () => expect.unreachable("expected Muse"),
    });
  });

  test("muse without a key fails closed, never silent deterministic", () => {
    const config = resolveRankingConfig(withOverrides({ RECOMMENDATION_PROVIDER: "muse" }));

    RankingConfig.$match(config, {
      Deterministic: () => expect.unreachable("missing key must fail closed"),
      Muse: () => expect.unreachable("missing key must fail closed"),
      Misconfigured: ({ reason }) => expect(reason).toContain("MODEL_API_KEY"),
    });
  });
});

describe("recommend adapter resolves the verified session (actor-aware)", () => {
  test("recommendDishesFn resolves Member for signed-in sessions, Guest otherwise", async () => {
    const source = await Bun.file(
      new URL("../src/modules/food-discovery/food.functions.ts", import.meta.url).pathname,
    ).text();

    const recommendBlock = source.slice(source.indexOf("export const recommendDishesFn"));

    expect(recommendBlock).toContain("resolveSession");
    expect(recommendBlock).toContain("Actor.Member");
    expect(recommendBlock).toContain("Actor.Guest()");
  });
});

describe("MetaClientLive failure taxonomy (stubbed transport, real adapter)", () => {
  test("401 rejects as MetaAuthError and fails loudly (no fallback)", async () => {
    const { data, error } = await rankEither(() =>
      Promise.resolve(new Response("denied", { status: 401 })),
    );

    expect(data).toBeNull();
    expect(error).toBeInstanceOf(MetaAuthError);

    if (!(error instanceof MetaAuthError)) {
      expect.unreachable("expected MetaAuthError");
    }

    RankingFailureDisposition.$match(dispositionForMetaError(error), {
      Fail: () => undefined,
      Fallback: () => expect.unreachable("auth failures must fail, never degrade"),
    });
  });

  test("403 rejects as MetaAuthError and fails loudly (no fallback)", async () => {
    const { data, error } = await rankEither(() =>
      Promise.resolve(new Response("forbidden", { status: 403 })),
    );

    expect(data).toBeNull();
    expect(error).toBeInstanceOf(MetaAuthError);
  });

  test("429 degrades with the single rate-limit warning and parsed Retry-After", async () => {
    const { data, error } = await rankEither(() =>
      Promise.resolve(jsonResponse(JSON.stringify({ error: "slow down" }), 429, "30")),
    );

    expect(data).toBeNull();
    expect(error).toBeInstanceOf(MetaRateLimited);

    if (!(error instanceof MetaRateLimited)) {
      expect.unreachable("expected MetaRateLimited");
    }

    expect(error.retryAfterSeconds).toBe(30);

    RankingFailureDisposition.$match(dispositionForMetaError(error), {
      Fail: () => expect.unreachable("429 must degrade"),
      Fallback: ({ warning }) => {
        expect(warning).toContain("rate-limit");
        expect(warning).toContain("deterministic order");
      },
    });
  });

  test("5xx degrades as MetaRequestError with the generic unavailable warning", async () => {
    const { data, error } = await rankEither(() =>
      Promise.resolve(new Response("boom", { status: 503 })),
    );

    expect(data).toBeNull();
    expect(error).toBeInstanceOf(MetaRequestError);

    if (!(error instanceof MetaRequestError)) {
      expect.unreachable("expected MetaRequestError");
    }

    RankingFailureDisposition.$match(dispositionForMetaError(error), {
      Fail: () => expect.unreachable("5xx must degrade"),
      Fallback: ({ warning }) => {
        expect(warning).toContain("unavailable");
        expect(warning).toContain("deterministic order");
      },
    });
  });

  test("network failure degrades as MetaRequestError (indistinguishable from 5xx)", async () => {
    const { data, error } = await rankEither(() => Promise.reject(new TypeError("fetch failed")));

    expect(data).toBeNull();
    expect(error).toBeInstanceOf(MetaRequestError);

    if (!(error instanceof MetaRequestError)) {
      expect.unreachable("expected MetaRequestError");
    }

    expect(error.status).toBeUndefined();
  });

  test("provider timeout aborts and degrades as MetaRequestError", async () => {
    const { data, error } = await rankEither(
      hanging,
      RankingConfig.Muse({
        apiKey: "test-secret-key-xyz",
        modelId: "muse-spark-1.3",
        baseUrl: "https://api.meta.ai/v1",
        timeoutMs: 25,
        candidateLimit: 60,
        outputLimit: 10,
        maxTokens: 4000,
      }),
    );

    expect(data).toBeNull();
    expect(error).toBeInstanceOf(MetaRequestError);
  });

  test("non-JSON body degrades as MetaInvalidOutput", async () => {
    const { data, error } = await rankEither(() =>
      Promise.resolve(new Response("not json", { status: 200 })),
    );

    expect(data).toBeNull();
    expect(error).toBeInstanceOf(MetaInvalidOutput);
  });

  test("unexpected envelope degrades as MetaInvalidOutput", async () => {
    const { data, error } = await rankEither(() =>
      Promise.resolve(jsonResponse(JSON.stringify({ wrong: "shape" }), 200)),
    );

    expect(data).toBeNull();
    expect(error).toBeInstanceOf(MetaInvalidOutput);
  });

  test("non-JSON message content degrades as MetaInvalidOutput", async () => {
    const { data, error } = await rankEither(() =>
      Promise.resolve(
        jsonResponse(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), 200),
      ),
    );

    expect(data).toBeNull();
    expect(error).toBeInstanceOf(MetaInvalidOutput);
  });

  test("permanent 400 fails loudly as MetaPermanentError (no fallback)", async () => {
    const { data, error } = await rankEither(() =>
      Promise.resolve(new Response("bad request", { status: 400 })),
    );

    expect(data).toBeNull();
    expect(error).toBeInstanceOf(MetaPermanentError);

    if (!(error instanceof MetaPermanentError)) {
      expect.unreachable("expected MetaPermanentError");
    }

    RankingFailureDisposition.$match(dispositionForMetaError(error), {
      Fail: () => undefined,
      Fallback: () => expect.unreachable("permanent failures must fail, never degrade"),
    });
  });

  test("success posts the strict ranking envelope with ids only in the prompt", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const observe: FetchImpl = (input, init) => {
      capturedUrl = z.string().parse(input);
      capturedInit = init;

      return Promise.resolve(successEnvelope(["202", "101"]));
    };

    const { data, error } = await rankEither(observe);

    expect(error).toBeNull();
    expect(data).toEqual({
      ids: ["202", "101"],
      reasons: ["Fits the requested meal 202", "Fits the requested meal 101"],
    });
    expect(capturedUrl).toBe("https://api.meta.ai/v1/chat/completions");

    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-secret-key-xyz");

    const rawBody: unknown = capturedInit?.body;
    const raw = z.string().parse(rawBody);

    const body = z
      .object({
        model: z.string(),
        messages: z.array(z.object({ content: z.string() })),
        response_format: z.object({
          type: z.string(),
          json_schema: z.object({ strict: z.boolean() }),
        }),
        max_tokens: z.number(),
      })
      .parse(JSON.parse(raw));

    expect(body.model).toBe("muse-spark-1.3");
    expect(body.max_tokens).toBe(4000);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);

    const prompt = body.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("101");
    expect(prompt).toContain("202");
    // The operator key travels in the header only, never in the model body.
    expect(JSON.stringify(body)).not.toContain("test-secret-key-xyz");
  });
});

const warningOf = (error: MetaRateLimited | MetaRequestError | MetaInvalidOutput): string =>
  RankingFailureDisposition.$match(dispositionForMetaError(error), {
    Fail: () => expect.unreachable("must degrade"),
    Fallback: ({ warning }) => warning,
  });

describe("fallback-warning policy (single notice, distinct causes)", () => {
  test("every degradable failure maps to exactly one warning string", () => {
    const degradable = [
      new MetaRateLimited({ reason: "429", retryAfterSeconds: undefined }),
      new MetaRequestError({ reason: "500", status: 500 }),
      new MetaRequestError({ reason: "timeout" }),
      new MetaInvalidOutput({ reason: "bad shape" }),
    ];

    for (const failure of degradable) {
      RankingFailureDisposition.$match(dispositionForMetaError(failure), {
        Fail: () => expect.unreachable("these failures must degrade"),
        Fallback: ({ warning }) => {
          expect(warning.length).toBeGreaterThan(0);
          expect(warning).toContain("deterministic order");
        },
      });
    }
  });

  test("rate-limit and unavailable warnings are distinct; unavailable causes share one warning", () => {
    const rateLimited = warningOf(
      new MetaRateLimited({ reason: "429", retryAfterSeconds: undefined }),
    );

    const transient = warningOf(new MetaRequestError({ reason: "500", status: 500 }));
    const timeout = warningOf(new MetaRequestError({ reason: "timeout" }));
    const invalid = warningOf(new MetaInvalidOutput({ reason: "bad envelope" }));

    expect(rateLimited).not.toBe(transient);
    expect(transient).toBe(timeout);
    expect(transient).toBe(invalid);
  });
});

const QUIZ_FLOW = new URL("../src/components/home/recommend/quiz-flow.tsx", import.meta.url)
  .pathname;

const enclosingOwner = (lines: Array<string>, at: number): string => {
  for (let index = at; index >= 0; index -= 1) {
    const match = /^  (?:const (\w+)|useEffect)\b/.exec(lines[index] ?? "");

    if (match !== null) {
      return match[1] ?? "useEffect";
    }
  }

  return "<top-level>";
};

describe("provider-call sites (slide navigation must stay model-free)", () => {
  test("recommend.mutate fires only from submit/surprise/retry/restore paths", async () => {
    const source = await Bun.file(QUIZ_FLOW).text();
    const lines = source.split("\n");

    const owners = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes("recommend.mutate"))
      .map(({ index }) => enclosingOwner(lines, index));

    expect(owners.length).toBeGreaterThan(0);
    expect(owners.toSorted()).toEqual(
      ["retry", "startSearch", "surprise", "useEffect", "useEffect"].toSorted(),
    );
  });

  test("step navigation handlers never call the provider", async () => {
    const source = await Bun.file(QUIZ_FLOW).text();
    const lines = source.split("\n");

    const bodyOf = (name: string): string => {
      const start = lines.findIndex((line) => line.startsWith(`  const ${name} =`));
      expect(start).toBeGreaterThan(-1);

      let depth = 0;
      let opened = false;

      for (let index = start; index < lines.length; index += 1) {
        const line = lines[index] ?? "";

        for (const char of line) {
          if (char === "{") {
            depth += 1;
            opened = true;
          } else if (char === "}") {
            depth -= 1;
          }
        }

        if (opened && depth === 0) {
          return lines.slice(start, index + 1).join("\n");
        }
      }

      return expect.unreachable(`unbalanced body for ${name}`);
    };

    for (const handler of [
      "tryAdvance",
      "goBack",
      "backToQuiz",
      "editStep",
      "findDishes",
      "skipExclusions",
      "searchWorldwide",
      "clearSaved",
    ]) {
      expect(bodyOf(handler).includes("recommend.mutate")).toBe(false);
    }
  });
});
