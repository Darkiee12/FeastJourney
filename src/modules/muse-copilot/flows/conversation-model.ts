import { Data } from "effect";
import { z } from "zod";

import {
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TURNS,
  MuseFailure,
  type CopilotContext,
  type JourneyTask,
  type MuseTurn,
  type TurnHistoryItem,
} from "@/modules/muse-copilot/journey/types";
import {
  copilotChatInputSchema,
  copilotChatOutputSchema,
  copilotIdentifyPhotoOutputSchema,
  type CopilotChatOutput,
  type CopilotIdentifyPhotoOutput,
} from "@/server/muse-copilot/copilot-schemas";
import { copilotIdentifyPhotoFn, copilotChatFn } from "@/server/muse-copilot/copilot.functions";

const DB_ID_PATTERN = /^[1-9][0-9]{0,18}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bounded turn history for the frozen contract (plan §10, addendum §6):
 * chronological, at most MAX_HISTORY_TURNS turns, each sliced to
 * MAX_HISTORY_CHARS. Failed and empty turns never enter history; photo
 * bytes, ownership tokens, and secrets never live on turns, so history is
 * text-only by construction. Server re-resolves every canonical id.
 */
export const buildTurnHistory = (
  turns: ReadonlyArray<MuseTurn>,
): ReadonlyArray<TurnHistoryItem> => {
  const items: Array<TurnHistoryItem> = [];

  for (const turn of turns) {
    if (turn.failure !== null) {
      continue;
    }

    const content = turn.text.trim().slice(0, MAX_HISTORY_CHARS);

    if (content === "") {
      continue;
    }

    items.push({ role: turn.role, content });
  }

  return items.slice(-MAX_HISTORY_TURNS);
};

/**
 * Client-side hygiene for the chat context: only canonical-shaped ids ride
 * the request (numeric dish ids, uuid venue/scan ids, bounded city/country).
 * The server still validates and authorizes everything — this only avoids
 * client-caused validation rejections for deep-link slugs.
 */
const sanitizeContext = (context: CopilotContext): CopilotContext => {
  const city =
    context.city !== undefined && context.city.trim() !== ""
      ? context.city.trim().slice(0, 120)
      : undefined;

  const country =
    context.country !== undefined && context.country.trim() !== ""
      ? context.country.trim().slice(0, 120)
      : undefined;

  const dishId =
    context.dishId !== undefined && DB_ID_PATTERN.test(context.dishId) ? context.dishId : undefined;

  const venueId =
    context.venueId !== undefined && UUID_PATTERN.test(context.venueId)
      ? context.venueId
      : undefined;

  const scanId =
    context.scanId !== undefined && UUID_PATTERN.test(context.scanId) ? context.scanId : undefined;

  return { language: context.language, city, country, dishId, venueId, scanId };
};

const parseRetryAfterSeconds = (value: string | null): number | null => {
  if (value === null) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 3600) {
    return null;
  }

  return parsed;
};

/**
 * Transport error body at the client I/O boundary: the server's structured
 * `{error, retryAfterSeconds}` shape, parsed — never asserted. Unknown
 * bodies fall back to status-only classification.
 */
const transportBodySchema = z.object({
  error: z.string().optional(),
  retryAfterSeconds: z.number().int().min(0).max(3600).optional(),
});

/**
 * Thrown Response from the transport (TanStack Start surfaces the server's
 * `Effect.die(new Response(...))` for rate-limit/unavailable paths).
 * Reads status first, then the structured code, then Retry-After.
 */
const failureFromResponse = async (response: Response): Promise<MuseFailure> => {
  const headerRetry = parseRetryAfterSeconds(response.headers.get("retry-after"));
  const parsed = transportBodySchema.safeParse(await response.json().catch(() => null));

  const code = parsed.success ? (parsed.data.error ?? "") : "";
  const bodyRetry = parsed.success ? (parsed.data.retryAfterSeconds ?? null) : null;

  if (response.status === 429 || code === "rate_limited") {
    return MuseFailure.RateLimited({ retryAfterSeconds: bodyRetry ?? headerRetry });
  }

  if (response.status === 503 || code === "temporarily_unavailable") {
    return MuseFailure.Unavailable();
  }

  if (response.status === 401 || response.status === 403) {
    return MuseFailure.AuthRequired();
  }

  return MuseFailure.InvalidOutput();
};

/** Normalized catch-site shape for the chat error classifier. */
export interface ClassifiableChatError {
  readonly message: string;
}

/**
 * Best-effort client classification of transport failures. Message matching
 * is deliberately narrow and ordered: auth first, then rate-limit,
 * unavailable, disabled, offline — unknown shapes land on InvalidOutput
 * with a safe message and manual retry. Never throws. Callers normalize
 * caught values to `ClassifiableChatError` at the catch site.
 */
