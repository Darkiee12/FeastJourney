import { Context, Data, Effect, Layer, Match, Option, Schema } from "effect";

import type {
  MealOccasion,
  RecommendationMood,
} from "@/modules/food-discovery/recommendation.constants";
import type { RankingConfig } from "@/server/env";

/**
 * Typed failures for the Muse ranking integration. HTTP status drives the
 * disposition (see dispositionForMetaError): 401/403 and malformed requests
 * are caller/operator problems that must surface loudly, while 429, 5xx,
 * timeouts, and network failures degrade to deterministic order. A
 * well-formed HTTP response whose body is not the expected ranking envelope
 * surfaces as MetaInvalidOutput (fallback + warning). The client never
 * retries 401/403 or schema-invalid responses.
 *
 * Never log keys, headers, or prompts: observability carries backend, model
 * id, counts, duration, and fallback reason only.
 */
export class MetaAuthError extends Data.TaggedError("MetaAuthError")<{
  readonly reason: string;
  readonly status: 401 | 403;
}> {}

export class MetaPermanentError extends Data.TaggedError("MetaPermanentError")<{
  readonly reason: string;
  readonly status: number;
}> {}

export class MetaRateLimited extends Data.TaggedError("MetaRateLimited")<{
  readonly reason: string;
  readonly retryAfterSeconds: number | undefined;
}> {}

export class MetaRequestError extends Data.TaggedError("MetaRequestError")<{
  readonly reason: string;
  readonly status?: number | undefined;
}> {}

export class MetaInvalidOutput extends Data.TaggedError("MetaInvalidOutput")<{
  readonly reason: string;
}> {}

export type MetaError =
  | MetaAuthError
  | MetaPermanentError
  | MetaRateLimited
  | MetaRequestError
  | MetaInvalidOutput;

/**
 * Pure failure-disposition table: which provider failures fail the request
 * loudly (auth/permanent/config problems are observable as HTTP 500) and
 * which degrade to deterministic order with a client-visible warning.
 * Unit-tested without a database in tests/unit/recommendation-config.test.ts.
 */
export type RankingFailureDisposition = Data.TaggedEnum<{
  Fail: {};
  Fallback: { readonly warning: string };
}>;

export const RankingFailureDisposition = Data.taggedEnum<RankingFailureDisposition>();

const RATE_LIMIT_WARNING = "AI ranking was rate-limited; used deterministic order instead.";

const TRANSIENT_FALLBACK_WARNING = "AI ranking was unavailable; used deterministic order instead.";

export const dispositionForMetaError = (error: MetaError): RankingFailureDisposition =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      MetaAuthError: () => RankingFailureDisposition.Fail(),
      MetaPermanentError: () => RankingFailureDisposition.Fail(),
      MetaRateLimited: () => RankingFailureDisposition.Fallback({ warning: RATE_LIMIT_WARNING }),
      MetaRequestError: () =>
        RankingFailureDisposition.Fallback({ warning: TRANSIENT_FALLBACK_WARNING }),
      MetaInvalidOutput: () =>
        RankingFailureDisposition.Fallback({ warning: TRANSIENT_FALLBACK_WARNING }),
    }),
  );

export interface MetaRankCandidate {
  readonly id: string;
  readonly name: string;
  readonly cuisines: ReadonlyArray<string>;
  readonly categories: ReadonlyArray<string>;
  readonly description: string | null;
}

export interface MetaRankContext {
  readonly occasion: MealOccasion;
  readonly mood: RecommendationMood;
  readonly cuisineOrRegion: string | null;
  /**
   * Raw diner exclusion terms for ordering guidance only (user-message
   * text, never system instructions). Eligibility is enforced in SQL
   * before ranking; the model never claims safety.
   */
  readonly excludedIngredients: ReadonlyArray<string>;
}

export type MuseRankingConfig = Extract<RankingConfig, { readonly _tag: "Muse" }>;

export class MetaClient extends Context.Service<
  MetaClient,
  {
    readonly rank: (
      candidates: ReadonlyArray<MetaRankCandidate>,
      context: MetaRankContext,
      config: MuseRankingConfig,
    ) => Effect.Effect<ReadonlyArray<string>, MetaError>;
  }
>()("feastjourney/integrations/MetaClient") {}

const ChatEnvelope = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.String }),
    }),
  ),
});

const RankingPayload = Schema.Struct({
  ranked_candidate_ids: Schema.Array(Schema.String),
});

export type RankingPayload = typeof RankingPayload.Type;

/** Decode untrusted provider JSON into the canonical ranking contract. */
export const decodeRankingPayload = Schema.decodeUnknownOption(RankingPayload);

/**
 * Provider-facing JSON Schema for the ranking response. Kept as the
 * smallest explicit schema the endpoint accepts; parity with
 * RankingPayload is enforced by tests/unit/meta-schema-parity.test.ts.
 * Never inject candidate IDs as enum values (schema size limits).
 * The envelope below pins strict:true: the schema already satisfies the
 * strict subset (plain object, additionalProperties false, every property
 * listed in required).
 */
export const RANKING_SCHEMA = {
  type: "object",
  properties: {
    ranked_candidate_ids: { type: "array", items: { type: "string" } },
  },
  required: ["ranked_candidate_ids"],
  additionalProperties: false,
} as const;

