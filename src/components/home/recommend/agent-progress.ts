import { z } from "zod";

import type { ProgressEvent, ProgressStage } from "@/modules/food-discovery/server/agent/protocol";

/**
 * Stream consumer for the agentic recommendation progress protocol
 * (`server/agent/protocol.ts`, coordinator-owned — this file validates and
 * folds `ProgressEvent`s but never redefines them).
 *
 * Responsibilities:
 * - Validate untrusted stream lines at the network boundary
 *   (`parseProgressLine`, `isProgressEvent`).
 * - Fold events into a monotonic snapshot with stale guards
 *   (`applyProgressEvent`): stale request IDs, duplicate/out-of-order
 *   sequence numbers, and post-terminal events are dropped, never rendered.
 * - Read a byte stream into events without any UI framework
 *   (`consumeProgressStream`), so the logic is unit-testable and the React
 *   hook (`use-agent-progress.ts`) stays a thin lifecycle wrapper.
 *
 * Transport note: the exact streaming endpoint (SSE vs NDJSON POST, path,
 * auth) is owned by the progress-transport workstream. This consumer accepts
 * both `data: {...}` SSE framing and bare NDJSON lines, treats blank lines
 * and `:` comments as heartbeats (never as stages), and surfaces an
 * interrupted (EOF without terminal) outcome so the caller can retry.
 * The server's `terminal` flag — never the stage name — ends the stream.
 */

/** Every stage the protocol defines; used only to validate inbound events. */
const KNOWN_STAGE_VALUES: ReadonlySet<string> = new Set([
  "preparing",
  "searching-catalog",
  "muse-curating",
  "inspecting-dishes",
  "finalizing",
  "completed",
  "degraded",
  "failed",
]);

const isKnownStage = (value: string): value is ProgressStage => KNOWN_STAGE_VALUES.has(value);

/**
 * Wire shape of one progress event. Zod owns the boundary (same convention
 * as HTTP input validation); unknown extra keys are ignored, every required
 * field is checked, and the stage membership check keeps invented stages
 * out of the UI.
 */
const progressEventWireSchema = z.object({
  requestId: z.string().min(1),
  seq: z.number().int().min(0),
  stage: z.string(),
  detail: z.string().nullable(),
  terminal: z.boolean(),
});

/** Runtime validation for one untrusted decoded line value. */
export const isProgressEvent = (value: unknown): value is ProgressEvent => {
  const parsed = progressEventWireSchema.safeParse(value);

  if (!parsed.success) {
    return false;
  }

  return isKnownStage(parsed.data.stage);
};

/**
 * Stages that render the live Muse presence. Terminal stages
 * (`completed`, `degraded`, `failed`) never render presence copy — the
 * outcome (or the neutral skeleton while it is still in flight) owns the
 * UI from that point on.
 */
export const ACTIVE_PROGRESS_STAGES: ReadonlySet<ProgressStage> = new Set([
  "preparing",
  "searching-catalog",
  "muse-curating",
  "inspecting-dishes",
  "finalizing",
]);

export const isActiveProgressStage = (stage: ProgressStage): boolean =>
  ACTIVE_PROGRESS_STAGES.has(stage);

/** Monotonic view of one recommendation request's progress. */
export interface AgentProgressSnapshot {
  readonly requestId: string;
  /** True once the first in-order event for this request applied. */
  readonly started: boolean;
  readonly stage: ProgressStage | null;
  readonly detail: string | null;
  readonly terminal: boolean;
  /** Highest sequence number applied so far; initial -1 accepts seq 0. */
  readonly lastSeq: number;
  readonly eventCount: number;
}

export const initialAgentProgress = (requestId: string): AgentProgressSnapshot => ({
  requestId,
  started: false,
  stage: null,
  detail: null,
  terminal: false,
  lastSeq: -1,
  eventCount: 0,
});

/**
 * Fold one event into the snapshot. Drops (returns state unchanged):
 * events for another request (stale navigation/answer-change streams),
 * duplicates and out-of-order arrivals (`seq` below the high-water mark),
 * and anything after a terminal event. Otherwise advances stage/detail and
 * records the new high-water mark.
 */
export const applyProgressEvent = (
  state: AgentProgressSnapshot,
  event: ProgressEvent,
): AgentProgressSnapshot => {
  if (event.requestId !== state.requestId) {
    return state;
  }

  if (state.terminal) {
    return state;
  }

  if (event.seq <= state.lastSeq) {
    return state;
  }

  return {
    requestId: state.requestId,
    started: true,
    stage: event.stage,
    detail: event.detail,
    terminal: event.terminal,
    lastSeq: event.seq,
    eventCount: state.eventCount + 1,
  };
};

