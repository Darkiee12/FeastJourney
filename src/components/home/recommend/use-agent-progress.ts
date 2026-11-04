import { useEffect, useState } from "react";
import { z } from "zod";

import {
  applyProgressEvent,
  consumeProgressStream,
  initialAgentProgress,
  type AgentProgressSnapshot,
} from "@/components/home/recommend/agent-progress";
import {
  AgentStreamController,
  canonicalStreamKey,
  type JsonValue,
} from "@/components/home/recommend/agent-progress-controller";
import type { RecommendPayload } from "@/components/home/recommend/quiz-model";
import type { ProgressEvent } from "@/modules/food-discovery/server/agent/protocol";
import type { RecommendationWireOutcome } from "@/modules/food-discovery/server/operations/recommendation-service";

/**
 * Transport seam for the agentic progress stream. The streaming endpoint
 * (path, method, auth) is owned by the progress-transport workstream; this
 * type is the contract the UI consumes. Resolves to `null` when the
 * transport is absent or declines streaming (e.g. deterministic mode), in
 * which case the caller keeps the existing neutral pending UI.
 */
export type AgentStreamOpener = (
  requestId: string,
  signal: AbortSignal,
) => Promise<ReadableStream<Uint8Array> | null>;

export interface AgentProgressState {
  /** Null while no stream is active (idle, cached outcome, no transport). */
  readonly snapshot: AgentProgressSnapshot | null;
  /** True when the stream closed or failed before a terminal event. */
  readonly interrupted: boolean;
}

const IDLE: AgentProgressState = { snapshot: null, interrupted: false };

const stateForRequest = (requestId: string | null): AgentProgressState => {
  if (requestId === null) {
    return IDLE;
  }

  return { snapshot: initialAgentProgress(requestId), interrupted: false };
};

/**
 * Consume one request's progress stream. Cancellation (unmount,
 * navigation, answer-change via a new `requestId`) aborts the reader and
 * the generation guard drops late events — a stale stream can never
 * overwrite a newer request's snapshot. With no opener (transport not yet
 * wired) the state stays idle so recommendations fall back to the current
 * neutral loading skeleton with zero extra requests.
 */
export function useAgentProgress(
  requestId: string | null,
  openStream?: AgentStreamOpener,
): AgentProgressState {
  const [state, setState] = useState<AgentProgressState>(() => stateForRequest(requestId));
  const [trackedId, setTrackedId] = useState<string | null>(requestId);

  // Render-adjust reset (same pattern as the carousel rail index): a new
  // request — including an account switch with otherwise identical answers —
  // never inherits the previous stream's snapshot.
  if (trackedId !== requestId) {
    setTrackedId(requestId);
    setState(stateForRequest(requestId));
  }

  useEffect(() => {
    if (requestId === null || openStream === undefined) {
      return undefined;
    }

    const controller = new AbortController();
    const guard = { current: true };

    let current = initialAgentProgress(requestId);

    const finish = (snapshot: AgentProgressSnapshot, interrupted: boolean): void => {
      if (guard.current) {
        setState({ snapshot, interrupted });
      }
    };

    const run = async (): Promise<void> => {
      let stream: ReadableStream<Uint8Array> | null | undefined;
      let openFailed = false;

      try {
        stream = await openStream(requestId, controller.signal);
      } catch {
        openFailed = true;
      }

      if (openFailed) {
        finish(current, true);
      } else if (!guard.current) {
        await stream?.cancel().catch(() => undefined);
      } else if (stream !== null && stream !== undefined) {
        try {
          const result = await consumeProgressStream(
            stream,
            {
              onEvent: (event) => {
                current = applyProgressEvent(current, event);
                finish(current, false);
              },
            },
            controller.signal,
          );

          if (result.end.reason === "closed") {
            finish(current, true);
          }
        } catch {
          finish(current, true);
        }
      }
    };

    void run();

    return () => {
      guard.current = false;
      controller.abort();
    };
  }, [requestId, openStream]);

  return state;
}

/**
 * Proposed fetch transport for the progress endpoint (owned by the
 * transport workstream — not wired into quiz-flow yet). POSTs the request
 * ID, expects an NDJSON/SSE event stream, and yields `null` on 404/501 so
 * undeployed transports degrade to the neutral skeleton instead of
 * erroring. Non-streaming failures reject so the hook marks `interrupted`.
 */
