import { Context, Data, Duration, Effect, Layer, Match } from "effect";
import { z } from "zod";

import {
  AGENT_BOUNDS,
  RECOMMEND_AGENT_FLAG,
  type AgentToolName,
  type GetDishDetailsInput,
  type SearchDishesInput,
} from "@/modules/food-discovery/server/agent/protocol";
import { MAX_REASON_LENGTH } from "@/server/integrations/meta-client";
import type { ServerEnv } from "@/server/env";

/**
 * Agentic Muse provider transport (workstream B).
 *
 * Endpoint choice: Chat Completions (`POST {baseUrl}/chat/completions`).
 * Evidence (dev.meta.ai/docs, read 2026-11-04):
 * - The Responses API is Meta's recommended path for agents because it
 *   replays reasoning across tool turns via `previous_response_id`. Chat
 *   Completions is fully supported for function tool calling but does not
 *   carry reasoning between turns.
 * - This repository already speaks Chat Completions (`meta-client.ts`)
 *   with a proven contract: `response_format` json_schema `strict:true`,
 *   per-call `AbortSignal.timeout` combined with the Effect fiber signal,
 *   and a typed failure taxonomy with parity tests.
 * - The agent's catalog exploration (compact summaries over 2-3 rounds)
 *   restates selection criteria in every prompt, so cross-turn reasoning
 *   replay is a nice-to-have, not a requirement. Explicit client-held
 *   message history keeps conversation continuity auditable with no hidden
 *   server-side state lifecycle (`previous_response_id` expiry/memory).
 * - Unsupported-combination risk is avoided structurally: tool-exploration
 *   rounds never set `response_format`, and the final selection call sets
 *   `response_format` with `tools` omitted. `tool_choice` is left at the
 *   default (`auto` is the only supported value), so every round handles
 *   both tool calls and plain-text answers.
 *
 * Trust boundaries (transport enforces, never delegates to the model):
 * - The transport only serializes caller-built prompts and backend tool
 *   results. It never adds coordinates, raw exclusion terms, scope, or
 *   publication state; the orchestrator builds prompts and the tool
 *   services (workstream A) own eligibility enforcement.
 * - Model-produced tool arguments are untrusted external input: every call
 *   is JSON-parsed and zod-validated before the executor runs. Unknown
 *   tool names, unparseable arguments, and schema violations become
 *   bounded tool-error results the model can self-correct from, capped by
 *   MAX_MALFORMED_TOOL_CALLS (no unbounded retry).
 * - Executor failures are converted to bounded tool-error content, never
 *   fiber failures, so one bad tool call cannot kill the run. Executor
 *   reasons are truncated; tool services must keep them free of secrets
 *   and raw driver details.
 * - Every assistant `tool_call` gets exactly one `tool` result with the
 *   matching id (overflow beyond budget gets a synthetic budget error),
 *   preserving the id mapping the provider requires between rounds.
 * - Fiber interruption (client abort, deadline) propagates to the
 *   in-flight fetch via the combined AbortSignal, matching `meta-client`.
 */

/** Total orchestration budget source: protocol AGENT_BOUNDS via resolveAgentConfig. */
export const META_AGENT_CHAT_PATH = "/chat/completions";

/** Per-round fan-out cap (plan section 5 requires a per-round bound). */
export const META_AGENT_MAX_CALLS_PER_ROUND = 4;

/** Upper bound for one serialized tool result placed back into history. */
export const META_AGENT_MAX_TOOL_RESULT_BYTES = 8 * 1024;

/** Upper bound for one provider response body (tool rounds carry small payloads). */
export const META_AGENT_MAX_RESPONSE_BYTES = 64 * 1024;

/** Recoverable malformed tool calls tolerated per run before failing. */
export const MAX_MALFORMED_TOOL_CALLS = 2;

/** Truncation marker appended when a tool result exceeds its byte bound. */
export const TOOL_RESULT_TRUNCATED_SUFFIX = "…[truncated]";