/** Exact request envelope sent to the provider; strict pin asserted in tests. */
export const RANKING_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: { name: "dish_ranking", strict: true, schema: RANKING_SCHEMA },
} as const;

const SYSTEM_PROMPT = [
  "You rank restaurant dishes for a diner.",
  "Rank ONLY the dish IDs supplied in the user message.",
  "Never invent, add, or rename dishes.",
  "Never make safety, allergy, or medical claims.",
  "Respect the diner's listed ingredient exclusions when ordering; never claim safety.",
  "Respond with JSON only, matching the requested schema.",
].join(" ");

const buildUserPrompt = (
  candidates: ReadonlyArray<MetaRankCandidate>,
  context: MetaRankContext,
): string => {
  const lines = candidates.map(
    (candidate) =>
      `- id: ${candidate.id} | name: ${candidate.name} | cuisines: ${candidate.cuisines.join(",")} | categories: ${candidate.categories.join(",")} | description: ${candidate.description ?? ""}`,
  );

  return [
    `Occasion: ${context.occasion}; mood: ${context.mood}; cuisine or region: ${context.cuisineOrRegion ?? "any"}.`,
    `Ingredients to avoid: ${context.excludedIngredients.join(", ") || "none"}.`,
    "Rank the most suitable dish IDs first and return at most the requested count.",
    ...lines,
  ].join("\n");
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
const classifyStatus = (status: number): MetaError => {
  if (status === 401 || status === 403) {
    return new MetaAuthError({
      reason: `Meta ranking rejected credentials with status ${status}`,
      status,
    });
  }

  if (status === 429) {
    return new MetaRateLimited({
      reason: "Meta ranking was rate-limited",
      retryAfterSeconds: undefined,
    });
  }

  if (status === 400 || status === 404 || status === 422) {
    return new MetaPermanentError({
      reason: `Meta ranking rejected the request with status ${status}`,
      status,
    });
  }

  return new MetaRequestError({
    reason: `Meta ranking request failed with status ${status}`,
    status,
  });
};

export const MetaClientLive = Layer.succeed(MetaClient, {
  rank: (candidates, context, config) =>
    Effect.gen(function* () {
      const startedAt = Date.now();
      const apiKey = config.apiKey;

      if (apiKey.length === 0) {
        return yield* new MetaAuthError({
          reason: "MODEL_API_KEY is not configured",
          status: 401,
        });
      }

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`${config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: config.modelId,
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: buildUserPrompt(candidates, context) },
              ],
              response_format: RANKING_RESPONSE_FORMAT,
              max_tokens: config.maxTokens,
            }),
            signal: AbortSignal.timeout(config.timeoutMs),
          }),
        catch: () => new MetaRequestError({ reason: "Meta ranking request failed" }),
      }).pipe(
        Effect.annotateLogs({
          backend: "muse",
          modelId: config.modelId,
          candidateCount: candidates.length,
        }),
      );

      if (!response.ok) {
        if (response.status === 429) {
          const retryAfterSeconds = parseRetryAfterSeconds(response);

          // Retry-After is captured for observability only. The server-fn
          // transport strips non-allowlisted headers (Retry-After is lost),
          // so the service degrades to deterministic order with a
          // rate-limit warning instead of pretending to propagate 429.
          yield* Effect.logWarning("Meta ranking rate-limited").pipe(
            Effect.annotateLogs({
              backend: "muse",
              modelId: config.modelId,
              retryAfterSeconds: retryAfterSeconds ?? "absent",
            }),
          );

          return yield* new MetaRateLimited({
            reason: "Meta ranking was rate-limited",
            retryAfterSeconds,
          });
        }

        const failure = classifyStatus(response.status);

        yield* RankingFailureDisposition.$match(dispositionForMetaError(failure), {
          Fail: () =>
            Effect.logError("Meta ranking failed permanently").pipe(
              Effect.annotateLogs({
                backend: "muse",
                modelId: config.modelId,
                status: response.status,
              }),
            ),
          Fallback: () => Effect.void,
        });

        return yield* failure;
      }

      const body: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => new MetaInvalidOutput({ reason: "Meta ranking response was not JSON" }),
      });

      const envelope = Schema.decodeUnknownOption(ChatEnvelope)(body);

      if (Option.isNone(envelope)) {
        return yield* new MetaInvalidOutput({ reason: "Meta ranking envelope was unexpected" });
      }

      const content = envelope.value.choices[0]?.message.content;

      if (content === undefined) {
        return yield* new MetaInvalidOutput({ reason: "Meta ranking contained no choices" });
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(content);
      } catch {
        return yield* new MetaInvalidOutput({ reason: "Meta ranking content was not JSON" });
      }

      const payload = Schema.decodeUnknownOption(RankingPayload)(parsed);

      if (Option.isNone(payload)) {
        return yield* new MetaInvalidOutput({ reason: "Meta ranking shape was unexpected" });
      }

      yield* Effect.logInfo("Meta ranking succeeded").pipe(
        Effect.annotateLogs({
          backend: "muse",
          modelId: config.modelId,
          candidateCount: candidates.length,
          returnedCount: payload.value.ranked_candidate_ids.length,
          durationMs: Date.now() - startedAt,
        }),
      );

      return payload.value.ranked_candidate_ids;
    }),
});
