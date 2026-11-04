import { z } from "zod";

import type { ProgressEvent, ProgressStage } from "@/modules/food-discovery/server/agent/protocol";

/**
 * Isomorphic SSE framing for agentic recommendation progress (workstream D).
 *
 * No server-only imports: the encoder runs in the stream route, the parser
 * and sink run in the browser controller. The contract in `protocol.ts` is
 * read-only — this module emits exactly `ProgressEvent` and never edits it.
 *
 * Wire format (SSE over POST + fetch/ReadableStream, NOT EventSource — see
 * docs/architecture/recommendations-agent-transport.md):
 *
 *   event: progress
 *   data: {"requestId":"...","seq":0,"stage":"preparing","detail":null,"terminal":false}
 *
 *   event: result
 *   data: {"requestId":"...","wire":{...RecommendationWireOutcome...}}
 *
 *   event: error
 *   data: {"requestId":"...","code":"rate_limited"|"invalid_input"|"unavailable"|"disabled"}
 *
 * Keep-alive comments (`: ping`) carry no semantics and are ignored by the
 * parser. Unknown event names are ignored so the protocol can grow without
 * breaking older clients.
 */

export const PROGRESS_EVENT_NAME = "progress";
export const RESULT_EVENT_NAME = "result";
export const ERROR_EVENT_NAME = "error";

const TERMINAL_STAGES: ReadonlySet<ProgressStage> = new Set<ProgressStage>([
  "completed",
  "degraded",
  "failed",
]);

export const isTerminalStage = (stage: ProgressStage): boolean => TERMINAL_STAGES.has(stage);

/** Structural shape of a progress event; lifecycle rules live in ProgressSink. */
export const progressEventSchema = z.object({
  requestId: z.string().min(1).max(64),
  seq: z.number().int().min(0),
  stage: z.enum([
    "preparing",
    "searching-catalog",
    "muse-curating",
    "inspecting-dishes",
    "finalizing",
    "completed",
    "degraded",
    "failed",
  ]),
  detail: z.string().max(500).nullable(),
  terminal: z.boolean(),
});

export type StreamErrorCode = "rate_limited" | "invalid_input" | "unavailable" | "disabled";

export const streamErrorSchema = z.object({
  requestId: z.string().min(1).max(64),
  code: z.enum(["rate_limited", "invalid_input", "unavailable", "disabled"]),
  retryAfterSeconds: z.number().int().min(0).optional(),
});

const sseBlock = (name: string, payload: string): string => `event: ${name}\ndata: ${payload}\n\n`;

/** JSON.stringify never emits raw newlines, so one data line is always a full frame. */
export const encodeProgressEvent = (event: ProgressEvent): string =>
  sseBlock(PROGRESS_EVENT_NAME, JSON.stringify(event));

export const encodeResultEvent = (requestId: string, wire: unknown): string =>
  sseBlock(RESULT_EVENT_NAME, JSON.stringify({ requestId, wire }));

export const encodeErrorEvent = (
  requestId: string,
  code: StreamErrorCode,
  retryAfterSeconds?: number | undefined,
): string =>
  sseBlock(
    ERROR_EVENT_NAME,
    JSON.stringify(
      retryAfterSeconds === undefined
        ? { requestId, code }
        : { requestId, code, retryAfterSeconds },
    ),
  );

/** SSE keep-alive comment: resets proxy idle timers, carries no semantics. */
export const HEARTBEAT_COMMENT = ": ping\n\n";

export type ParsedServerEvent =
  | { readonly kind: "progress"; readonly event: ProgressEvent }
  | { readonly kind: "result"; readonly requestId: string; readonly wire: unknown }
  | { readonly kind: "error"; readonly requestId: string; readonly error: z.infer<typeof streamErrorSchema> };

/**
 * Incremental SSE parser. Feed arbitrary chunk splits; complete `\n\n`
 * frames are decoded, comments and unknown event names are skipped, and
 * malformed frames are dropped with a count (never thrown).
 */
export class SseParser {
  private buffer = "";
  private droppedFrames = 0;

  readonly droppedCount = (): number => this.droppedFrames;

