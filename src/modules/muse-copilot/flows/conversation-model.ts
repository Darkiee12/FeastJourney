import { Data } from "effect";
import { z } from "zod";

import {
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TURNS,
  MuseAction,
  MuseFailure,
  journeyTasks,
  museActionFromContract,
  type CopilotContext,
  type JourneyTask,
  type MuseTurn,
  type SuggestedAction,
  type TurnHistoryItem,
} from "@/modules/muse-copilot/journey/types";
import {
  copilotActionSchema,
  copilotCardSchema,
  copilotChatInputSchema,
  copilotChatOutputSchema,
  copilotIdentifyPhotoOutputSchema,
  type CopilotAction,
  type CopilotChatOutput,
  type CopilotIdentifyPhotoOutput,
} from "@/server/muse-copilot/copilot-schemas";
import { copilotIdentifyPhotoFn, copilotChatFn } from "@/server/muse-copilot/copilot.functions";
import type { Locale } from "@/shared/i18n";

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
 * Single-flight chat send. History ships alongside the latest message under
 * the frozen bounded contract (chronological, ≤6 turns × ≤2000 chars);
 * the input schema is `strictObject`, so if a peer build ever drops the
 * `history` field the parse falls back to the history-less shape
 * automatically — no flags, no double sends, no client-caused validation
 * rejections. Output always re-validates against the peer contract before
 * rendering. Canonical ids in history are never trusted as facts: the
 * server re-resolves every dish/venue/scan id with current authorization.
 *
 * Cancellation: callers may pass an AbortSignal (the workspace aborts it on
 * unmount/Start Over). When the platform cannot cancel the underlying
 * request the run-id guard in the workspace still rejects the stale result,
 * so a late answer never lands on a newer question.
 */
export const sendCopilotChat = async (
  request: ChatSendRequest,
  history: ReadonlyArray<TurnHistoryItem>,
  options?: { readonly signal?: AbortSignal | undefined },
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
    const raw = await copilotChatFn({ data, signal: options?.signal });
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
  language: Locale,
  options?: { readonly signal?: AbortSignal | undefined },
): Promise<PhotoIdentifyResult> => {
  try {
    const raw = await copilotIdentifyPhotoFn({
      data: { scanId, language },
      signal: options?.signal,
    });

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

/**
 * Workspace exchange lifecycle (plan §8). One exhaustive TaggedEnum instead
 * of `busy`/`retryTurnId`/`retryAfterSeconds` soup: Sending carries the
 * resend key, AwaitingRetry carries the exact failed assistant turn plus
 * its Retry-After. Viewport props derive from a single `$match`.
 *
 * Resend keys: the key is the assistant-turn id the attempt resolves
 * (`a-<n>` for a fresh send, reused on retry). Retry replaces that turn in
 * place and never appends a second user turn, so rapid taps cannot fork
 * the thread; the server coherence cache (actor-scoped, 30s TTL) dedupes
 * identical in-flight retries that do reach the network.
 */
export type ExchangeStatus = Data.TaggedEnum<{
  Idle: {};
  Sending: { readonly resendKey: string };
  AwaitingRetry: {
    readonly assistantTurnId: string;
    readonly retryAfterSeconds: number | null;
  };
}>;

export const ExchangeStatus = Data.taggedEnum<ExchangeStatus>();

/**
 * Serializable chat retry (plan §§10/18): message plus task only — no
 * thunks, no File handles, no tokens. Photo retries are NOT serializable
 * (the picked File cannot cross a reload), so only chat failures persist a
 * retry; photo failures restore as context-preserving history without a
 * retry affordance and the visitor re-picks the photo (resubmission).
 * Retried sends rebuild history and context at retry time (revalidation),
 * never replay a stale snapshot.
 */
export interface ChatRetryRequest {
  readonly message: string;
  readonly task: JourneyTask;
}

export const chatRetryRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(2000),
  task: z.enum(journeyTasks),
});

export interface StoredChatRetry extends ChatRetryRequest {
  readonly assistantTurnId: string;
  readonly retryAfterSeconds: number | null;
}

const storedChatRetrySchema = chatRetryRequestSchema.extend({
  assistantTurnId: z.string().min(1).max(64),
  retryAfterSeconds: z.number().int().min(0).max(3600).nullable(),
});

/** Serializable form of MuseFailure for session storage (never functions). */
const museFailureStorageSchema = z.discriminatedUnion("_tag", [
  z.strictObject({ _tag: z.literal("Transport") }),
  z.strictObject({
    _tag: z.literal("RateLimited"),
    retryAfterSeconds: z.number().int().min(0).max(3600).nullable(),
  }),
  z.strictObject({ _tag: z.literal("Unavailable") }),
  z.strictObject({ _tag: z.literal("InvalidOutput") }),
  z.strictObject({ _tag: z.literal("AuthRequired") }),
  z.strictObject({ _tag: z.literal("Disabled") }),
]);

const MAX_STORED_TURNS = 20;