export class MetaAgentAuthError extends Data.TaggedError("MetaAgentAuthError")<{
  readonly reason: string;
  readonly status: 401 | 403;
}> {}

export class MetaAgentPermanentError extends Data.TaggedError("MetaAgentPermanentError")<{
  readonly reason: string;
  readonly status: number;
}> {}

export class MetaAgentRateLimited extends Data.TaggedError("MetaAgentRateLimited")<{
  readonly reason: string;
  readonly retryAfterSeconds: number | undefined;
}> {}

export class MetaAgentRequestError extends Data.TaggedError("MetaAgentRequestError")<{
  readonly reason: string;
  readonly status?: number | undefined;
}> {}

export class MetaAgentTimeoutError extends Data.TaggedError("MetaAgentTimeoutError")<{
  readonly reason: string;
  readonly scope: "provider-call" | "orchestration";
}> {}

export class MetaAgentInvalidOutput extends Data.TaggedError("MetaAgentInvalidOutput")<{
  readonly reason: string;
}> {}

export class MetaAgentInvalidToolCall extends Data.TaggedError("MetaAgentInvalidToolCall")<{
  readonly reason: string;
}> {}

/**
 * Executor-side failure: the tool service (workstream A) maps its own
 * typed failures (including database errors) into this shape at its
 * boundary. The transport renders it as bounded tool-error content and
 * continues the loop; it never escapes as a fiber failure.
 */
export class MetaAgentToolError extends Data.TaggedError("MetaAgentToolError")<{
  readonly reason: string;
}> {}

export type MetaAgentError =
  | MetaAgentAuthError
  | MetaAgentPermanentError
  | MetaAgentRateLimited
  | MetaAgentRequestError
  | MetaAgentTimeoutError
  | MetaAgentInvalidOutput
  | MetaAgentInvalidToolCall;

export type AgentFailureDisposition = Data.TaggedEnum<{
  Fail: {};
  Fallback: { readonly warning: string };
}>;

export const AgentFailureDisposition = Data.taggedEnum<AgentFailureDisposition>();

const AGENT_RATE_LIMIT_WARNING =
  "Muse agent was rate-limited; used deterministic order instead.";

const AGENT_TRANSIENT_WARNING = "Muse agent was unavailable; used deterministic order instead.";

/** Mirror of the rank-path disposition: auth/permanent fail loudly, the rest degrade. */
export const dispositionForMetaAgentError = (error: MetaAgentError): AgentFailureDisposition =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      MetaAgentAuthError: () => AgentFailureDisposition.Fail(),
      MetaAgentPermanentError: () => AgentFailureDisposition.Fail(),
      MetaAgentRateLimited: () =>
        AgentFailureDisposition.Fallback({ warning: AGENT_RATE_LIMIT_WARNING }),
      MetaAgentRequestError: () =>
        AgentFailureDisposition.Fallback({ warning: AGENT_TRANSIENT_WARNING }),
      MetaAgentTimeoutError: () =>
        AgentFailureDisposition.Fallback({ warning: AGENT_TRANSIENT_WARNING }),
      MetaAgentInvalidOutput: () =>
        AgentFailureDisposition.Fallback({ warning: AGENT_TRANSIENT_WARNING }),
      MetaAgentInvalidToolCall: () =>
        AgentFailureDisposition.Fallback({ warning: AGENT_TRANSIENT_WARNING }),
    }),
  );

export interface MetaAgentConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly providerTimeoutMs: number;
  readonly orchestrationDeadlineMs: number;
  readonly maxTokens: number;
}

/**
 * Explicit opt-in: only the literal string "true" enables agentic mode.
 * Unset or any other value keeps the existing single-shot rank() path.
 */
export const isAgentEnabled = (env: ServerEnv): boolean =>
  env[RECOMMEND_AGENT_FLAG] === "true";

const clampAgentTimeoutMs = (value: number | undefined, fallback: number): number => {
  if (value === undefined || Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.floor(value), 1000), 60000);
};

