import { Context, Data, Effect, Layer } from "effect";
import { z } from "zod";

import { DEFAULT_MODEL_BASE_URL } from "@/server/env";

/**
 * Muse web-research client over the Responses endpoint
 * (`POST {baseUrl}/responses`). The Chat Completions flow in
 * `meta-client.ts` is untouched; this is a separate capability with its own
 * failure vocabulary and evidence rules.
 *
 * Evidence discipline: `searchExecuted` is true ONLY when the response
 * carries actual tool-execution or citation evidence (a web_search tool block
 * with results/query context, or at least one valid cited URL). A bare
 * prose answer never counts as a search. URLs are accepted only when they
 * parse as http(s); anything else is dropped, never fabricated.
 *
 * Never log keys, prompts, or full bodies: observability carries backend,
 * model id, duration, and counts/disposition only.
 */

export const RESEARCH_MODEL_ID = "muse-spark-1.3";

export const META_RESPONSES_PATH = "/responses";

export const META_RESPONSES_BACKEND = "muse";

export const META_RESPONSES_MAX_BYTES = 24 * 1024;

export const META_RESPONSES_DEFAULT_TIMEOUT_MS = 20000;

export const META_RESPONSES_DEFAULT_MAX_SOURCES = 6;

export const META_RESPONSES_MAX_OUTPUT_TOKENS = 2000;

export const META_RESPONSES_MAX_TITLE_LENGTH = 200;

export const META_RESPONSES_MAX_SNIPPET_LENGTH = 500;

const SEARCH_FAILED_STATUSES: ReadonlySet<string> = new Set(["failed", "error", "cancelled"]);

export class MetaResponsesAuthError extends Data.TaggedError("MetaResponsesAuthError")<{
  readonly reason: string;
  readonly status: 401 | 403;
}> {}

export class MetaResponsesRateLimited extends Data.TaggedError("MetaResponsesRateLimited")<{
  readonly reason: string;
  readonly retryAfterSeconds: number | undefined;
}> {}

export class MetaResponsesRequestError extends Data.TaggedError("MetaResponsesRequestError")<{
  readonly reason: string;
  readonly status?: number | undefined;
}> {}

export class MetaResponsesInvalidOutput extends Data.TaggedError("MetaResponsesInvalidOutput")<{
  readonly reason: string;
}> {}

export type MetaResponsesError =
  | MetaResponsesAuthError
  | MetaResponsesRateLimited
  | MetaResponsesRequestError
  | MetaResponsesInvalidOutput;

export interface ResponsesSource {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface ResponsesResearchResult {
  readonly text: string;
  readonly sources: ReadonlyArray<ResponsesSource>;
  readonly searchExecuted: boolean;
  readonly modelId: string;
}

export interface MetaResponsesResearchInput {
  readonly query: string;
  readonly locale?: string | undefined;
  readonly geoCity?: string | undefined;
  readonly geoCountry?: string | undefined;
  readonly maxSources?: number | undefined;
}

export interface MetaResponsesResearch {
  readonly research: (
    input: MetaResponsesResearchInput,
  ) => Effect.Effect<ResponsesResearchResult, MetaResponsesError>;
}

export class MetaResponsesClient extends Context.Service<
  MetaResponsesClient,
  MetaResponsesResearch
>()("feastjourney/integrations/MetaResponses") {}

export interface MetaResponsesClientConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export const normalizeMetaResponsesBaseUrl = (value: string): string => value.replace(/\/+$/, "");

/**
 * Operator-owned research timeout: a valid explicitly configured value
 * flows through exactly as set; the default applies only when unset. No
 * upper bound — upstream provider limits surface as provider failures.
 * An explicitly set non-positive-integer fails loudly naming field +
 * reason instead of silently falling back.
 */
const resolveMetaResponsesTimeoutMs = (): number => {
  const raw = process.env["WEB_RESEARCH_TIMEOUT_MS"];

  if (raw === undefined) {
    return META_RESPONSES_DEFAULT_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `WEB_RESEARCH_TIMEOUT_MS must be a positive safe integer of milliseconds or unset (unset uses ${META_RESPONSES_DEFAULT_TIMEOUT_MS}).`,
    );
  }

  return parsed;
};

export const defaultMetaResponsesConfig = (): MetaResponsesClientConfig => ({
  apiKey: process.env["MODEL_API_KEY"] ?? "",
  baseUrl: normalizeMetaResponsesBaseUrl(process.env["MODEL_BASE_URL"] ?? DEFAULT_MODEL_BASE_URL),
  modelId: RESEARCH_MODEL_ID,
  timeoutMs: resolveMetaResponsesTimeoutMs(),
  maxResponseBytes: META_RESPONSES_MAX_BYTES,
});

const rawSourceSchema = z.object({
  title: z.string().catch(""),
  url: z.string().catch(""),
  snippet: z.string().catch(""),
});

const contentPartSchema = z.object({
  type: z.string().catch(""),
  text: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  snippet: z.string().optional(),
});

