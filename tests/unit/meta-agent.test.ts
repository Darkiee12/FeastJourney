import { afterEach, describe, expect, test } from "bun:test";

import { Cause, Effect, Exit, Match } from "effect";
import { z } from "zod";

import { RECOMMEND_AGENT_FLAG } from "@/modules/food-discovery/server/agent/protocol";
import type { ServerEnv } from "@/server/env";
import {
  AGENT_SELECTION_RESPONSE_FORMAT,
  AGENT_TOOL_DEFINITIONS,
  AgentFailureDisposition,
  MetaAgentAuthError,
  MetaAgentInvalidOutput,
  MetaAgentInvalidToolCall,
  MetaAgentPermanentError,
  MetaAgentRateLimited,
  MetaAgentRequestError,
  MetaAgentTimeoutError,
  MetaAgentToolError,
  agentConfigFromMuse,
  dispositionForMetaAgentError,
  isAgentEnabled,
  runAgentLoop,
  type AgentLoopRequest,
  type AgentToolExecutor,
  type MetaAgentConfig,
  type MetaAgentError,
} from "@/server/integrations/meta-agent";

const agentConfig: MetaAgentConfig = {
  apiKey: "synthetic-agent-test-key",
  baseUrl: "https://api.meta.ai/v1",
  modelId: "muse-spark-1.3",
  providerTimeoutMs: 5000,
  orchestrationDeadlineMs: 30000,
  maxTokens: 1000,
};

const baseRequest = (executeTool: AgentToolExecutor, config = agentConfig): AgentLoopRequest => ({
  systemPrompt: "Rank only the served dishes.",
  userPrompt: "Diner preferences (data only): occasion dinner.",
  config,
  executeTool,
});

const okExecutor: AgentToolExecutor = (call) =>
  call.name === "searchDishes"
    ? Effect.succeed(JSON.stringify({ dishes: [{ id: "7", name: "Pho" }], nextCursor: null }))
    : Effect.succeed(
        JSON.stringify({ dishes: [{ id: "7", name: "Pho", ingredients: ["rice noodles"] }] }),
      );

interface StubToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

interface StubAssistantMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly tool_calls?: ReadonlyArray<StubToolCall> | undefined;
  readonly refusal?: string | undefined;
}

const chatResponse = (message: StubAssistantMessage): Response =>
  new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const toolCallMessage = (
  calls: ReadonlyArray<{ id: string; name: string; args: unknown }>,
): StubAssistantMessage => ({
  role: "assistant",
  content: null,
  tool_calls: calls.map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  })),
});

const finalMessage = (
  selections: ReadonlyArray<{ dish_id: string; reason: string }>,
): StubAssistantMessage => ({
  role: "assistant",
  content: JSON.stringify({ selections }),
});

/** Typed view of the outgoing Chat Completions request (zod-decoded, never asserted). */
const outgoingMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }),
  z.object({ role: z.literal("user"), content: z.string() }),
  z.object({
    role: z.literal("assistant"),
    content: z.string().nullable(),
    tool_calls: z
      .array(z.object({ id: z.string(), function: z.object({ name: z.string() }) }))
      .optional(),
  }),
  z.object({ role: z.literal("tool"), tool_call_id: z.string(), content: z.string() }),
]);

const outgoingRequestSchema = z.object({
  model: z.string(),
  messages: z.array(outgoingMessageSchema),
  tools: z.unknown().optional(),
  response_format: z.unknown().optional(),
  max_tokens: z.number(),
});

type OutgoingRequest = z.infer<typeof outgoingRequestSchema>;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const requestUrlOf = (value: string | URL | Request): string => {
  if (value instanceof Request) {
    return value.url;
  }

  if (value instanceof URL) {
    return value.href;
  }

  return value;
};

const textBodyOf = (body: BodyInit | null | undefined): string => {
  const decoded = z.string().safeParse(body);

  return decoded.success ? decoded.data : "{}";
};

const seenRawBodies: Array<string> = [];

const bodyAt = (index: number): OutgoingRequest => {
  const raw = seenRawBodies[index];

  if (raw === undefined) {
    throw new Error(`synthetic stub recorded no request at index ${index}`);
  }

  return outgoingRequestSchema.parse(JSON.parse(raw));
};