const clampAgentDeadlineMs = (value: number | undefined, fallback: number): number => {
  if (value === undefined || Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.floor(value), 5000), 180000);
};

/**
 * Additive agent knobs over an already-resolved Muse config. Takes the Muse
 * variant (never Deterministic/Misconfigured) so misconfiguration keeps
 * failing loudly upstream instead of degrading silently here.
 */
export const agentConfigFromMuse = (
  muse: {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly modelId: string;
    readonly maxTokens: number;
  },
  env: ServerEnv,
): MetaAgentConfig => ({
  apiKey: muse.apiKey,
  baseUrl: muse.baseUrl,
  modelId: muse.modelId,
  maxTokens: muse.maxTokens,
  providerTimeoutMs: clampAgentTimeoutMs(
    env.MODEL_AGENT_TIMEOUT_MS,
    AGENT_BOUNDS.providerTimeoutMs,
  ),
  orchestrationDeadlineMs: clampAgentDeadlineMs(
    env.RECOMMEND_AGENT_DEADLINE_MS,
    AGENT_BOUNDS.orchestrationDeadlineMs,
  ),
});

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw arguments string preserved verbatim for history replay. */
  readonly argsRaw: string;
}

export interface AgentAssistantTurn {
  readonly content: string | null;
  readonly toolCalls: ReadonlyArray<AgentToolCall>;
}

export type ValidatedToolCall =
  | { readonly name: "searchDishes"; readonly args: SearchDishesInput }
  | { readonly name: "getDishDetails"; readonly args: GetDishDetailsInput };

/**
 * Tool executor contract (implemented by workstream A). Receives only
 * validated arguments; returns the JSON-encoded result payload. Services
 * validate and bound their results before serializing; the transport only
 * truncates bytes. Failures surface as MetaAgentToolError and become
 * bounded tool-error content.
 */
export type AgentToolExecutor = (
  call: ValidatedToolCall,
) => Effect.Effect<string, MetaAgentToolError>;

export interface AgentLoopRequest {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly config: MetaAgentConfig;
  readonly executeTool: AgentToolExecutor;
}

export interface AgentSelection {
  readonly dishId: string;
  readonly reason: string;
}

export interface AgentLoopResult {
  readonly selections: ReadonlyArray<AgentSelection>;
  readonly roundsUsed: number;
  readonly toolCallsUsed: number;
}

/** History wire shapes (Chat Completions messages array). */
export type AgentMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls: ReadonlyArray<{
        readonly id: string;
        readonly type: "function";
        readonly function: { readonly name: string; readonly arguments: string };
      }>;
    }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

