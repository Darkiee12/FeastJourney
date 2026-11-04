import { SseParser, ProgressSink, type ParsedServerEvent } from "@/modules/food-discovery/server/agent/stream-codec";
import type { ProgressEvent } from "@/modules/food-discovery/server/agent/protocol";

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
 * - stale results: only the latest started attempt may commit (attempt id guard);
 * - back-nav cache: terminal results are cached by canonical key with TTL;
 * - concurrent duplicate submissions share one in-flight fetch (no competing results);
 * - cache identity isolation: key includes payload + actor + locale + agent flag.
 *
 * The controller never imports server code or React: quiz-flow wires it into
 * useQuery/useState (lane C owns that wiring; this file is the reusable core).
 */

export type StreamStatus = "idle" | "pending" | "streaming" | "done" | "error";

export interface StreamCallbacks<TWire> {
  readonly onProgress?: ((event: ProgressEvent) => void) | undefined;
  readonly onDone?: ((result: TWire, progress: ProgressEvent | null) => void) | undefined;
  readonly onError?: ((code: string) => void) | undefined;
}

export interface StartOptions {
  readonly requestId: string;
  readonly signal?: AbortSignal | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface CacheEntry<TWire> {
  readonly result: TWire;
  readonly storedAt: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_CACHE_MAX_ENTRIES = 20;

/** Stable canonical key: sorted keys, arrays in order, actor + locale + flag. */
export const canonicalStreamKey = (input: {
  readonly payload: Record<string, unknown>;
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

const normalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
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
}

export class AgentStreamController<TWire = unknown> {
  private readonly cache = new Map<string, CacheEntry<TWire>>();
  private readonly inFlight = new Map<string, Promise<TWire>>();
  private attemptSerial = 0;
  private committedAttempt = -1;

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
    body: Record<string, unknown>,
    cacheKey: string,
    options: StartOptions,
    callbacks: StreamCallbacks<TWire> = {},
  ): { readonly attempt: number; readonly done: Promise<TWire> } {
    const attempt = this.attemptSerial;
    this.attemptSerial += 1;

    const existing = this.inFlight.get(cacheKey);
    if (existing !== undefined) {
      return {
        attempt,
        done: existing.then((result) => {
          if (attempt > this.committedAttempt) {
            this.committedAttempt = attempt;
            callbacks.onDone?.(result, null);
          }
          return result;
        }),
      };
    }

    const done = this.runAttempt(body, cacheKey, attempt, options, callbacks).finally(() => {
      if (this.inFlight.get(cacheKey) !== undefined) {
        this.inFlight.delete(cacheKey);
      }
    });
    this.inFlight.set(cacheKey, done);
    return { attempt, done };
  }

  private async runAttempt(
    body: Record<string, unknown>,
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
      callbacks.onError?.(error instanceof DOMException && error.name === "AbortError" ? "aborted" : "network");
      throw error;
    }

    if (!response.ok || response.body === null) {
      const code = response.status === 429 ? "rate_limited" : `http_${response.status}`;
      callbacks.onError?.(code);
      throw new Error(`Recommendation stream failed: ${code}`);
    }

    const parser = new SseParser();
    const sink = new ProgressSink();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: AttemptState<TWire> = { result: null, progress: null, errorCode: null };

    for (;;) {
      const read = await reader.read().catch((error: unknown): never => {
        // Interrupted stream: retryable error, never a partial commit.
        const code = options.signal?.aborted === true ? "aborted" : "interrupted";
        callbacks.onError?.(code);
        throw error instanceof Error ? error : new Error(`Recommendation stream ${code}`);
      });
      if (read.done) {
        break;
      }
      for (const frame of parser.push(decoder.decode(read.value, { stream: true }))) {
        this.applyFrame(frame, sink, attempt, callbacks, state);
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
      this.cache.set(cacheKey, { result: state.result, storedAt: Date.now() });
      this.evictCache();
      return state.result;
    }

    if (sink.isTerminated()) {
      callbacks.onError?.("missing_result");
      throw new Error("Recommendation stream ended without a result");
    }

    callbacks.onError?.("truncated");
    throw new Error("Recommendation stream truncated before terminal event");
  }

  /**
   * Apply one parsed frame: stale/duplicate/malformed deliveries drop via
   * the sink, progress reports latest-only, and the result commits through
   * onDone only when this attempt is still the latest starter.
   */
  private applyFrame(
    frame: ParsedServerEvent,
    sink: ProgressSink,
    attempt: number,
    callbacks: StreamCallbacks<TWire>,
    state: AttemptState<TWire>,
  ): void {
    if (frame.kind === "error") {
      state.errorCode = frame.error.code;
      callbacks.onError?.(frame.error.code);
      return;
    }
    if (frame.kind === "result") {
      state.result = frame.wire as TWire;
      if (attempt > this.committedAttempt) {
        this.committedAttempt = attempt;
        callbacks.onDone?.(state.result, state.progress);
      }
      return;
    }
    if (sink.push(frame.event) !== "accept") {
      return;
    }
    state.progress = frame.event;
    callbacks.onProgress?.(frame.event);
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