  push(chunk: string): Array<ParsedServerEvent> {
    this.buffer += chunk;
    const out: Array<ParsedServerEvent> = [];

    for (;;) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary < 0) {
        return out;
      }
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const parsed = parseFrame(frame);
      if (parsed === null) {
        this.droppedFrames += 1;
      } else {
        out.push(parsed);
      }
    }
  }
}

const parseFrame = (frame: string): ParsedServerEvent | null => {
  let name: string | null = null;
  const dataLines: Array<string> = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      name = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (name === null || dataLines.length === 0) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join("\n")) as unknown;
  } catch {
    return null;
  }

  if (name === PROGRESS_EVENT_NAME) {
    const parsed = progressEventSchema.safeParse(payload);
    return parsed.success ? { kind: "progress", event: parsed.data } : null;
  }

  if (name === RESULT_EVENT_NAME) {
    if (typeof payload !== "object" || payload === null) {
      return null;
    }
    const record = payload as { readonly requestId?: unknown; readonly wire?: unknown };
    return typeof record.requestId === "string"
      ? { kind: "result", requestId: record.requestId, wire: record.wire }
      : null;
  }

  if (name === ERROR_EVENT_NAME) {
    const parsed = streamErrorSchema.safeParse(payload);
    return parsed.success
      ? { kind: "error", requestId: parsed.data.requestId, error: parsed.data }
      : null;
  }

  // Unknown event names: ignore so the protocol can grow.
  return null;
};

export type SinkVerdict = "accept" | "drop-stale" | "drop-after-terminal" | "drop-malformed";

/**
 * Lifecycle guard for a single request's progress events. Enforces the
 * protocol invariants no matter what the network delivers:
 *
 * - strictly increasing `seq` (out-of-order and duplicate deliveries drop);
 * - `terminal` flag agrees with the stage (terminal stages complete the
 *   request; non-terminal stages never do);
 * - exactly one terminal event; nothing is accepted after it.
 */
export class ProgressSink {
  private lastSeq = -1;
  private terminated = false;
  private terminalCount = 0;

  readonly isTerminated = (): boolean => this.terminated;

  readonly seenTerminalCount = (): number => this.terminalCount;

  push(event: ProgressEvent): SinkVerdict {
    if (this.terminated) {
      return "drop-after-terminal";
    }
    if (event.terminal !== isTerminalStage(event.stage)) {
      return "drop-malformed";
    }
    if (event.seq <= this.lastSeq) {
      return "drop-stale";
    }
    this.lastSeq = event.seq;
    if (event.terminal) {
      this.terminated = true;
      this.terminalCount += 1;
    }
    return "accept";
  }
}

/**
 * Server-side emitter: the only way the stream route constructs progress
 * events. `seq` is assigned here (never by callers), the terminal event is
 * emitted exactly once, and every method after it returns null so the route
 * can never write after terminal.
 */
export class ProgressEmitter {
  private seq = 0;
  private closed = false;

  constructor(readonly requestId: string) {}

  readonly isClosed = (): boolean => this.closed;

  stage(
    stage: Exclude<ProgressStage, "completed" | "degraded" | "failed">,
    detail: string | null,
  ): string | null {
    if (this.closed) {
      return null;
    }
    const event: ProgressEvent = {
      requestId: this.requestId,
      seq: this.seq,
      stage,
      detail,
      terminal: false,
    };
    this.seq += 1;
    return encodeProgressEvent(event);
  }

  terminal(
    stage: Extract<ProgressStage, "completed" | "degraded" | "failed">,
    detail: string | null,
  ): string | null {
    if (this.closed) {
      return null;
    }
    const event: ProgressEvent = {
      requestId: this.requestId,
      seq: this.seq,
      stage,
      detail,
      terminal: true,
    };
    this.seq += 1;
    this.closed = true;
    return encodeProgressEvent(event);
  }
}

/**
 * Response headers for the SSE stream. `no-transform` stops compressing
 * proxies from buffering the stream into one blob; `X-Accel-Buffering: no`
 * stops nginx the same way. No `Content-Length`: the body is unbounded.
 */
export const streamResponseHeaders = (requestId: string): Headers => {
  const headers = new Headers();
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("Connection", "keep-alive");
  headers.set("X-Accel-Buffering", "no");
  headers.set("X-Request-Id", requestId);
  return headers;
};