const searchDishesArgsSchema = z.object({
  cuisine: z.string().min(1).max(120).optional(),
  category: z.string().min(1).max(120).optional(),
  query: z.string().min(1).max(200).optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const getDishDetailsArgsSchema = z.object({
  ids: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(AGENT_BOUNDS.detailsPerCall),
});

const providerToolCallSchema = z.object({
  id: z.string(),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const providerAssistantSchema = z.object({
  content: z.string().nullable().optional(),
  tool_calls: z.array(providerToolCallSchema).optional(),
  refusal: z.string().nullable().optional(),
});

const chatEnvelopeSchema = z.object({
  choices: z.array(z.object({ message: providerAssistantSchema })).min(1),
});

const agentSelectionPayloadSchema = z.object({
  selections: z
    .array(
      z.object({
        dish_id: z.string().min(1),
        reason: z.string().min(1).max(MAX_REASON_LENGTH),
      }),
    )
    .min(1)
    .max(AGENT_BOUNDS.finalLimit),
});

/**
 * Provider-facing tool definitions (Chat Completions nested format).
 * Descriptions restate the trust boundary so the model cannot mistake
 * these tools for an eligibility override: scope, exclusions, and
 * publication state are enforced server-side and are not parameters.
 */
export const AGENT_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "searchDishes",
      description:
        "Explore dishes already eligible for this diner. Optional filters only narrow within the served pool; scope, exclusions, and availability are enforced server-side. Returns compact summaries with opaque cursors.",
      parameters: {
        type: "object",
        properties: {
          cuisine: { type: "string" },
          category: { type: "string" },
          query: { type: "string" },
          cursor: { type: "string" },
          limit: { type: "integer" },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getDishDetails",
      description:
        "Inspect full details for dish IDs previously returned by searchDishes. Pass only IDs the backend already served; unknown IDs are rejected.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
        },
        required: ["ids"],
        additionalProperties: false,
      },
    },
  },
] as const;

/** Provider-facing final-selection schema (strict subset, mirrors RANKING_SCHEMA discipline). */
export const AGENT_SELECTION_SCHEMA = {
  type: "object",
  properties: {
    selections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dish_id: { type: "string" },
          reason: { type: "string", maxLength: MAX_REASON_LENGTH },
        },
        required: ["dish_id", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["selections"],
  additionalProperties: false,
} as const;

export const AGENT_SELECTION_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: { name: "agent_selection", strict: true, schema: AGENT_SELECTION_SCHEMA },
} as const;

const TOOL_ERROR_CODES = [
  "invalid_arguments",
  "unknown_tool",
  "tool_failed",
  "budget_exhausted",
  "round_limit",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

const toolErrorContent = (code: ToolErrorCode, message: string): string =>
  JSON.stringify({ error: code, message: message.slice(0, 200) });

const truncateToolResult = (value: string): string => {
  if (new TextEncoder().encode(value).length <= META_AGENT_MAX_TOOL_RESULT_BYTES) {
    return value;
  }

  const bytes = new TextEncoder().encode(value);
  const suffix = new TextDecoder().decode(new TextEncoder().encode(TOOL_RESULT_TRUNCATED_SUFFIX));

  const kept = new TextDecoder().decode(
    bytes.slice(0, META_AGENT_MAX_TOOL_RESULT_BYTES - suffix.length),
  );

  return `${kept}${TOOL_RESULT_TRUNCATED_SUFFIX}`;
};

const parseRetryAfterSeconds = (response: Response): number | undefined => {
  const raw = response.headers.get("retry-after");

  if (raw === null) {
    return undefined;
  }

  const seconds = Number.parseInt(raw, 10);

  return Number.isNaN(seconds) || seconds < 0 ? undefined : seconds;
};

/** Map a non-2xx provider status to its typed failure (status only, no body). */
const classifyStatus = (status: number): MetaAgentError => {
  if (status === 401 || status === 403) {
    return new MetaAgentAuthError({
      reason: `Muse agent rejected credentials with status ${status}`,
      status,
    });
  }

  if (status === 429) {
    return new MetaAgentRateLimited({
      reason: "Muse agent was rate-limited",
      retryAfterSeconds: undefined,
    });
  }

  if (status === 400 || status === 404 || status === 422) {
    return new MetaAgentPermanentError({
      reason: `Muse agent rejected the request with status ${status}`,
      status,
    });
  }

  return new MetaAgentRequestError({
    reason: `Muse agent request failed with status ${status}`,
    status,
  });
};

/** Exact Chat Completions request shape for the agent loop (no open dictionaries). */
export interface AgentChatRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<AgentMessage>;
  readonly max_tokens: number;
  readonly tools?: typeof AGENT_TOOL_DEFINITIONS | undefined;
  readonly response_format?: typeof AGENT_SELECTION_RESPONSE_FORMAT | undefined;
}

interface ProviderCallInput {
  readonly messages: ReadonlyArray<AgentMessage>;
  readonly withTools: boolean;
  readonly withStructuredOutput: boolean;
  readonly config: MetaAgentConfig;
}

const postToProvider = (input: ProviderCallInput): Effect.Effect<string, MetaAgentError> =>
  Effect.gen(function* () {
    const startedAt = Date.now();

    if (input.config.apiKey.length === 0) {
      return yield* new MetaAgentAuthError({
        reason: "MODEL_API_KEY is not configured",
        status: 401,
      });
    }

    let body: AgentChatRequest = {
      model: input.config.modelId,
      messages: input.messages,
      max_tokens: input.config.maxTokens,
    };

    if (input.withTools) {
      body = { ...body, tools: AGENT_TOOL_DEFINITIONS };
    }

    if (input.withStructuredOutput) {
      body = { ...body, response_format: AGENT_SELECTION_RESPONSE_FORMAT };
    }

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${input.config.baseUrl}${META_AGENT_CHAT_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${input.config.apiKey}`,
          },
          body: JSON.stringify(body),
          // Surface fiber interruption (deadline, client disconnect) to
          // the provider request instead of leaving it running.
          signal: AbortSignal.any([signal, AbortSignal.timeout(input.config.providerTimeoutMs)]),
        }),
      catch: (cause) =>
        cause instanceof DOMException && cause.name === "TimeoutError"
          ? new MetaAgentTimeoutError({
              reason: `Muse agent call timed out after ${input.config.providerTimeoutMs}ms`,
              scope: "provider-call",
            })
          : new MetaAgentRequestError({ reason: "Muse agent request failed" }),
    }).pipe(
      Effect.annotateLogs({
        backend: "muse-agent",
        modelId: input.config.modelId,
      }),
    );

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfterSeconds = parseRetryAfterSeconds(response);

        yield* Effect.logWarning("Muse agent rate-limited").pipe(
          Effect.annotateLogs({
            backend: "muse-agent",
            modelId: input.config.modelId,
            retryAfterSeconds: retryAfterSeconds ?? "absent",
          }),
        );

        return yield* new MetaAgentRateLimited({
          reason: "Muse agent was rate-limited",
          retryAfterSeconds,
        });
      }

      const failure = classifyStatus(response.status);

      yield* AgentFailureDisposition.$match(dispositionForMetaAgentError(failure), {
        Fail: () =>
          Effect.logError("Muse agent failed permanently").pipe(
            Effect.annotateLogs({
              backend: "muse-agent",
              modelId: input.config.modelId,
              status: response.status,
            }),
          ),
        Fallback: () => Effect.void,
      });

      return yield* failure;
    }

    const text: string = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new MetaAgentInvalidOutput({ reason: "Muse agent response was not readable" }),
    });

    if (new TextEncoder().encode(text).length > META_AGENT_MAX_RESPONSE_BYTES) {
      return yield* new MetaAgentInvalidOutput({
        reason: "Muse agent response exceeded the size limit",
      });
    }

    yield* Effect.logInfo("Muse agent call succeeded").pipe(
      Effect.annotateLogs({
        backend: "muse-agent",
        modelId: input.config.modelId,
        durationMs: Date.now() - startedAt,
      }),
    );

    return text;
  });

const decodeAssistantTurn = (
  bodyText: string,
): Effect.Effect<AgentAssistantTurn, MetaAgentError> => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return Effect.fail(
      new MetaAgentInvalidOutput({ reason: "Muse agent response was not JSON" }),
    );
  }

  const envelope = chatEnvelopeSchema.safeParse(parsed);

  if (!envelope.success) {
    return Effect.fail(
      new MetaAgentInvalidOutput({ reason: "Muse agent envelope was unexpected" }),
    );
  }

  const first = envelope.data.choices[0];

  if (first === undefined) {
    return Effect.fail(new MetaAgentInvalidOutput({ reason: "Muse agent contained no choices" }));
  }

  const toolCalls: Array<AgentToolCall> = [];

  for (const call of first.message.tool_calls ?? []) {
    toolCalls.push({ id: call.id, name: call.function.name, argsRaw: call.function.arguments });
  }

  return Effect.succeed({
    content: first.message.content ?? null,
    toolCalls,
  });
};

const validateToolCall = (call: AgentToolCall): ValidatedToolCall | undefined => {
  if (call.name === "searchDishes") {
    let parsedArgs: unknown;

    try {
      parsedArgs = JSON.parse(call.argsRaw);
    } catch {
      return undefined;
    }

    const decoded = searchDishesArgsSchema.safeParse(parsedArgs);

    if (!decoded.success) {
      return undefined;
    }

    return { name: "searchDishes", args: decoded.data };
  }

  if (call.name === "getDishDetails") {
    let parsedArgs: unknown;

    try {
      parsedArgs = JSON.parse(call.argsRaw);
    } catch {
      return undefined;
    }

    const decoded = getDishDetailsArgsSchema.safeParse(parsedArgs);

    if (!decoded.success) {
      return undefined;
    }

    return { name: "getDishDetails", args: decoded.data };
  }

  return undefined;
};

const isKnownTool = (name: string): name is AgentToolName =>
  name === "searchDishes" || name === "getDishDetails";

/**
 * Execute one tool round: every assistant call gets exactly one tool
 * result with the matching id. Calls beyond the remaining total budget or
 * the per-round cap receive synthetic budget errors without invoking the
 * executor; malformed calls receive bounded invalid-argument errors.
 * Returns the messages to append (assistant plus one tool message per
 * call) and whether the malformed budget was exceeded.
 */
const executeToolRound = (
  turn: AgentAssistantTurn,
  remainingBudget: number,
  executeTool: AgentToolExecutor,
): Effect.Effect<
  { readonly append: ReadonlyArray<AgentMessage>; readonly malformed: number },
  MetaAgentError
> =>
  Effect.gen(function* () {
    for (const call of turn.toolCalls) {
      if (call.id.length === 0 || call.id.length > 64) {
        return yield* new MetaAgentInvalidToolCall({
          reason: "Muse agent returned a tool call with an unusable id",
        });
      }
    }

    const append: Array<AgentMessage> = [
      {
        role: "assistant",
        content: turn.content,
        tool_calls: turn.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.argsRaw },
        })),
      },
    ];

    let malformed = 0;
    let index = 0;

    for (const call of turn.toolCalls) {
      if (index >= remainingBudget || index >= META_AGENT_MAX_CALLS_PER_ROUND) {
        append.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolErrorContent(
            index >= remainingBudget ? "budget_exhausted" : "round_limit",
            "The tool budget for this request is exhausted; no further exploration is possible.",
          ),
        });
        index += 1;
        continue;
      }

      index += 1;

      if (!isKnownTool(call.name)) {
        malformed += 1;
        append.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolErrorContent(
            "unknown_tool",
            `Unknown tool "${call.name.slice(0, 64)}"; only searchDishes and getDishDetails exist.`,
          ),
        });
        continue;
      }

      const validated = validateToolCall(call);

      if (validated === undefined) {
        malformed += 1;
        append.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolErrorContent(
            "invalid_arguments",
            "The tool arguments were invalid; retry with corrected arguments.",
          ),
        });
        continue;
      }

      const outcome = yield* executeTool(validated).pipe(
        Effect.catchIf(
          (cause) => cause instanceof MetaAgentToolError,
          (cause) =>
            Effect.succeed(
              toolErrorContent("tool_failed", `The tool call failed: ${cause.reason}`),
            ),
        ),
      );

      append.push({
        role: "tool",
        tool_call_id: call.id,
        content: truncateToolResult(outcome),
      });
    }

    return { append, malformed };
  });

const decodeFinalSelection = (
  bodyText: string,
): Effect.Effect<ReadonlyArray<AgentSelection>, MetaAgentError> => {
  let envelopeParsed: unknown;

  try {
    envelopeParsed = JSON.parse(bodyText);
  } catch {
    return Effect.fail(
      new MetaAgentInvalidOutput({ reason: "Muse agent final response was not JSON" }),
    );
  }

  const envelope = chatEnvelopeSchema.safeParse(envelopeParsed);

  if (!envelope.success) {
    return Effect.fail(
      new MetaAgentInvalidOutput({ reason: "Muse agent final envelope was unexpected" }),
    );
  }

  const first = envelope.data.choices[0];

  if (
    first === undefined ||
    first.message.content === null ||
    first.message.content === undefined
  ) {
    return Effect.fail(
      new MetaAgentInvalidOutput({ reason: "Muse agent final selection was empty" }),
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(first.message.content);
  } catch {
    return Effect.fail(
      new MetaAgentInvalidOutput({ reason: "Muse agent final selection was not JSON" }),
    );
  }

  const decoded = agentSelectionPayloadSchema.safeParse(parsed);

  if (!decoded.success) {
    return Effect.fail(
      new MetaAgentInvalidOutput({ reason: "Muse agent final selection shape was unexpected" }),
    );
  }

  return Effect.succeed(
    decoded.data.selections.map((selection) => ({
      dishId: selection.dish_id,
      reason: selection.reason,
    })),
  );
};

const runLoopInner = (request: AgentLoopRequest): Effect.Effect<AgentLoopResult, MetaAgentError> =>
  Effect.gen(function* () {
    const messages: Array<AgentMessage> = [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt },
    ];

    let toolCallsUsed = 0;
    let malformedTotal = 0;
    let roundsUsed = 0;

    for (let round = 0; round < AGENT_BOUNDS.maxRounds; round++) {
      const body = yield* postToProvider({
        messages,
        withTools: true,
        withStructuredOutput: false,
        config: request.config,
      });

      const turn = yield* decodeAssistantTurn(body);

      if (turn.toolCalls.length === 0) {
        messages.push({ role: "assistant", content: turn.content, tool_calls: [] });
        roundsUsed = round + 1;
        break;
      }

      const remaining = AGENT_BOUNDS.maxToolCalls - toolCallsUsed;
      const roundResult = yield* executeToolRound(turn, remaining, request.executeTool);

      messages.push(...roundResult.append);
      toolCallsUsed += turn.toolCalls.length;
      malformedTotal += roundResult.malformed;
      roundsUsed = round + 1;

      if (malformedTotal > MAX_MALFORMED_TOOL_CALLS) {
        return yield* new MetaAgentInvalidToolCall({
          reason: "Muse agent exceeded the malformed tool-call budget",
        });
      }
    }

    const finalBody = yield* postToProvider({
      messages,
      withTools: false,
      withStructuredOutput: true,
      config: request.config,
    });

    const selections = yield* decodeFinalSelection(finalBody);

    return { selections, roundsUsed, toolCallsUsed };
  });

/**
 * Bounded agentic loop over Chat Completions with a hard orchestration
 * deadline covering provider calls AND tool execution. The deadline
 * interrupts the source (aborting in-flight provider work) and surfaces
 * as a typed timeout the orchestrator degrades to deterministic order.
 */
export const runAgentLoop = (
  request: AgentLoopRequest,
): Effect.Effect<AgentLoopResult, MetaAgentError> =>
  Effect.timeoutOrElse(runLoopInner(request), {
    duration: Duration.millis(request.config.orchestrationDeadlineMs),
    orElse: () =>
      Effect.fail(
        new MetaAgentTimeoutError({
          reason: `Muse agent exceeded the ${request.config.orchestrationDeadlineMs}ms orchestration deadline`,
          scope: "orchestration",
        }),
      ),
  });

export class MetaAgent extends Context.Service<
  MetaAgent,
  {
    readonly runLoop: (request: AgentLoopRequest) => Effect.Effect<AgentLoopResult, MetaAgentError>;
  }
>()("feastjourney/integrations/MetaAgent") {}

export const makeMetaAgentLive = (): Layer.Layer<MetaAgent> =>
  Layer.succeed(MetaAgent, { runLoop: (request) => runAgentLoop(request) });
