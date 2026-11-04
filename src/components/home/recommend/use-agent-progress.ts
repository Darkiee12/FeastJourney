import { useEffect, useState } from "react";

import {
  applyProgressEvent,
  consumeProgressStream,
  initialAgentProgress,
  type AgentProgressSnapshot,
} from "@/components/home/recommend/agent-progress";

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
