import { Buffer } from "node:buffer";

import { Clock, Data, Duration, Effect, Predicate } from "effect";
import { z } from "zod";

import { DishService } from "@/modules/food-discovery/server/index";
import {
  getMenuScan,
  readMenuPhoto,
  type ScanPrincipal,
} from "@/modules/restaurant-discovery/server/operations/menu-scans";
import type { Database } from "@/server/database/client";
import { DEFAULT_MODEL_BASE_URL, isSupportedModelId } from "@/server/env";

/**
 * Food-photo identification for the copilot. The caller passes an owned
 * scan (plus an optional photo asset); bytes resolve server-side through
 * the owned scan operations, so ownership is re-verified on every call and
 * browsers never handle object-store keys. The vision model is asked for
 * dish candidates with visual evidence, then every candidate name is
 * grounded against the published catalog: only real catalog ids are
 * attached, unmatched names stay id-less, and certainty is never claimed.
 * Transport and model-output failures carry a typed retryable/category
 * taxonomy; at most one retry runs inside the shared vision budget, honoring
 * Retry-After and cancellation, reusing the already-read photo bytes.
 * Never identifies a restaurant from a food photo and never publishes
 * anything to the catalog.
 */

export const COPILOT_VISION_ENABLED_VALUE = "true";

export const COPILOT_VISION_DEFAULT_TIMEOUT_MS = 20000;

export const COPILOT_VISION_MAX_RESPONSE_BYTES = 262144;

export const COPILOT_VISION_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const COPILOT_VISION_MAX_CANDIDATES = 3;

export interface CopilotVisionConfig {
  readonly enabled: boolean;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export const resolveCopilotVisionConfig = (
  env: Record<string, string | undefined>,
): CopilotVisionConfig => {
  const timeoutRaw = env["COPILOT_VISION_TIMEOUT_MS"];
  const timeoutParsed = timeoutRaw === undefined ? Number.NaN : Number.parseInt(timeoutRaw, 10);

  return {
    enabled: env["COPILOT_VISION_ENABLED"] === COPILOT_VISION_ENABLED_VALUE,
    apiKey: env["MODEL_API_KEY"] ?? "",
    baseUrl: env["MODEL_BASE_URL"] ?? DEFAULT_MODEL_BASE_URL,
    modelId:
      env["MODEL_MODEL_ID"] !== undefined && isSupportedModelId(env["MODEL_MODEL_ID"])
        ? env["MODEL_MODEL_ID"]
        : "muse-spark-1.3",
    timeoutMs:
      Number.isNaN(timeoutParsed) || timeoutParsed < 5000 || timeoutParsed > 45000
        ? COPILOT_VISION_DEFAULT_TIMEOUT_MS
        : Math.floor(timeoutParsed),
    maxResponseBytes: COPILOT_VISION_MAX_RESPONSE_BYTES,
  };
};

/**
 * Typed vision failure taxonomy. The `_tag` stays coarse so the copilot
 * fallback mapping (by `_tag` only in `identifyFoodPhoto`) is untouched;
 * `category` carries the diagnostic distinction, `retryable` gates the
 * single bounded retry, and `reason` stays a safe user-facing message.
 * Mirrors `muse-menu.ts` without sharing its module: vision has no
 * photo-reference or extraction-schema concerns.
 */
export const visionFailureCategories = [
  "unavailable",
  "timeout",
  "rate-limited",
  "auth-rejected",
  "non-json",
  "envelope",
  "refusal",
  "truncated",
  "invalid-json",
  "schema-failure",
  "no-content",
] as const;

export type VisionFailureCategory = (typeof visionFailureCategories)[number];

export class VisionUnavailable extends Data.TaggedError("VisionUnavailable")<{
  readonly reason: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number | undefined;
  readonly status?: number | undefined;
  readonly category: Extract<
    VisionFailureCategory,
    "unavailable" | "timeout" | "rate-limited" | "auth-rejected"
  >;
}> {}

export class VisionInvalidOutput extends Data.TaggedError("VisionInvalidOutput")<{
  readonly reason: string;
  readonly retryable: boolean;
  readonly category: Extract<
    VisionFailureCategory,
    | "non-json"
    | "envelope"
    | "refusal"
    | "truncated"
    | "invalid-json"
    | "schema-failure"
    | "no-content"
  >;
  /** Safe schema issue paths only; never values, raw text, or responses. */
  readonly issues?: ReadonlyArray<string> | undefined;
  readonly finish?: string | undefined;
}> {}

export type VisionError = VisionUnavailable | VisionInvalidOutput;

export type CopilotVisionEnv = Database | DishService;

const candidatePayloadSchema = z.object({
  candidates: z
    .array(
      z.strictObject({
        name: z.string(),
        confidence: z.enum(["likely", "possible", "tentative"]),
        visual_evidence: z.string(),
      }),
    )
    .max(10),
});

const chatEnvelopeSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string(),
        message: z.object({
          content: z.string(),
          refusal: z.string().nullable().optional(),
        }),
      }),
    )
    .length(1),
});