const outputBlockSchema = z.object({
  type: z.string().catch(""),
  status: z.string().optional(),
  query: z.string().optional(),
  text: z.string().optional(),
  results: z.array(rawSourceSchema).optional(),
  citations: z.array(rawSourceSchema).optional(),
  content: z.array(contentPartSchema).optional(),
});

const responsesEnvelopeSchema = z.object({
  output_text: z.string().catch(""),
  output: z.array(z.unknown()).catch([]),
  citations: z.array(rawSourceSchema).catch([]),
  search_results: z.array(rawSourceSchema).catch([]),
  sources: z.array(rawSourceSchema).catch([]),
});

/** Collapse whitespace runs to one line and truncate; untrusted text only. */
export const flattenResponseField = (value: string, maxLength: number): string =>
  value.replace(/\s+/g, " ").trim().slice(0, maxLength);

const toValidHttpUrl = (raw: string): string | undefined => {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }

  return parsed.toString();
};

const decodeResponsesResult = (
  body: string,
  modelId: string,
  maxSources: number,
): ResponsesResearchResult => {
  let parsedBody: unknown;

  try {
    parsedBody = JSON.parse(body);
  } catch {
    throw new MetaResponsesInvalidOutput({ reason: "The research response was not JSON." });
  }

  const envelope = responsesEnvelopeSchema.safeParse(parsedBody);

  if (!envelope.success) {
    throw new MetaResponsesInvalidOutput({ reason: "The research envelope was unexpected." });
  }

  const textParts: Array<string> = [];

  const candidates: Array<{
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
  }> = [];

  let searchExecuted = false;

  for (const block of envelope.data.output) {
    const decoded = outputBlockSchema.safeParse(block);

    if (!decoded.success) {
      continue;
    }

    const item = decoded.data;

    if (item.text !== undefined && item.text.trim().length > 0) {
      textParts.push(item.text);
    }

    for (const part of item.content ?? []) {
      if (part.text !== undefined && part.text.trim().length > 0) {
        textParts.push(part.text);
      }

      if (part.url !== undefined) {
        candidates.push({
          title: part.title ?? "",
          url: part.url,
          snippet: part.snippet ?? "",
        });
      }
    }

    for (const result of item.results ?? []) {
      candidates.push(result);
    }

    for (const citation of item.citations ?? []) {
      candidates.push(citation);
    }

    const blockType = item.type.toLowerCase();
    const status = item.status?.toLowerCase() ?? "";

    if (
      blockType.includes("web_search") &&
      !SEARCH_FAILED_STATUSES.has(status) &&
      (item.results !== undefined || item.query !== undefined || (item.citations?.length ?? 0) > 0)
    ) {
      searchExecuted = true;
    }
  }

  for (const source of envelope.data.citations) {
    candidates.push(source);
  }

  for (const source of envelope.data.search_results) {
    candidates.push(source);
  }

  for (const source of envelope.data.sources) {
    candidates.push(source);
  }

  const seen = new Set<string>();
  const sources: Array<ResponsesSource> = [];

  for (const candidate of candidates) {
    if (sources.length >= maxSources) {
      break;
    }

    const url = toValidHttpUrl(candidate.url);

    if (url === undefined || seen.has(url)) {
      continue;
    }

    seen.add(url);

    const title = flattenResponseField(candidate.title, META_RESPONSES_MAX_TITLE_LENGTH);

    sources.push({
      title: title.length === 0 ? new URL(url).hostname : title,
      url,
      snippet: flattenResponseField(candidate.snippet, META_RESPONSES_MAX_SNIPPET_LENGTH),
    });
  }

  // Citation evidence: at least one valid cited URL means search output
  // reached us, even without an explicit tool-execution block.
  if (sources.length > 0) {
    searchExecuted = true;
  }

  const envelopeText = envelope.data.output_text.trim();
  const combinedText = envelopeText.length > 0 ? envelopeText : textParts.join("\n\n").trim();

  return { text: combinedText, sources, searchExecuted, modelId };
};

const buildResponsesInput = (input: MetaResponsesResearchInput): string => {
  const contextParts: Array<string> = [];

  if (input.locale !== undefined && input.locale.length > 0) {
    contextParts.push(`locale ${input.locale}`);
  }

  if (input.geoCity !== undefined && input.geoCity.length > 0) {
    const area =
      input.geoCountry !== undefined && input.geoCountry.length > 0
        ? `${input.geoCity}, ${input.geoCountry}`
        : input.geoCity;

    contextParts.push(`area ${area}`);
  }

  if (contextParts.length === 0) {
    return input.query;
  }

  return `${input.query}\n\n[request context: ${contextParts.join("; ")}]`;
};

const buildResponsesBody = (
  config: MetaResponsesClientConfig,
  input: MetaResponsesResearchInput,
): string =>
  JSON.stringify({
    model: config.modelId,
    input: buildResponsesInput(input),
    tools: [{ type: "web_search" }],
    max_output_tokens: META_RESPONSES_MAX_OUTPUT_TOKENS,
    store: false,
  });

