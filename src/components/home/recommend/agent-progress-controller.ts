import type { ProgressEvent } from "@/modules/food-discovery/server/agent/protocol";
import {
  SseParser,
  ProgressSink,
  type ParsedServerEvent,
} from "@/modules/food-discovery/server/agent/stream-codec";

/**
 * Framework-agnostic client controller for the recommendation progress
 * stream (workstream D). Owns fetch lifecycle, incremental SSE parsing, and
 * all end-to-end correctness rules:
 *
 * - pending states: `idle → pending → streaming → done | error`;
 * - out-of-order / duplicate frames drop via ProgressSink (seq guard);
 * - interrupted streams surface as retryable errors, never partial commits;
 * - hydration: only a terminal result commits data; progress alone commits nothing;
 * - navigation cancellation: `cancel()` aborts fetch; late frames are ignored;
 * - stale results: only the latest started attempt may commit; older attempts
 *   resolve with their data but never update progress, result, or error state;
 * - result commits only after BOTH the result frame and the terminal progress
 *   event arrive with the matching requestId (`onDone` fires once);
 * - requestId mismatches drop, never commit;
 * - back-nav cache: terminal results are cached by canonical key with TTL;
 * - concurrent duplicate submissions share one in-flight fetch (no competing results);
 * - cache identity isolation: key includes payload + actor + locale + agent flag.
 *
 * The controller never imports server code or React: quiz-flow wires it into
 * useQuery/useState (lane C owns that wiring; this file is the reusable core).
 */

/** JSON-compatible domain value for stream request bodies and cache keys. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

/** Minimal structural fetch signature the controller needs (testable without casts). */
export type StreamFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type StreamStatus = "idle" | "pending" | "streaming" | "done" | "error";

export interface StreamCallbacks<TWire> {
  readonly onProgress?: ((event: ProgressEvent) => void) | undefined;
  readonly onDone?: ((result: TWire, progress: ProgressEvent | null) => void) | undefined;
  readonly onError?: ((code: string) => void) | undefined;
}

export interface StartOptions {
  readonly requestId: string;
  readonly signal?: AbortSignal | undefined;
  readonly fetchImpl?: StreamFetch | undefined;
}

export interface CacheEntry<TWire> {
  readonly result: TWire;
  readonly storedAt: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_CACHE_MAX_ENTRIES = 20;

/** Stable canonical key: sorted keys, arrays in order, actor + locale + flag. */
export const canonicalStreamKey = (input: {
  readonly payload: JsonValue;
  readonly actorId: string;
  readonly locale: string;
  readonly agentEnabled: boolean;
}): string => {
  const normalized = normalizeValue(input.payload);

  return JSON.stringify({
    actorId: input.actorId,
    agentEnabled: input.agentEnabled,
    locale: input.locale,
    payload: normalized,
  });
};

const isJsonObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  value instanceof Object && !Array.isArray(value);

const normalizeValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (isJsonObject(value)) {
    const entries = Object.entries(value).toSorted(([a], [b]) => {
      if (a < b) {
        return -1;
      }

      if (a > b) {
        return 1;
      }

      return 0;
    });

    const out: { [key: string]: JsonValue } = {};

    for (const [key, entry] of entries) {
      out[key] = normalizeValue(entry);
    }

    return out;
  }

  return value;
};

interface AttemptState<TWire> {
  result: TWire | null;
  progress: ProgressEvent | null;
  errorCode: string | null;
  notified: boolean;
}

export class AgentStreamController<TWire = unknown> {
  private readonly cache = new Map<string, CacheEntry<TWire>>();
  private readonly inFlight = new Map<string, Promise<TWire>>();
  private attemptSerial = 0;
  private latestStartedAttempt = -1;

  constructor(
    private readonly endpoint: string = "/api/v1/recommendations/stream",
    private readonly cacheTtlMs: number = DEFAULT_CACHE_TTL_MS,
    private readonly cacheMaxEntries: number = DEFAULT_CACHE_MAX_ENTRIES,
  ) {}

  /** Fresh cached result for back-nav; null when absent or stale. */
  cachedResult(cacheKey: string, now: number = Date.now()): TWire | null {
    const entry = this.cache.get(cacheKey);

    if (entry === undefined) {
      return null;
    }

    if (now - entry.storedAt > this.cacheTtlMs) {
      this.cache.delete(cacheKey);

      return null;
    }

    return entry.result;
  }

  /**
   * Start (or join) a stream. Identical in-flight keys share one fetch;
   * different keys run independently but only the latest started attempt
   * may commit its result — older attempts resolve, never commit.
   */
  start(
    body: JsonValue,
    cacheKey: string,
    options: StartOptions,
    callbacks: StreamCallbacks<TWire> = {},
  ) {
    const attempt = this.attemptSerial;
    this.attemptSerial += 1;
    this.latestStartedAttempt = attempt;

    const existing = this.inFlight.get(cacheKey);

    if (existing !== undefined) {
      const done = existing.then((result) => {
        if (attempt === this.latestStartedAttempt) {
          callbacks.onDone?.(result, null);
        }

        return result;
      });

      return { attempt, done };
    }

    const done = this.runAttempt(body, cacheKey, attempt, options, callbacks).finally(() => {
      if (this.inFlight.get(cacheKey) !== undefined) {
        this.inFlight.delete(cacheKey);
      }
    });

    this.inFlight.set(cacheKey, done);

    return { attempt, done };
  }