const MAX_STORED_CHARS = 2000;

export const MUSE_THREAD_STORAGE_PREFIX = "fj.muse-thread.v1.";

/**
 * Identity- and language-scoped storage key. The route builds `storageKey`
 * as `<identity>:<lang>` (member id or `guest`), so two accounts never
 * share a thread even in the same tab session.
 */
export const museThreadStorageKey = (storageKey: string): string =>
  `${MUSE_THREAD_STORAGE_PREFIX}${storageKey}`;

/**
 * Account isolation sweep (plan §10, addendum §6): on mount, drop threads
 * belonging to a different identity while keeping this identity's other
 * language. Sign-out and account switching therefore cannot leak the
 * previous account's conversation into the new session. Same-tab concurrent
 * accounts are last-writer-wins by design — documented, not solved.
 */
export const sweepForeignThreads = (storageKey: string): void => {
  if (typeof window === "undefined") {
    return;
  }

  const current = museThreadStorageKey(storageKey);
  const identity = storageKey.split(":")[0] ?? storageKey;
  const ownedPrefix = `${MUSE_THREAD_STORAGE_PREFIX}${identity}:`;

  try {
    const doomed: Array<string> = [];

    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);

      if (
        key !== null &&
        key.startsWith(MUSE_THREAD_STORAGE_PREFIX) &&
        key !== current &&
        !key.startsWith(ownedPrefix)
      ) {
        doomed.push(key);
      }
    }

    for (const key of doomed) {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Private mode: the live thread still works for the session.
  }
};

const storedTurnSchema = z.object({
  id: z.string().min(1).max(64),
  role: z.enum(["user", "assistant"]),
  text: z.string().max(4000).default(""),
  cards: z.array(copilotCardSchema).default([]),
  followUps: z.array(z.string()).default([]),
  actions: z.array(copilotActionSchema).default([]),
  notice: z.string().nullable().default(null),
  failure: museFailureStorageSchema.nullable().default(null),
  /** Legacy flag from the pre-retry schema; only used to drop legacy failures. */
  failed: z.boolean().default(false),
  synthesized: z.boolean().default(false),
});

const storedThreadSchema = z.object({
  turns: z.array(storedTurnSchema).default([]),
  labels: z.array(z.tuple([z.string(), z.string()])).default([]),
  draft: z.string().max(4000).default(""),
  retry: storedChatRetrySchema.nullable().default(null),
});

export interface RestoredThread {
  readonly turns: ReadonlyArray<MuseTurn>;
  readonly labels: ReadonlyArray<readonly [string, string]>;
  readonly draft: string;
  readonly retry: StoredChatRetry | null;
}

const EMPTY_THREAD: RestoredThread = { turns: [], labels: [], draft: "", retry: null };

/**
 * Reverse mapper for persistence: assistant turns carry client
 * `SuggestedAction` outcomes, but storage keeps the contract shape so a
 * reload re-validates through `copilotActionSchema` exactly like fresh
 * server output. `OpenRoute`/`SetContext` have no contract equivalent and
 * can never arrive from the server mapper — they drop instead of inventing
 * a contract kind.
 */
const contractFromSuggested = (suggested: SuggestedAction): CopilotAction | null =>
  MuseAction.$match(suggested.action, {
    AskQuestion: ({ question }): CopilotAction => ({
      kind: "ask",
      label: suggested.label,
      question,
    }),
    BrowseDishes: (): CopilotAction => ({ kind: "browseDishes", label: suggested.label }),
    FindRestaurants: ({ dishId }): CopilotAction => ({
      kind: "findRestaurants",
      label: suggested.label,
      dishId,
    }),
    OpenOrder: ({ venueId, scanId }): CopilotAction => ({
      kind: "openOrder",
      label: suggested.label,
      venueId,
      scanId,
    }),
    ResumeScan: ({ scanId }): CopilotAction => ({
      kind: "resumeScan",
      label: suggested.label,
      scanId,
    }),
    OpenTool: ({ tool }): CopilotAction => ({ kind: "openTool", label: suggested.label, tool }),
    OpenRoute: () => null,
    SetContext: () => null,
  });

/**
 * Session storage boundary (plan §10, addendum §6): every field re-validates
 * through Zod on read (peer card AND action schemas included, so enrichment
 * survives a reload). Text only — photo bytes, object-store keys, ownership
 * tokens, and auth material never live on turns, so persistence stays
 * privacy-safe. Valid turns restore; chat-failed turns restore as retryable;
 * legacy failed turns (flag without serializable failure) drop while the
 * preceding user text stays, so context is never silently lost.
 */