const VISION_SYSTEM_PROMPT = [
  "Identify the dishes visible in this food photograph.",
  "This is a food photo, not a menu: never name a restaurant, venue, price, or location from it.",
  "Report only dishes with visible evidence; mark anything uncertain as possible or tentative.",
  'Respond with JSON only: {"candidates": [{"name": "<dish name>", "confidence": "likely"|"possible"|"tentative", "visual_evidence": "<one sentence>"}]}.',
  "Never invent ingredients, origins, or dietary assurances.",
].join(" ");

const flattenField = (value: string, maxLength: number): string =>
  value.replace(/\s+/g, " ").trim().slice(0, maxLength);

const normalizeName = (value: string): string => value.toLowerCase().trim();

const VISION_RETRY_BACKOFF_MS = 250;

const VISION_ATTEMPT_RESERVE_MS = 1000;

async function readBoundedVisionBody(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");

  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    controller.abort();
    throw new VisionInvalidOutput({
      reason: "The vision response was too large to read.",
      retryable: false,
      category: "truncated",
    });
  }

  if (response.body === null) {
    throw new VisionInvalidOutput({
      reason: "Food photo analysis returned an unexpected shape.",
      retryable: true,
      category: "non-json",
    });
  }

  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let byteLength = 0;

  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- A stream reader advances one chunk at a time.
      const chunk = await reader.read();

      if (chunk.done) break;

      byteLength += chunk.value.byteLength;

      if (byteLength > maxBytes) {
        controller.abort();
        throw new VisionInvalidOutput({
          reason: "The vision response was too large to read.",
          retryable: false,
          category: "truncated",
        });
      }

      chunks.push(chunk.value);
    }

    return Buffer.concat(chunks, byteLength).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

function parseVisionRetryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");

  if (raw === null) return undefined;

  const seconds = Number(raw);

  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);

  const date = Date.parse(raw);

  if (!Number.isFinite(date)) return undefined;

  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Map a non-2xx provider status to its typed failure (status only, no body). */
const classifyVisionStatus = (
  status: number,
  retryAfterSeconds: number | undefined,
): VisionUnavailable => {
  if (status === 401 || status === 403) {
    return new VisionUnavailable({
      reason: "Food photo analysis is temporarily unavailable.",
      retryable: false,
      status,
      category: "auth-rejected",
    });
  }

  if (status === 429) {
    return new VisionUnavailable({
      reason: "Food photo analysis is temporarily unavailable.",
      retryable: true,
      retryAfterSeconds,
      status,
      category: "rate-limited",
    });
  }

  if (status === 408 || status === 504) {
    return new VisionUnavailable({
      reason: "Food photo analysis timed out. Please try again.",
      retryable: true,
      retryAfterSeconds,
      status,
      category: "timeout",
    });
  }

  return new VisionUnavailable({
    reason: "Food photo analysis is temporarily unavailable.",
    retryable: status === 500 || status === 502 || status === 503,
    retryAfterSeconds,
    status,
    category: "unavailable",
  });
};