export const classifyChatError = (error: ClassifiableChatError): MuseFailure => {
  const message = error.message;

  if (/sign[-_ ]?in|unauthorized|forbidden|\b401\b|\b403\b/i.test(message)) {
    return MuseFailure.AuthRequired();
  }

  if (/rate[_\s-]?limited|\b429\b/.test(message)) {
    const retry = message.match(/retry(?:-after|After)?\D{0,8}(\d{1,4})/)?.[1];

    return MuseFailure.RateLimited({
      retryAfterSeconds: retry === undefined ? null : parseRetryAfterSeconds(retry),
    });
  }

  if (/temporarily_unavailable|\b503\b|provider|timeout|timed out/.test(message)) {
    return MuseFailure.Unavailable();
  }

  if (/disabled|not configured|currently off|vision_unavailable/i.test(message)) {
    return MuseFailure.Disabled();
  }

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return MuseFailure.Transport();
  }

  if (/network|fetch|econn|load failed|offline|connection|socket/i.test(message)) {
    return MuseFailure.Transport();
  }

  return MuseFailure.InvalidOutput();
};

export type ChatSendResult = Data.TaggedEnum<{
  ChatOk: { readonly output: CopilotChatOutput };
  ChatFailed: { readonly failure: MuseFailure };
}>;

export const ChatSendResult = Data.taggedEnum<ChatSendResult>();

export interface ChatSendRequest {
  readonly message: string;
  readonly task: JourneyTask;
  readonly context: CopilotContext;
}

/**
 * Single-flight chat send. History attaches only when the peer input
 * schema accepts it: the schema is `strictObject`, so until Lane B extends
 * `copilotChatInputSchema` with the frozen `history` field the parse falls
 * back to the existing shape automatically — no flags, no double sends, no
 * client-caused validation rejections. Output always re-validates against
 * the peer contract before rendering.
 */
export const sendCopilotChat = async (
  request: ChatSendRequest,
  history: ReadonlyArray<TurnHistoryItem>,
): Promise<ChatSendResult> => {
  const context = sanitizeContext(request.context);

  const candidate = {
    message: request.message,
    task: request.task,
    context,
    history: [...history],
  };

  const gated = copilotChatInputSchema.safeParse(candidate);

  const data = gated.success
    ? gated.data
    : { message: request.message, task: request.task, context };

  try {
    const raw = await copilotChatFn({ data });
    const parsed = copilotChatOutputSchema.safeParse(raw);

    if (!parsed.success) {
      return ChatSendResult.ChatFailed({ failure: MuseFailure.InvalidOutput() });
    }

    return ChatSendResult.ChatOk({ output: parsed.data });
  } catch (error) {
    if (error instanceof Response) {
      return ChatSendResult.ChatFailed({ failure: await failureFromResponse(error) });
    }

    return ChatSendResult.ChatFailed({
      failure: classifyChatError({ message: error instanceof Error ? error.message : "" }),
    });
  }
};

export type PhotoIdentifyResult = Data.TaggedEnum<{
  PhotoReady: { readonly output: CopilotIdentifyPhotoOutput };
  PhotoFailed: { readonly failure: MuseFailure };
}>;

export const PhotoIdentifyResult = Data.taggedEnum<PhotoIdentifyResult>();

/**
 * Real vision identification (plan §13): resolves bytes server-side through
 * the owned scan, so browsers never handle object-store keys. A guest
 * soft-empty (`could not be identified without the signed-in owner`)
 * maps to AuthRequired — the plate panel gates sign-in before upload, this
 * is defense in depth. Empty candidates with a note is a result
 * (no-candidate state), not a failure.
 */
export const identifyPhoto = async (
  scanId: string,
  language: "en" | "vi",
): Promise<PhotoIdentifyResult> => {
  try {
    const raw = await copilotIdentifyPhotoFn({ data: { scanId, language } });
    const parsed = copilotIdentifyPhotoOutputSchema.safeParse(raw);

    if (!parsed.success) {
      return PhotoIdentifyResult.PhotoFailed({ failure: MuseFailure.InvalidOutput() });
    }

    const note = parsed.data.unmatchedNote ?? "";

    // Prefer the machine-readable status; the note-text fallback stays for
    // responses that predate the status field.
    const status = parsed.data.status ?? null;

    if (parsed.data.candidates.length === 0) {
      if (
        status === "auth-required" ||
        /signed-in owner|sign[-_ ]?in|unauthorized|account/i.test(note)
      ) {
        return PhotoIdentifyResult.PhotoFailed({ failure: MuseFailure.AuthRequired() });
      }

      if (status === "disabled" || /disabled|not configured|currently off/i.test(note)) {
        return PhotoIdentifyResult.PhotoFailed({ failure: MuseFailure.Disabled() });
      }
    }

    return PhotoIdentifyResult.PhotoReady({ output: parsed.data });
  } catch (error) {
    if (error instanceof Response) {
      return PhotoIdentifyResult.PhotoFailed({ failure: await failureFromResponse(error) });
    }

    return PhotoIdentifyResult.PhotoFailed({
      failure: classifyChatError({ message: error instanceof Error ? error.message : "" }),
    });
  }
};