export const restoreThread = (storageKey: string): RestoredThread => {
  if (typeof window === "undefined") {
    return EMPTY_THREAD;
  }

  try {
    const raw = window.sessionStorage.getItem(museThreadStorageKey(storageKey));

    if (raw === null) {
      return EMPTY_THREAD;
    }

    const parsed = storedThreadSchema.safeParse(JSON.parse(raw));

    if (!parsed.success) {
      return EMPTY_THREAD;
    }

    const turns = parsed.data.turns
      .filter((turn) => turn.failure !== null || turn.text.trim() !== "" || turn.cards.length > 0)
      .slice(-MAX_STORED_TURNS)
      .map((turn): MuseTurn => ({
        id: turn.id,
        role: turn.role,
        text: turn.text.slice(0, MAX_STORED_CHARS),
        cards: turn.cards,
        followUps: turn.followUps,
        actions: turn.actions.map((action): SuggestedAction => ({
          label: action.label,
          action: museActionFromContract(action),
        })),
        notice: turn.notice,
        failure:
          turn.failure === null
            ? null
            : MuseFailure.$match(turn.failure, {
                Transport: () => MuseFailure.Transport(),
                RateLimited: ({ retryAfterSeconds }) =>
                  MuseFailure.RateLimited({ retryAfterSeconds }),
                Unavailable: () => MuseFailure.Unavailable(),
                InvalidOutput: () => MuseFailure.InvalidOutput(),
                AuthRequired: () => MuseFailure.AuthRequired(),
                Disabled: () => MuseFailure.Disabled(),
              }),
        synthesized: turn.synthesized,
      }));

    const retry = parsed.data.retry;

    const retryTurn =
      retry === null ? undefined : turns.find((turn) => turn.id === retry.assistantTurnId);

    return {
      turns,
      labels: parsed.data.labels.slice(-MAX_STORED_TURNS),
      draft: parsed.data.draft.slice(0, MAX_STORED_CHARS),
      retry: retry !== null && retryTurn !== undefined && retryTurn.failure !== null ? retry : null,
    };
  } catch {
    return EMPTY_THREAD;
  }
};

export interface ThreadSnapshot {
  readonly turns: ReadonlyArray<MuseTurn>;
  readonly labels: ReadonlyArray<readonly [string, string]>;
  readonly draft: string;
  readonly retry: StoredChatRetry | null;
}

/** Bounded persist: display thread capped, failed turns kept retryable, text truncated. */
export const persistThread = (storageKey: string, snapshot: ThreadSnapshot): void => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const payload = JSON.stringify({
      turns: snapshot.turns.slice(-MAX_STORED_TURNS).map((turn) => ({
        id: turn.id,
        role: turn.role,
        text: turn.text.slice(0, MAX_STORED_CHARS),
        cards: turn.cards,
        followUps: turn.followUps,
        actions: turn.actions
          .map(contractFromSuggested)
          .filter((action): action is CopilotAction => action !== null),
        notice: turn.notice,
        failure: turn.failure,
        synthesized: turn.synthesized,
      })),
      labels: snapshot.labels.slice(-MAX_STORED_TURNS),
      draft: snapshot.draft.slice(0, MAX_STORED_CHARS),
      retry: snapshot.retry,
    });

    window.sessionStorage.setItem(museThreadStorageKey(storageKey), payload);
  } catch {
    // Private mode or quota: the live thread still works for the session.
  }
};

/**
 * TanStack Query key integration for Muse (plan §§14/19-20).
 *
 * Cache policy per call type — documented here so every lane applies the
 * same rule:
 *
 * - `copilotChatFn` (personalized/AI answers): NO query cache. Replies
 *   depend on actor, history, and server-side budgets; caching them would
 *   risk cross-account leakage and stale personalization. In-flight
 *   dedupe only: client run-id/stale rejection plus the server coherence
 *   window (same message+task+context+history+actor, 30s TTL).
 * - `copilotIdentifyPhotoFn` (private scan bytes): NO cache. Owner-scoped
 *   vision results must never sit in a shared cache; single-flight via the
 *   workspace busy guard.
 * - `researchDishesFn` fallback (find flow): NO cache, explicit opt-in
 *   only. Freshness matters and the button re-arms per attempt; run-id
 *   guarded against stale renders.
 * - `restaurant-menu` (order flow, existing `useQuery`): BOUNDED cache,
 *   `staleTime` 60s, `retry: false`, keyed `[venue, channel]`. The payload
 *   is venue truth (locale-independent; language projection applies
 *   client-side), so no user or language segment is needed and no
 *   conversation content ever enters the cache. Never reuse this cache for
 *   chat, drafts, or prices.
 * - Draft order / favorites mutations: invalidate their own query keys on
 *   confirmation (see `invalidateFavoriteCaches`); the Muse thread is local
 *   state, so corrections to catalog facts surface on the next answer while
 *   already-rendered cards keep their captured titles (known limitation).
 *
 * No public cache of conversation content exists: turns persist only in the
 * identity-keyed session thread above, never in QueryClient.
 */
export const museThreadCacheKey = (identity: string, language: string): ReadonlyArray<string> => [
  "muse",
  "thread",
  identity,
  language,
];

export const museMenuCacheKey = (venueId: string, channel: string): ReadonlyArray<string> => [
  "restaurant-menu",
  venueId,
  channel,
];