export type ProgressLineResult =
  | { readonly kind: "event"; readonly event: ProgressEvent }
  | { readonly kind: "heartbeat" }
  | { readonly kind: "invalid" };

/**
 * Parse one stream line. Blank keep-alives and SSE comments are heartbeats
 * (no stage change, no announcement). Both bare NDJSON and `data:`-prefixed
 * SSE framing are accepted; anything else that fails validation is
 * `invalid` — counted by the consumer, never rendered, never fatal.
 */
export const parseProgressLine = (line: string): ProgressLineResult => {
  const trimmed = line.trim();

  if (trimmed === "" || trimmed.startsWith(":")) {
    return { kind: "heartbeat" };
  }

  // SSE framing (`data: {...}` / `event: ...`); only data lines carry events.
  if (trimmed.startsWith("event:")) {
    return { kind: "heartbeat" };
  }

  const payload = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;

  if (payload === "") {
    return { kind: "heartbeat" };
  }

  let parsed: unknown;

  try {
    // SAFETY: JSON.parse returns any by design; binding it into unknown is
    // the narrowest possible handoff before the zod schema validates it.
    parsed = JSON.parse(payload);
  } catch {
    return { kind: "invalid" };
  }

  if (!isProgressEvent(parsed)) {
    return { kind: "invalid" };
  }

  return { kind: "event", event: parsed };
};

export interface ProgressConsumeCallbacks {
  readonly onEvent: (event: ProgressEvent) => void;
  readonly onInvalidLine?: ((line: string) => void) | undefined;
}

export type ProgressStreamEnd =
  | { readonly reason: "terminal" }
  | { readonly reason: "closed" }
  | { readonly reason: "aborted" };

export interface ProgressConsumeResult {
  readonly events: number;
  readonly invalidLines: number;
  readonly end: ProgressStreamEnd;
}

/**
 * Read a progress byte stream to completion. Chunk boundaries never split
 * an event (a text buffer carries the remainder). Aborting via `signal`
 * stops promptly and reports `aborted`; closing the stream without a
 * terminal event reports `closed` (interrupted — the caller retries);
 * reader I/O failures propagate to the caller, never swallowed.
 */
export const consumeProgressStream = async (
  stream: ReadableStream<Uint8Array>,
  callbacks: ProgressConsumeCallbacks,
  signal?: AbortSignal,
): Promise<ProgressConsumeResult> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let events = 0;
  let invalidLines = 0;
  let terminalSeen: boolean = false;

  const handleLine = (line: string): boolean => {
    const result = parseProgressLine(line);

    if (result.kind === "heartbeat") {
      return false;
    }

    if (result.kind === "invalid") {
      invalidLines += 1;
      callbacks.onInvalidLine?.(line);

      return false;
    }

    events += 1;
    callbacks.onEvent(result.event);

    return result.event.terminal;
  };

  try {
    for (;;) {
      if (signal?.aborted === true) {
        return { events, invalidLines, end: { reason: "aborted" } };
      }

      // oxlint-disable-next-line no-await-in-loop -- A stream reader advances one chunk at a time.
      const read = await reader.read();

      if (read.done) {
        const lines = buffer
          .split("\n")
          .map((raw) => raw.replace(/\r$/, ""))
          .filter((raw) => raw.trim() !== "");

        for (const line of lines) {
          if (handleLine(line)) {
            terminalSeen = true;
          }
        }

        return {
          events,
          invalidLines,
          end: { reason: terminalSeen ? "terminal" : "closed" },
        };
      }

      buffer += decoder.decode(read.value, { stream: true });

      const pending = buffer.split("\n");
      const remainder = pending.pop() ?? "";

      for (const line of pending.map((raw) => raw.replace(/\r$/, ""))) {
        if (handleLine(line)) {
          terminalSeen = true;
        }
      }

      buffer = remainder;
    }
  } finally {
    reader.releaseLock();
  }
};

/**
 * Minimal presence input for the loading skeleton. `live` is true only
 * after a real backend event applied — deterministic, degraded, guest, and
 * pre-stream states all stay neutral and never claim Muse curation.
 */
export interface AgentPresenceInput {
  readonly stage: ProgressStage | null;
  readonly live: boolean;
}

export const presenceForSnapshot = (snapshot: AgentProgressSnapshot | null): AgentPresenceInput => {
  if (snapshot === null || !snapshot.started || snapshot.stage === null) {
    return { stage: null, live: false };
  }

  if (!isActiveProgressStage(snapshot.stage)) {
    return { stage: null, live: false };
  }

  return { stage: snapshot.stage, live: true };
};