const stubFetch = (
  handler: (_url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void => {
  globalThis.fetch = Object.assign(handler, {
    preconnect: (_url: string | URL) => {
      // Synthetic stub: preconnect is irrelevant to loop semantics.
    },
  }) satisfies typeof fetch;
};

const recordingStub = (responses: ReadonlyArray<Response>) => {
  seenRawBodies.length = 0;
  let index = 0;

  stubFetch((_url, init) => {
    seenRawBodies.push(textBodyOf(init?.body));

    const response = responses[index];

    index += 1;

    if (response === undefined) {
      throw new Error("synthetic stub exhausted");
    }

    return Promise.resolve(response);
  });
};

/** Resolve the typed failure of a loop run without type assertions. */
const failureOf = (effect: Effect.Effect<unknown, MetaAgentError>): Promise<MetaAgentError> =>
  Effect.runPromise(Effect.flip(effect));

const timeoutScopeOf = (error: MetaAgentError): string =>
  Match.value(error).pipe(
    Match.tag("MetaAgentTimeoutError", (timeout) => timeout.scope),
    Match.orElse(() => "not-a-timeout"),
  );

describe("agent tool-calling loop", () => {
  test("executes one tool round then finalizes with matching tool-result ids", async () => {
    const calls: Array<string> = [];

    recordingStub([
      chatResponse(
        toolCallMessage([{ id: "call_1", name: "searchDishes", args: { query: "pho" } }]),
      ),
      chatResponse({ role: "assistant", content: "I have what I need." }),
      chatResponse(finalMessage([{ dish_id: "7", reason: "A comforting dinner pick." }])),
    ]);

    const result = await Effect.runPromise(
      runAgentLoop(
        baseRequest((call) => {
          calls.push(call.name);

          return okExecutor(call);
        }),
      ),
    );

    expect(result.selections).toEqual([{ dishId: "7", reason: "A comforting dinner pick." }]);
    expect(result.roundsUsed).toBe(2);
    expect(result.toolCallsUsed).toBe(1);
    expect(calls).toEqual(["searchDishes"]);

    const secondBody = bodyAt(1);

    expect(secondBody.tools).toEqual([...AGENT_TOOL_DEFINITIONS]);

    const toolMessage = secondBody.messages.find((entry) => entry.role === "tool");

    expect(toolMessage?.tool_call_id).toBe("call_1");
    expect(toolMessage?.content).toContain("Pho");

    const finalBody = bodyAt(2);

    expect(finalBody.response_format).toEqual({ ...AGENT_SELECTION_RESPONSE_FORMAT });
    expect(finalBody.tools).toBeUndefined();
  });

  test("multiple tool calls in one round each get an ordered matching result", async () => {
    const order: Array<string> = [];

    recordingStub([
      chatResponse(
        toolCallMessage([
          { id: "call_a", name: "searchDishes", args: { query: "pho" } },
          { id: "call_b", name: "getDishDetails", args: { ids: ["7"] } },
        ]),
      ),
      chatResponse({ role: "assistant", content: "Done exploring." }),
      chatResponse(finalMessage([{ dish_id: "7", reason: "A comforting dinner pick." }])),
    ]);

    const result = await Effect.runPromise(
      runAgentLoop(
        baseRequest((call) => {
          order.push(call.name);

          return okExecutor(call);
        }),
      ),
    );

    expect(result.toolCallsUsed).toBe(2);
    expect(order).toEqual(["searchDishes", "getDishDetails"]);

    const history = bodyAt(1).messages;
    const toolMessages = history.filter((entry) => entry.role === "tool");

    expect(toolMessages.map((entry) => entry.tool_call_id)).toEqual(["call_a", "call_b"]);
  });

  test("plain-text first response skips tool execution and finalizes", async () => {
    let executions = 0;

    recordingStub([
      chatResponse({ role: "assistant", content: "No tools needed." }),
      chatResponse(finalMessage([{ dish_id: "7", reason: "A comforting dinner pick." }])),
    ]);

    const result = await Effect.runPromise(
      runAgentLoop(
        baseRequest(() => {
          executions += 1;

          return okExecutor({ name: "searchDishes", args: {} });
        }),
      ),
    );

    expect(result.roundsUsed).toBe(1);
    expect(result.toolCallsUsed).toBe(0);
    expect(executions).toBe(0);
    expect(result.selections).toHaveLength(1);
  });

  test("refusal-shaped content finalizes; invalid final selection fails typed", async () => {
    recordingStub([
      chatResponse({ role: "assistant", content: null, refusal: "I cannot help with that." }),
      chatResponse({ role: "assistant", content: "not-json{{{ " }),
    ]);

    const error = await failureOf(runAgentLoop(baseRequest(okExecutor)));

    expect(error).toBeInstanceOf(MetaAgentInvalidOutput);
  });

  test("unknown tool names and malformed args get bounded feedback, then fail", async () => {
    let executions = 0;

    recordingStub([
      chatResponse(toolCallMessage([{ id: "call_1", name: "dropTables", args: {} }])),
      chatResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "searchDishes", arguments: "{{broken" },
          },
        ],
      }),
      chatResponse(toolCallMessage([{ id: "call_3", name: "getDishDetails", args: { ids: [] } }])),
    ]);

    const error = await failureOf(
      runAgentLoop(
        baseRequest(() => {
          executions += 1;

          return okExecutor({ name: "searchDishes", args: {} });
        }),
      ),
    );

    expect(error).toBeInstanceOf(MetaAgentInvalidToolCall);
    expect(executions).toBe(0);

    const firstTool = bodyAt(1).messages.find((entry) => entry.role === "tool");

    expect(firstTool?.tool_call_id).toBe("call_1");
    expect(firstTool?.content).toContain("unknown_tool");
  });

  test("unusable tool-call ids fail immediately without executor work", async () => {
    let executions = 0;

    recordingStub([
      chatResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "", type: "function", function: { name: "searchDishes", arguments: "{}" } },
        ],
      }),
    ]);

    const error = await failureOf(
      runAgentLoop(
        baseRequest(() => {
          executions += 1;

          return okExecutor({ name: "searchDishes", args: {} });
        }),
      ),
    );

    expect(error).toBeInstanceOf(MetaAgentInvalidToolCall);
    expect(executions).toBe(0);
  });

  test("budget overflow preserves id mapping with synthetic errors", async () => {
    const executed: Array<string> = [];

    const manyCalls = Array.from({ length: 8 }, (_value, index) => ({
      id: `call_${index}`,
      name: "searchDishes",
      args: { query: "pho" },
    }));

    recordingStub([
      chatResponse(toolCallMessage(manyCalls)),
      chatResponse(toolCallMessage([{ id: "call_late", name: "searchDishes", args: {} }])),
      chatResponse({ role: "assistant", content: "Wrapping up." }),
      chatResponse(finalMessage([{ dish_id: "7", reason: "A comforting dinner pick." }])),
    ]);

    const result = await Effect.runPromise(
      runAgentLoop(
        baseRequest((call) => {
          executed.push(call.name);

          return okExecutor(call);
        }),
      ),
    );

    expect(result.toolCallsUsed).toBe(9);
    expect(executed).toHaveLength(4);

    const secondTools = bodyAt(1).messages.filter((entry) => entry.role === "tool");
    const overflow = secondTools.find((entry) => entry.tool_call_id === "call_7");

    expect(overflow?.content).toContain("round_limit");

    const late = bodyAt(2).messages.findLast((entry) => entry.role === "tool");

    expect(late?.tool_call_id).toBe("call_late");
    expect(late?.content).toContain("budget_exhausted");
  });

  test("executor failures become bounded tool-error content and the loop continues", async () => {
    recordingStub([
      chatResponse(
        toolCallMessage([
          { id: "call_1", name: "searchDishes", args: {} },
          { id: "call_2", name: "getDishDetails", args: { ids: ["7"] } },
        ]),
      ),
      chatResponse({ role: "assistant", content: "Continuing after the error." }),
      chatResponse(finalMessage([{ dish_id: "7", reason: "A comforting dinner pick." }])),
    ]);

    const result = await Effect.runPromise(
      runAgentLoop(
        baseRequest((call) => {
          if (call.name === "searchDishes") {
            return new MetaAgentToolError({ reason: "synthetic db failure".repeat(100) });
          }

          return okExecutor(call);
        }),
      ),
    );

    expect(result.selections).toHaveLength(1);

    const toolMessages = bodyAt(1).messages.filter((entry) => entry.role === "tool");

    expect(toolMessages.map((entry) => entry.tool_call_id)).toEqual(["call_1", "call_2"]);
    expect(toolMessages[0]?.content).toEqual(
      JSON.stringify({
        error: "tool_failed",
        message: `The tool call failed: ${"synthetic db failure".repeat(100)}`.slice(0, 200),
      }),
    );
    expect(toolMessages[1]?.content).toContain("Pho");
  });
});