const decodeVisionPayload = (body: string): z.infer<typeof candidatePayloadSchema> => {
  let rawEnvelope: unknown;

  try {
    rawEnvelope = JSON.parse(body);
  } catch {
    throw new VisionInvalidOutput({
      reason: "Food photo analysis returned an unexpected shape.",
      retryable: true,
      category: "non-json",
    });
  }

  const envelope = chatEnvelopeSchema.safeParse(rawEnvelope);

  if (!envelope.success) {
    throw new VisionInvalidOutput({
      reason: "Food photo analysis returned an unexpected shape.",
      retryable: true,
      category: "envelope",
    });
  }

  const choice = envelope.data.choices[0];

  if (choice === undefined) {
    throw new VisionInvalidOutput({
      reason: "Food photo analysis returned an unexpected shape.",
      retryable: true,
      category: "envelope",
    });
  }

  if (choice.message.refusal) {
    throw new VisionInvalidOutput({
      reason: "No recognizable dish was found in this photo.",
      retryable: true,
      category: "refusal",
      finish: choice.finish_reason,
    });
  }

  if (choice.finish_reason !== "stop") {
    const truncated = choice.finish_reason === "length";

    throw new VisionInvalidOutput({
      reason: truncated
        ? "Food photo analysis was cut short. Please try again."
        : "No recognizable dish was found in this photo.",
      retryable: true,
      category: truncated ? "truncated" : "refusal",
      finish: choice.finish_reason,
    });
  }

  if (choice.message.content.trim().length === 0) {
    throw new VisionInvalidOutput({
      reason: "No recognizable dish was found in this photo.",
      retryable: false,
      category: "no-content",
      finish: choice.finish_reason,
    });
  }

  let rawPayload: unknown;

  try {
    rawPayload = JSON.parse(choice.message.content);
  } catch {
    throw new VisionInvalidOutput({
      reason: "Food photo analysis returned an unexpected shape.",
      retryable: true,
      category: "invalid-json",
      finish: choice.finish_reason,
    });
  }

  const payload = candidatePayloadSchema.safeParse(rawPayload);

  if (!payload.success) {
    throw new VisionInvalidOutput({
      reason: "Food photo analysis returned an unexpected shape.",
      retryable: true,
      category: "schema-failure",
      issues: payload.error.issues.map((issue) => issue.path.join(".")),
      finish: choice.finish_reason,
    });
  }

  // An empty candidate list is a valid terminal abstention, not a failure
  // worth spending a second provider call on. No invented ids: unmatched
  // names stay id-less downstream.
  if (payload.data.candidates.length === 0) {
    throw new VisionInvalidOutput({
      reason: "No recognizable dish was found in this photo.",
      retryable: false,
      category: "no-content",
      finish: choice.finish_reason,
    });
  }

  return payload.data;
};

/** Magic-byte allow-list: JPEG, PNG, WebP. Pure; never trusts MIME claims. */
const sniffVisionMediaType = (
  bytes: Uint8Array,
): "image/jpeg" | "image/png" | "image/webp" | undefined => {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return undefined;
};