  private readonly isLatest = (attempt: number): boolean => attempt === this.latestStartedAttempt;

  private async runAttempt(
    body: JsonValue,
    cacheKey: string,
    attempt: number,
    options: StartOptions,
    callbacks: StreamCallbacks<TWire>,
  ): Promise<TWire> {
    const fetchImpl = options.fetchImpl ?? fetch;
    let response: Response;

    try {
      response = await fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": options.requestId,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      if (this.isLatest(attempt)) {
        callbacks.onError?.(
          error instanceof DOMException && error.name === "AbortError" ? "aborted" : "network",
        );
      }

      throw error;
    }

    if (!response.ok || response.body === null) {
      const code = response.status === 429 ? "rate_limited" : `http_${response.status}`;

      if (this.isLatest(attempt)) {
        callbacks.onError?.(code);
      }

      throw new Error(`Recommendation stream failed: ${code}`);
    }

    const parser = new SseParser();
    const sink = new ProgressSink();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const state: AttemptState<TWire> = {
      result: null,
      progress: null,
      errorCode: null,
      notified: false,
    };

    for (;;) {
      let read: ReadableStreamReadResult<Uint8Array>;

      try {
        // oxlint-disable-next-line no-await-in-loop -- Stream frames arrive sequentially; each read advances the shared decode buffer.
        read = await reader.read();
      } catch (cause) {
        const code = options.signal?.aborted === true ? "aborted" : "interrupted";

        if (this.isLatest(attempt)) {
          callbacks.onError?.(code);
        }

        throw cause instanceof Error ? cause : new Error(`Recommendation stream ${code}`);
      }

      if (read.done) {
        break;
      }

      for (const frame of parser.push(decoder.decode(read.value, { stream: true }))) {
        this.applyFrame(frame, sink, attempt, options.requestId, callbacks, state);

        if (state.errorCode !== null) {
          break;
        }
      }

      if (state.errorCode !== null) {
        break;
      }

      if (sink.isTerminated() && state.result !== null) {
        break;
      }
    }

    if (state.errorCode !== null) {
      throw new Error(`Recommendation stream failed: ${state.errorCode}`);
    }

    // Only a terminal-gated result commits: progress without terminal, or
    // terminal without a result frame, is a protocol violation, never data.
    if (state.result !== null && sink.isTerminated()) {
      if (this.isLatest(attempt)) {
        this.cache.set(cacheKey, { result: state.result, storedAt: Date.now() });
        this.evictCache();
      }

      return state.result;
    }

    if (sink.isTerminated()) {
      if (this.isLatest(attempt)) {
        callbacks.onError?.("missing_result");
      }

      throw new Error("Recommendation stream ended without a result");
    }

    if (this.isLatest(attempt)) {
      callbacks.onError?.("truncated");
    }

    throw new Error("Recommendation stream truncated before terminal event");
  }

  /**
   * Apply one parsed frame: requestId mismatches drop, stale/duplicate
   * deliveries drop via the sink, progress reports latest-only, and the
   * result commits through onDone only when this attempt is still the
   * latest starter and both the result frame and the terminal progress
   * event arrived with the matching requestId.
   */
  private applyFrame(
    frame: ParsedServerEvent,
    sink: ProgressSink,
    attempt: number,
    expectedRequestId: string,
    callbacks: StreamCallbacks<TWire>,
    state: AttemptState<TWire>,
  ): void {
    const frameRequestId = frame.kind === "progress" ? frame.event.requestId : frame.requestId;

    if (frameRequestId !== expectedRequestId) {
      return;
    }

    if (frame.kind === "error") {
      state.errorCode = frame.error.code;

      if (this.isLatest(attempt)) {
        callbacks.onError?.(frame.error.code);
      }

      return;
    }

    if (frame.kind === "result") {
      // SAFETY: the route validates the wire against RecommendationWireOutcome; TWire is the caller's declared contract for that validated shape.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic wire contract asserted once at the validated boundary.
      state.result = frame.wire as TWire;
      this.maybeCommit(attempt, sink, callbacks, state);

      return;
    }

    if (sink.push(frame.event) !== "accept") {
      return;
    }

    state.progress = frame.event;

    if (this.isLatest(attempt)) {
      callbacks.onProgress?.(frame.event);
    }

    this.maybeCommit(attempt, sink, callbacks, state);
  }

  /** Commit once both halves arrived; only the latest starter notifies and caches. */
  private maybeCommit(
    attempt: number,
    sink: ProgressSink,
    callbacks: StreamCallbacks<TWire>,
    state: AttemptState<TWire>,
  ): void {
    if (state.notified || state.result === null || !sink.isTerminated()) {
      return;
    }

    if (!this.isLatest(attempt)) {
      return;
    }

    state.notified = true;
    callbacks.onDone?.(state.result, state.progress);
  }

  private evictCache(): void {
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next();

      if (oldest.done === true) {
        return;
      }

      this.cache.delete(oldest.value);
    }
  }
}