describe("agent transport failures", () => {
  test("provider statuses map to the typed failure taxonomy", async () => {
    const statusCases = [
      { status: 401, tag: MetaAgentAuthError },
      { status: 403, tag: MetaAgentAuthError },
      { status: 400, tag: MetaAgentPermanentError },
      { status: 429, tag: MetaAgentRateLimited },
      { status: 500, tag: MetaAgentRequestError },
    ] as const;

    await Effect.runPromise(
      Effect.gen(function* () {
        for (const { status, tag } of statusCases) {
          recordingStub([new Response("denied", { status })]);

          const error = yield* Effect.flip(runAgentLoop(baseRequest(okExecutor)));

          expect(error).toBeInstanceOf(tag);
        }
      }),
    );
  });

  test("missing choices and non-JSON bodies are invalid output", async () => {
    recordingStub([new Response(JSON.stringify({ choices: [] }), { status: 200 })]);

    const empty = await failureOf(runAgentLoop(baseRequest(okExecutor)));

    expect(empty).toBeInstanceOf(MetaAgentInvalidOutput);

    recordingStub([new Response("not json", { status: 200 })]);

    const malformed = await failureOf(runAgentLoop(baseRequest(okExecutor)));

    expect(malformed).toBeInstanceOf(MetaAgentInvalidOutput);
  });

  test("external interruption aborts the in-flight provider request", async () => {
    let aborted = false;

    stubFetch((_url, init) => {
      const signal = init?.signal;

      if (signal === undefined || signal === null) {
        return new Promise<Response>(() => {});
      }

      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("synthetic interruption"));
          },
          { once: true },
        );
      });
    });

    const result = await Effect.runPromise(
      Effect.raceFirst(
        runAgentLoop(baseRequest(okExecutor)),
        Effect.interrupt.pipe(Effect.delay("10 millis")),
      ).pipe(Effect.exit),
    );

    expect(Exit.isFailure(result)).toBe(true);

    if (!Exit.isFailure(result)) throw new Error("Expected interrupted exit");

    expect(Cause.hasInterruptsOnly(result.cause)).toBe(true);
    expect(aborted).toBe(true);
  });

  test("per-call timeout surfaces a typed provider-call timeout", async () => {
    stubFetch((_url, init) => {
      const signal = init?.signal;

      if (signal === undefined || signal === null) {
        return new Promise<Response>(() => {});
      }

      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(new DOMException("signal timed out", "TimeoutError"));
          },
          { once: true },
        );
      });
    });

    const config: MetaAgentConfig = { ...agentConfig, providerTimeoutMs: 50 };
    const error = await failureOf(runAgentLoop(baseRequest(okExecutor, config)));

    expect(error).toBeInstanceOf(MetaAgentTimeoutError);
    expect(timeoutScopeOf(error)).toBe("provider-call");
  });

  test("orchestration deadline interrupts slow tool execution", async () => {
    recordingStub([
      chatResponse(toolCallMessage([{ id: "call_1", name: "searchDishes", args: {} }])),
    ]);

    const config: MetaAgentConfig = { ...agentConfig, orchestrationDeadlineMs: 100 };

    const error = await failureOf(
      runAgentLoop(
        baseRequest(
          () => Effect.sleep("5 seconds").pipe(Effect.as(JSON.stringify({ dishes: [] }))),
          config,
        ),
      ),
    );

    expect(error).toBeInstanceOf(MetaAgentTimeoutError);
    expect(timeoutScopeOf(error)).toBe("orchestration");
  });

  test("request urls stay on the chat completions path", async () => {
    seenRawBodies.length = 0;

    const seenUrls: Array<string> = [];

    stubFetch((_url, init) => {
      seenUrls.push(requestUrlOf(_url));
      seenRawBodies.push(textBodyOf(init?.body));

      return Promise.resolve(
        seenRawBodies.length === 1
          ? chatResponse({ role: "assistant", content: "No tools needed." })
          : chatResponse(finalMessage([{ dish_id: "7", reason: "A comforting dinner pick." }])),
      );
    });

    await Effect.runPromise(runAgentLoop(baseRequest(okExecutor)));

    expect(seenUrls).toEqual([
      "https://api.meta.ai/v1/chat/completions",
      "https://api.meta.ai/v1/chat/completions",
    ]);
  });
});

