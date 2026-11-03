import { Buffer } from "node:buffer";

import { Data, Effect } from "effect";
import { z } from "zod";

import { DishService } from "@/modules/food-discovery/server/index";
import {
  getMenuScan,
  readMenuPhoto,
  type ScanPrincipal,
} from "@/modules/restaurant-discovery/server/operations/menu-scans";
import { Actor } from "@/server/auth/actor";
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

export class VisionUnavailable extends Data.TaggedError("VisionUnavailable")<{
  readonly reason: string;
}> {}

export class VisionInvalidOutput extends Data.TaggedError("VisionInvalidOutput")<{
  readonly reason: string;
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
        message: z.object({ content: z.string() }),
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

const runVisionCall = (
  config: CopilotVisionConfig,
  bytes: Uint8Array,
  language: string | undefined,
): Effect.Effect<z.infer<typeof candidatePayloadSchema>, VisionError> =>
  Effect.gen(function* () {
    if (config.apiKey.length === 0) {
      return yield* new VisionUnavailable({ reason: "Food photo analysis is not configured." });
    }

    const base64 = Buffer.from(bytes).toString("base64");

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
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
                    image_url: { url: `data:image/jpeg;base64,${base64}` },
                  },
                ],
              },
            ],
            response_format: { type: "json_object" },
            max_tokens: 2000,
            store: false,
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
        }),
      catch: () => new VisionUnavailable({ reason: "Food photo analysis could not finish." }),
    }).pipe(
      Effect.annotateLogs({
        backend: "muse",
        modelId: config.modelId,
        operation: "copilot-vision",
      }),
    );

    if (!response.ok) {
      yield* Effect.logWarning("Copilot vision request failed").pipe(
        Effect.annotateLogs({ status: response.status }),
      );

      return yield* new VisionUnavailable({
        reason: "Food photo analysis is temporarily unavailable.",
      });
    }

    const declared = response.headers.get("content-length");

    if (declared !== null && Number(declared) > config.maxResponseBytes) {
      return yield* new VisionInvalidOutput({
        reason: "The vision response was too large to read.",
      });
    }

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new VisionUnavailable({ reason: "Food photo analysis could not be read." }),
    });

    if (new TextEncoder().encode(body).length > config.maxResponseBytes) {
      return yield* new VisionInvalidOutput({
        reason: "The vision response was too large to read.",
      });
    }

    let rawEnvelope: unknown;

    try {
      rawEnvelope = JSON.parse(body);
    } catch {
      return yield* new VisionInvalidOutput({
        reason: "Food photo analysis returned an unexpected shape.",
      });
    }

    const envelope = chatEnvelopeSchema.safeParse(rawEnvelope);

    if (!envelope.success) {
      return yield* new VisionInvalidOutput({
        reason: "Food photo analysis returned an unexpected shape.",
      });
    }

    const content = envelope.data.choices[0]?.message.content;

    if (content === undefined) {
      return yield* new VisionInvalidOutput({
        reason: "Food photo analysis returned no content.",
      });
    }

    let rawPayload: unknown;

    try {
      rawPayload = JSON.parse(content);
    } catch {
      return yield* new VisionInvalidOutput({
        reason: "Food photo analysis returned an unexpected shape.",
      });
    }

    const payload = candidatePayloadSchema.safeParse(rawPayload);

    if (!payload.success) {
      return yield* new VisionInvalidOutput({
        reason: "Food photo analysis returned an unexpected shape.",
      });
    }

    return payload.data;
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
  actor: Actor,
) {
  const startedAt = Date.now();
  const config = resolveCopilotVisionConfig(process.env);

  if (!config.enabled) {
    yield* Effect.logInfo("Copilot vision skipped").pipe(
      Effect.annotateLogs({ reason: "disabled" }),
    );

    return { candidates: [], unmatchedNote: "Food photo analysis is currently disabled." };
  }

  const principal: ScanPrincipal | null = Actor.$match(actor, {
    Guest: () => null,
    Member: ({ userId }) => ({ userId, guestHash: "" }),
  });

  if (principal === null) {
    return {
      candidates: [],
      unmatchedNote:
        "Private scan photos cannot be identified without the signed-in owner. Open this scan in the menu scanner instead.",
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

  if (
    bytes === null ||
    bytes.byteLength === 0 ||
    bytes.byteLength > COPILOT_VISION_MAX_IMAGE_BYTES
  ) {
    yield* Effect.logWarning("Copilot vision could not read the photo").pipe(
      Effect.annotateLogs({ readable: bytes !== null }),
    );

    return { candidates: [], unmatchedNote: "This photo could not be read. Try another image." };
  }

  const payload = yield* runVisionCall(config, bytes, request.language).pipe(
    Effect.catchTags({
      VisionUnavailable: (failure) =>
        Effect.succeed({ candidates: [], failed: failure.reason } as const),
      VisionInvalidOutput: () => Effect.succeed({ candidates: [], failed: null } as const),
    }),
  );

  if ("failed" in payload && payload.failed !== null) {
    return { candidates: [], unmatchedNote: payload.failed };
  }

  if ("failed" in payload || payload.candidates.length === 0) {
    return { candidates: [], unmatchedNote: "No recognizable dish was found in this photo." };
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

  yield* Effect.logInfo("Copilot vision completed").pipe(
    Effect.annotateLogs({
      candidateCount: candidates.length,
      groundedCount: candidates.filter((candidate) => candidate.dishId !== undefined).length,
      durationMs: Date.now() - startedAt,
    }),
  );

  if (candidates.length === 0) {
    return {
      candidates: [],
      unmatchedNote: "No recognizable dish was found in this photo.",
    };
  }

  return { candidates };
});