/** Bounded body read: aborts past maxBytes instead of buffering attacker-sized payloads. */
const readBoundedText = (
  response: Response,
  maxBytes: number,
): Effect.Effect<string, MetaResponsesError> =>
  Effect.tryPromise({
    try: async () => {
      const declared = response.headers.get("content-length");

      if (declared !== null && Number(declared) > maxBytes) {
        throw new MetaResponsesInvalidOutput({
          reason: "The research response exceeded the size limit.",
        });
      }

      if (response.body === null) {
        const fallback = await response.text();

        if (new TextEncoder().encode(fallback).length > maxBytes) {
          throw new MetaResponsesInvalidOutput({
            reason: "The research response exceeded the size limit.",
          });
        }

        return fallback;
      }

      const reader = response.body.getReader();
      const chunks: Array<Uint8Array> = [];
      let byteLength = 0;

      try {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- A stream reader advances one chunk at a time.
          const chunk = await reader.read();

          if (chunk.done) {
            break;
          }

          byteLength += chunk.value.byteLength;

          if (byteLength > maxBytes) {
            throw new MetaResponsesInvalidOutput({
              reason: "The research response exceeded the size limit.",
            });
          }

          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }

      const merged = new Uint8Array(byteLength);
      let offset = 0;

      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }

      return new TextDecoder().decode(merged);
    },
    catch: (cause) =>
      cause instanceof MetaResponsesInvalidOutput
        ? cause
        : new MetaResponsesRequestError({ reason: "The research response could not be read." }),
  });

const parseRetryAfterSeconds = (response: Response): number | undefined => {
  const raw = response.headers.get("retry-after");

  if (raw === null) {
    return undefined;
  }

  const seconds = Number.parseInt(raw, 10);

  return Number.isNaN(seconds) || seconds < 0 ? undefined : seconds;
};

const researchOnce = (
  config: MetaResponsesClientConfig,
  input: MetaResponsesResearchInput,
): Effect.Effect<ResponsesResearchResult, MetaResponsesError> =>
  Effect.gen(function* () {
    const startedAt = Date.now();

    if (config.apiKey.length === 0) {
      return yield* new MetaResponsesAuthError({
        reason: "MODEL_API_KEY is not configured",
        status: 401,
      });
    }

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${config.baseUrl}${META_RESPONSES_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: buildResponsesBody(config, input),
          // Surface fiber interruption (request timeout, client disconnect)
          // to the provider request instead of leaving it running.
          signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
        }),
      catch: () => new MetaResponsesRequestError({ reason: "Meta web research request failed" }),
    }).pipe(
      Effect.annotateLogs({
        backend: META_RESPONSES_BACKEND,
        modelId: config.modelId,
      }),
    );

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfterSeconds = parseRetryAfterSeconds(response);

        yield* Effect.logWarning("Meta web research rate-limited").pipe(
          Effect.annotateLogs({
            backend: META_RESPONSES_BACKEND,
            modelId: config.modelId,
            retryAfterSeconds: retryAfterSeconds ?? "absent",
          }),
        );

        return yield* new MetaResponsesRateLimited({
          reason: "Meta web research was rate-limited",
          retryAfterSeconds,
        });
      }

      if (response.status === 401 || response.status === 403) {
        const failure = new MetaResponsesAuthError({
          reason: `Meta web research rejected credentials with status ${response.status}`,
          status: response.status,
        });

        yield* Effect.logError("Meta web research auth failed").pipe(
          Effect.annotateLogs({
            backend: META_RESPONSES_BACKEND,
            modelId: config.modelId,
            status: response.status,
          }),
        );

        return yield* failure;
      }

      yield* Effect.logWarning("Meta web research request failed").pipe(
        Effect.annotateLogs({
          backend: META_RESPONSES_BACKEND,
          modelId: config.modelId,
          status: response.status,
        }),
      );

      return yield* new MetaResponsesRequestError({
        reason: `Meta web research request failed with status ${response.status}`,
        status: response.status,
      });
    }

    const body = yield* readBoundedText(response, config.maxResponseBytes);

    const result = decodeResponsesResult(
      body,
      config.modelId,
      input.maxSources ?? META_RESPONSES_DEFAULT_MAX_SOURCES,
    );

    yield* Effect.logInfo("Meta web research succeeded").pipe(
      Effect.annotateLogs({
        backend: META_RESPONSES_BACKEND,
        modelId: config.modelId,
        sourceCount: result.sources.length,
        textLength: result.text.length,
        searchExecuted: result.searchExecuted,
        durationMs: Date.now() - startedAt,
      }),
    );

    return result;
  });

export const makeMetaResponsesClient = (
  config: MetaResponsesClientConfig,
): MetaResponsesResearch => ({
  research: (input) => researchOnce(config, input),
});

export const makeMetaResponsesLive = (
  config: MetaResponsesClientConfig,
): Layer.Layer<MetaResponsesClient> =>
  Layer.succeed(MetaResponsesClient, makeMetaResponsesClient(config));

export const MetaResponsesLive: Layer.Layer<MetaResponsesClient> = Layer.suspend(() =>
  makeMetaResponsesLive(defaultMetaResponsesConfig()),
);