describe("agent configuration", () => {
  const validEnv: ServerEnv = {
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
    RECOMMENDATION_PROVIDER: "deterministic",
  };

  test("agentic mode is explicit opt-in via the protocol flag", () => {
    expect(isAgentEnabled(validEnv)).toBe(false);
    expect(isAgentEnabled({ ...validEnv, [RECOMMEND_AGENT_FLAG]: "true" })).toBe(true);
    expect(isAgentEnabled({ ...validEnv, [RECOMMEND_AGENT_FLAG]: "1" })).toBe(false);
    expect(RECOMMEND_AGENT_FLAG).toBe("RECOMMEND_AGENT_ENABLED");
  });

  test("agent config inherits Muse credentials and preserves explicit agent timeouts", () => {
    const muse = {
      apiKey: "key",
      baseUrl: "https://api.meta.ai/v1",
      modelId: "muse-spark-1.3",
      maxTokens: 4000,
    };

    const config = agentConfigFromMuse(muse, {
      ...validEnv,
      MODEL_AGENT_TIMEOUT_MS: 5,
      RECOMMEND_AGENT_DEADLINE_MS: 9999999,
    });

    expect(config).toEqual({
      ...muse,
      providerTimeoutMs: 5,
      orchestrationDeadlineMs: 9999999,
    });

    expect(() => agentConfigFromMuse(muse, validEnv)).toThrow(z.ZodError);
    expect(() =>
      agentConfigFromMuse(muse, {
        ...validEnv,
        MODEL_AGENT_TIMEOUT_MS: 5.5,
        RECOMMEND_AGENT_DEADLINE_MS: 30000,
      }),
    ).toThrow(z.ZodError);
  });

  test("final selection schema pins the strict id-keyed contract", () => {
    expect(AGENT_SELECTION_RESPONSE_FORMAT.json_schema.name).toBe("agent_selection");
    expect(AGENT_SELECTION_RESPONSE_FORMAT.json_schema.strict).toBe(true);
    expect(AGENT_SELECTION_RESPONSE_FORMAT.json_schema.schema.required).toEqual(["selections"]);
  });

  test("auth and permanent failures fail loudly, the rest degrade", () => {
    let fails = 0;
    let fallbacks = 0;

    const cases: ReadonlyArray<{ error: MetaAgentError; loud: boolean }> = [
      { error: new MetaAgentAuthError({ reason: "denied", status: 401 }), loud: true },
      { error: new MetaAgentPermanentError({ reason: "rejected", status: 400 }), loud: true },
      {
        error: new MetaAgentRateLimited({ reason: "limited", retryAfterSeconds: undefined }),
        loud: false,
      },
      { error: new MetaAgentRequestError({ reason: "boom", status: 503 }), loud: false },
      {
        error: new MetaAgentTimeoutError({ reason: "slow", scope: "orchestration" }),
        loud: false,
      },
      { error: new MetaAgentInvalidOutput({ reason: "bad shape" }), loud: false },
      { error: new MetaAgentInvalidToolCall({ reason: "bad call" }), loud: false },
    ];

    for (const { error, loud } of cases) {
      AgentFailureDisposition.$match(dispositionForMetaAgentError(error), {
        Fail: () => {
          fails += 1;
          expect(loud).toBe(true);
        },
        Fallback: ({ warning }) => {
          fallbacks += 1;
          expect(loud).toBe(false);
          expect(warning).toContain("deterministic order");
        },
      });
    }

    expect(fails).toBe(2);
    expect(fallbacks).toBe(5);
  });
});