const runVisionCall = (
  config: CopilotVisionConfig,
  bytes: Uint8Array,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  language: string | undefined,
): Effect.Effect<z.infer<typeof candidatePayloadSchema>, VisionError> =>
  Effect.gen(function* () {
    if (config.apiKey.length === 0) {
      return yield* new VisionUnavailable({
        reason: "Food photo analysis is not configured.",
        retryable: false,
        category: "unavailable",
      });
    }

    const base64 = Buffer.from(bytes).toString("base64");

    const attempt = Effect.tryPromise({
      try: async (signal) => {
        const controller = new AbortController();

        const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.modelId,
            messages: [
              { role: "system", content: VISION_SYSTEM_PROMPT },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text:
                      language === undefined
                        ? "Identify the dishes in this photo."
                        : `Identify the dishes in this photo. Respond in ${language}.`,
                  },
                  {
                    type: "image_url",
                    image_url: { url: `data:${mediaType};base64,${base64}` },
                  },
                ],
              },
            ],
            response_format: { type: "json_object" },
            max_tokens: 2000,
            store: false,
          }),
          // Surface fiber interruption (request timeout, client disconnect)
          // to the provider request instead of leaving it running in the
          // background. The shared Effect timeout below bounds every attempt.
          signal: AbortSignal.any([signal, controller.signal]),
        });

        if (!response.ok) {
          const retryAfterSeconds = parseVisionRetryAfterSeconds(response);

          controller.abort();

          throw classifyVisionStatus(response.status, retryAfterSeconds);
        }

        return decodeVisionPayload(
          await readBoundedVisionBody(response, config.maxResponseBytes, controller),
        );
      },
      catch: (error) => {
        if (error instanceof VisionUnavailable || error instanceof VisionInvalidOutput) {
          return error;
        }

        return new VisionUnavailable({
          reason: "Food photo analysis could not finish.",
          retryable: true,
          category: "unavailable",
        });
      },
    });

    const startedAt = yield* Clock.currentTimeMillis;
    const deadline = startedAt + config.timeoutMs;

    // Single retry layer for both transport and model-output failures: at
    // most one extra attempt inside the shared timeout budget, honoring
    // provider Retry-After and cancellation. Photograph bytes are reused,
    // never re-uploaded, and no nested retry multiplies provider calls.
    const retryOnce = (failure: VisionError) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        const backoffMs = Predicate.isTagged(failure, "VisionUnavailable")
          ? Math.max(VISION_RETRY_BACKOFF_MS, (failure.retryAfterSeconds ?? 0) * 1000)
          : VISION_RETRY_BACKOFF_MS;

        if (!failure.retryable || now + backoffMs + VISION_ATTEMPT_RESERVE_MS >= deadline) {
          return yield* failure;
        }

        yield* Effect.logInfo("Copilot vision retrying").pipe(
          Effect.annotateLogs({ category: failure.category, waitMs: backoffMs }),
        );
        yield* Effect.sleep(Duration.millis(backoffMs));

        return yield* attempt;
      });

    return yield* attempt.pipe(
      Effect.catchTags({
        VisionUnavailable: retryOnce,
        VisionInvalidOutput: retryOnce,
      }),
      // This deadline covers fetch, body consumption, backoff, and the one
      // retry. Interruption reaches fetch through tryPromise's AbortSignal;
      // the timed-out source is interrupted before the fallback runs.
      // Budget: vision timeout <= photo server-function deadline (vision
      // budget + scan-read overhead). Keep coordinated; do not raise limits.
      (operation) =>
        Effect.timeoutOrElse(operation, {
          duration: Duration.millis(config.timeoutMs),
          orElse: () =>
            Effect.fail(
              new VisionUnavailable({
                reason: "Food photo analysis timed out. Please try again.",
                retryable: true,
                category: "timeout",
              }),
            ),
        }),
    );
  });

const matchCatalogDish = (
  name: string,
): Effect.Effect<string | undefined, never, Database | DishService> =>
  Effect.gen(function* () {
    const dishes = yield* DishService.pipe(
      Effect.flatMap((service) =>
        service.searchDishes({ q: name.slice(0, 200), locale: "en", limit: 3 }),
      ),
      Effect.catch(() => Effect.succeed({ items: [], nextCursor: null })),
    );

    const wanted = normalizeName(name);

    if (wanted.length < 3) {
      return undefined;
    }

    for (const item of dishes.items) {
      const candidate = item.name !== undefined ? normalizeName(item.name) : "";

      if (
        candidate.length > 0 &&
        (candidate === wanted || candidate.includes(wanted) || wanted.includes(candidate))
      ) {
        return item.id;
      }
    }

    return undefined;
  });

export interface CopilotIdentifyPhotoRequest {
  readonly scanId: string;
  readonly assetId?: string | undefined;
  readonly language?: string | undefined;
}