export const createFetchProgressOpener = (url: string, init?: RequestInit): AgentStreamOpener => {
  const opener = async (
    requestId: string,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array> | null> => {
    const headers = new Headers(init?.headers);

    headers.set("content-type", "application/json");

    const response = await fetch(url, {
      ...init,
      method: "POST",
      headers,
      body: JSON.stringify({ requestId }),
      signal,
    });

    if (response.status === 404 || response.status === 501) {
      return null;
    }

    if (!response.ok || response.body === null) {
      throw new Error(`Progress stream failed with status ${response.status}`);
    }

    return response.body;
  };

  return opener;
};

/**
 * Stream-first recommendation wiring (lane C consumer). The controller owns
 * fetch lifecycle, SSE parsing, terminal/requestId gating, staleness, and
 * back-nav caching; this hook owns the React binding: progress snapshot for
 * the existing presence chain, validated wire result for the existing
 * outcome render, and the pre-stream fallback signal for the JSON query
 * path. Layout and render mapping stay in quiz-flow / results-loading /
 * muse-presence, untouched by transport choice.
 */

export interface AgentStreamRequest {
  /** Canonical controller cache key for this submission. */
  readonly key: string;
  /** Fresh correlation id per submission, sent as the `x-request-id` header. */
  readonly requestId: string;
  /** Transport payload: the same shape `recommendDishesFn` receives. */
  readonly payload: RecommendPayload;
  /** Per-user cache isolation, matching the JSON query key input. */
  readonly actorId: string;
  /** False on explicit retry: bypass both caches and fetch exactly once. */
  readonly useCache: boolean;
}

export interface AgentStreamState {
  /** Null while no stream attempt is active (idle, cache-served, quiz phase). */
  readonly snapshot: AgentProgressSnapshot | null;
  /** True when the stream closed or failed before a terminal event. */
  readonly interrupted: boolean;
  /** Validated wire outcome, committed only after the terminal event. */
  readonly wire: RecommendationWireOutcome | null;
  /** Stream failure code (`aborted` is cancellation, never an error). */
  readonly errorCode: string | null;
  readonly pending: boolean;
  /**
   * True when the stream never opened (disabled flag, 404, network, or any
   * non-ok response with zero progress frames): the caller runs the JSON
   * query path instead. Exactly one transport per submission — post-open
   * failures never fall back, so the provider is never called twice.
   */
  readonly fallbackToJson: boolean;
}

/**
 * Runtime envelope check for the committed wire result, expressed as the
 * Zod boundary schema (the repo's HTTP-input convention). Checks the fields
 * the outcome render reads (mode, dish ids, reason types, ranking tag,
 * served scope) and ignores every other card field — no invented fields, no
 * revalidation of server-validated reason text beyond its type. The commit
 * keeps the original wire object (never the stripped schema output), so all
 * card fields travel through untouched. Deeper provider validation already
 * ran server-side; the JSON query path trusts the same shape with no client
 * check at all.
 */
const streamDishSchema = z.object({
  id: z.string().min(1),
  aiReason: z.string().optional(),
});

const streamRankingSchema = z.object({
  _tag: z.enum(["LiveMuse", "DeterministicCatalog", "DegradedMuse"]),
  cause: z.enum(["rate-limited", "transient", "invalid-output"]).optional(),
});

const streamWireSchema = z.object({
  mode: z.enum(["ai", "deterministic", "uncertain", "empty"]),
  dishes: z.array(streamDishSchema),
  warnings: z.array(z.string()),
  reasons: z.array(z.string()),
  ranking: streamRankingSchema,
  servedScope: z.enum(["city", "country", "nearby", "worldwide"]).optional(),
});

const streamLocationFor = (location: NonNullable<RecommendPayload["location"]>): JsonValue => {
  if (location.kind === "precise") {
    return {
      kind: "precise",
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.accuracy ?? null,
    };
  }

  if (location.kind === "city") {
    const fields: Array<[string, JsonValue]> = [
      ["kind", "city"],
      ["placeId", location.placeId],
    ];

    if (location.country !== undefined) {
      fields.push(["country", location.country]);
    }

    if (location.label !== undefined) {
      fields.push(["label", location.label]);
    }

    return Object.fromEntries(fields);
  }

  if (location.kind === "worldwide") {
    return { kind: "worldwide" };
  }

  return { kind: location.kind, country: location.country };
};

/**
 * JSON-safe stream body: the same transport payload `recommendDishesFn`
 * receives, with `undefined` optionals dropped instead of serialized. Key
 * order is irrelevant (the canonical key normalizes it); the server parses
 * both through the same `recommendationQuerySchema`.
 */
const streamBodyFor = (payload: RecommendPayload): JsonValue => {
  const fields: Array<[string, JsonValue]> = [
    ["meal", payload.meal],
    ["excludedIngredients", [...payload.excludedIngredients]],
    ["mood", payload.mood],
    ["locale", payload.locale],
    ["surpriseSeed", payload.surpriseSeed],
  ];

  if (payload.cuisine !== undefined) {
    fields.push(["cuisine", payload.cuisine]);
  }

  if (payload.country !== undefined) {
    fields.push(["country", payload.country]);
  }

  if (payload.location !== undefined) {
    fields.push(["location", streamLocationFor(payload.location)]);
  }

  return Object.fromEntries(fields);
};

/** Canonical controller cache key: payload + actor + locale + agent flag. */
export const streamCacheKeyFor = (payload: RecommendPayload, actorId: string): string =>
  canonicalStreamKey({
    payload: streamBodyFor(payload),
    actorId,
    locale: payload.locale,
    agentEnabled: true,
  });

/**
 * Map a validated wire outcome into the existing `RecommendResult` render
 * shape. Byte-parity with the `recommendDishesFn` transport projection:
 * non-ai modes strip model text (JSON serialization drops `undefined`
 * there; the render reads `undefined` identically here), ai mode keeps the
 * validated per-dish reasons. Legacy allergy warnings never apply — neither
 * transport sends legacy terms.
 */
export const mapStreamWireToResult = (
  wire: RecommendationWireOutcome,
): RecommendationWireOutcome => {
  if (wire.mode === "ai") {
    return wire;
  }

  return {
    ...wire,
    dishes: wire.dishes.map((dish) => ({ ...dish, aiReason: undefined })),
  };
};

let sharedStreamController: AgentStreamController<RecommendationWireOutcome> | null = null;

const sharedController = (): AgentStreamController<RecommendationWireOutcome> => {
  if (sharedStreamController === null) {
    sharedStreamController = new AgentStreamController<RecommendationWireOutcome>();
  }

  return sharedStreamController;
};

/**
 * Submit-time controller cache read: a terminal result committed by an
 * earlier attempt for the same canonical key, or null. Commits were already
 * envelope-validated, and the entry also mirrors into the QueryClient, so
 * this is a pure fast path with no fetch. Called from submit handlers (sync
 * context), never from effects.
 */
export const peekStreamResult = (key: string): RecommendationWireOutcome | null =>
  sharedController().cachedResult(key);

const idleStreamState = (request: AgentStreamRequest | null): AgentStreamState => {
  if (request === null) {
    return {
      snapshot: null,
      interrupted: false,
      wire: null,
      errorCode: null,
      pending: false,
      fallbackToJson: false,
    };
  }

  return {
    snapshot: initialAgentProgress(request.requestId),
    interrupted: false,
    wire: null,
    errorCode: null,
    pending: true,
    fallbackToJson: false,
  };
};

const trackStreamRequest = (request: AgentStreamRequest | null): string | null => {
  if (request === null) {
    return null;
  }

  return `${request.key}|${request.requestId}|${request.useCache ? "cache" : "fresh"}`;
};

/**
 * Own one recommendation stream attempt. Effect lifecycle mirrors
 * `useAgentProgress` (start on request, abort on cleanup): unmount,
 * back-navigation, and superseding submissions cancel the fetch and the
 * controller's stale-guard drops late frames. Cache reads happen at submit
 * time (`peekStreamResult`), so this effect always fetches exactly once;
 * explicit retry (`useCache: false`) skips the submit-time read. Pre-open
 * failures (no progress frame seen) signal `fallbackToJson` so the caller
 * runs the JSON query instead; anything after the first frame is a terminal
 * stream failure with no fallback.
 */
export function useAgentRecommendationStream(request: AgentStreamRequest | null): AgentStreamState {
  const [state, setState] = useState<AgentStreamState>(() => idleStreamState(request));
  const [tracked, setTracked] = useState<string | null>(() => trackStreamRequest(request));

  // Render-adjust reset (same pattern as the carousel rail index): a new
  // submission — including a retry with a fresh request id — never inherits
  // the previous attempt's snapshot, result, or error.
  if (tracked !== trackStreamRequest(request)) {
    setTracked(trackStreamRequest(request));
    setState(idleStreamState(request));
  }

  useEffect(() => {
    if (request === null) {
      return undefined;
    }

    const controller = sharedController();
    const attemptId = request.requestId;

    const abort = new AbortController();
    const seen = { current: false };
    let current = initialAgentProgress(attemptId);

    const { done } = controller.start(
      streamBodyFor(request.payload),
      request.key,
      { requestId: request.requestId, signal: abort.signal },
      {
        onProgress: (event: ProgressEvent) => {
          seen.current = true;
          current = applyProgressEvent(current, event);
          const snapshot = current;
          setState((previous) => ({ ...previous, snapshot, interrupted: false }));
        },
        onDone: (result) => {
          const parsed = streamWireSchema.safeParse(result);

          if (parsed.success) {
            setState((previous) => ({ ...previous, wire: result, pending: false }));
          } else {
            setState((previous) => ({
              ...previous,
              errorCode: "invalid_result",
              pending: false,
              interrupted: true,
              fallbackToJson: false,
            }));
          }
        },
        onError: (code: string) => {
          if (code === "aborted") {
            setState((previous) => ({ ...previous, pending: false }));

            return;
          }

          if (seen.current) {
            setState((previous) => ({
              ...previous,
              errorCode: code,
              pending: false,
              interrupted: true,
              fallbackToJson: false,
            }));
          } else {
            setState((previous) => ({
              ...previous,
              errorCode: code,
              pending: false,
              interrupted: true,
              fallbackToJson: true,
            }));
          }
        },
      },
    );

    void done.catch(() => undefined);

    return () => {
      abort.abort();
    };
  }, [request]);

  return state;
}