export const identifyFoodPhoto = Effect.fn("copilot.identifyPhoto")(function* (
  request: CopilotIdentifyPhotoRequest,
  principal: ScanPrincipal | null,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const config = resolveCopilotVisionConfig(process.env);

  if (!config.enabled) {
    yield* Effect.logInfo("Copilot vision skipped").pipe(
      Effect.annotateLogs({ reason: "disabled" }),
    );

    return {
      candidates: [],
      unmatchedNote: "Food photo analysis is currently disabled.",
      status: "disabled",
    };
  }

  if (principal === null) {
    return {
      candidates: [],
      unmatchedNote:
        "Private scan photos cannot be identified without the signed-in owner. Open this scan in the menu scanner instead.",
      status: "auth-required",
    };
  }

  let bytes: Uint8Array | null = null;

  if (request.assetId !== undefined) {
    bytes = yield* readMenuPhoto(principal, request.scanId, request.assetId).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
  } else {
    const scan = yield* getMenuScan(principal, request.scanId).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );

    const firstReady =
      scan === null ? undefined : scan.assets.find((asset) => asset.status === "ready");

    if (firstReady !== undefined) {
      bytes = yield* readMenuPhoto(principal, request.scanId, firstReady.id).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
    }
  }

  // Magic-byte gate before any provider call: the bytes come from owned
  // scan storage, but the vision boundary never trusts stored MIME claims.
  // Unknown signatures fail closed as unreadable; the photo is preserved.
  const mediaType = bytes === null ? undefined : sniffVisionMediaType(bytes);

  if (
    bytes === null ||
    bytes.byteLength === 0 ||
    bytes.byteLength > COPILOT_VISION_MAX_IMAGE_BYTES ||
    mediaType === undefined
  ) {
    yield* Effect.logWarning("Copilot vision could not read the photo").pipe(
      Effect.annotateLogs({ readable: bytes !== null && mediaType !== undefined }),
    );

    return {
      candidates: [],
      unmatchedNote: "This photo could not be read. Try another image.",
      status: "unreadable",
    };
  }

  const payload = yield* runVisionCall(config, bytes, mediaType, request.language).pipe(
    Effect.catchTags({
      VisionUnavailable: (failure) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Copilot vision request failed").pipe(
            Effect.annotateLogs({
              category: failure.category,
              status: failure.status ?? "unknown",
            }),
          );

          return { candidates: [], failed: failure.reason } as const;
        }),
      VisionInvalidOutput: (failure) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Copilot vision output rejected").pipe(
            Effect.annotateLogs({ category: failure.category }),
          );

          return { candidates: [], failed: null } as const;
        }),
    }),
  );

  if ("failed" in payload && payload.failed !== null) {
    return { candidates: [], unmatchedNote: payload.failed, status: "unavailable" };
  }

  if ("failed" in payload || payload.candidates.length === 0) {
    return {
      candidates: [],
      unmatchedNote: "No recognizable dish was found in this photo.",
      status: "no-candidate",
    };
  }

  const grounded = yield* Effect.forEach(
    payload.candidates.slice(0, COPILOT_VISION_MAX_CANDIDATES),
    (candidate) =>
      Effect.gen(function* () {
        const name = flattenField(candidate.name, 200);
        const visualEvidence = flattenField(candidate.visual_evidence, 500);

        if (name.length === 0 || visualEvidence.length === 0) {
          return null;
        }

        const dishId = yield* matchCatalogDish(name);

        return {
          dishId,
          name,
          confidence: candidate.confidence,
          visualEvidence,
        };
      }),
    { concurrency: 2 },
  );

  const candidates = grounded.filter(
    (candidate): candidate is NonNullable<typeof candidate> => candidate !== null,
  );

  const elapsedMs = yield* Clock.currentTimeMillis.pipe(Effect.map((now) => now - startedAt));

  yield* Effect.logInfo("Copilot vision completed").pipe(
    Effect.annotateLogs({
      candidateCount: candidates.length,
      groundedCount: candidates.filter((candidate) => candidate.dishId !== undefined).length,
      durationMs: elapsedMs,
    }),
  );

  if (candidates.length === 0) {
    return {
      candidates: [],
      unmatchedNote: "No recognizable dish was found in this photo.",
      status: "no-candidate",
    };
  }

  return { candidates, status: "identified" };
});
