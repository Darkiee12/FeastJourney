import { describe, expect, test } from "bun:test";

import type { ProgressEvent } from "@/modules/food-discovery/server/agent/protocol";
import {
  ProgressEmitter,
  ProgressSink,
  SseParser,
  encodeErrorEvent,
  encodeProgressEvent,
  encodeResultEvent,
  HEARTBEAT_COMMENT,
  progressEventSchema,
  streamResponseHeaders,
} from "@/modules/food-discovery/server/agent/stream-codec";
import { RankingProvenance } from "@/modules/food-discovery/server/operations/recommendation-service";

const event = (overrides: Partial<ProgressEvent> = {}): ProgressEvent => ({
  requestId: "req-1",
  seq: 0,
  stage: "preparing",
  detail: null,
  terminal: false,
  ...overrides,
});

describe("progressEventSchema", () => {
  test("accepts every protocol stage", () => {
    for (const stage of [
      "preparing",
      "searching-catalog",
      "muse-curating",
      "inspecting-dishes",
      "finalizing",
      "completed",
      "degraded",
      "failed",
    ] as const) {
      expect(progressEventSchema.safeParse(event({ stage })).success).toBe(true);
    }
  });

  test("rejects negative seq and oversized detail", () => {
    expect(progressEventSchema.safeParse(event({ seq: -1 })).success).toBe(false);
    expect(progressEventSchema.safeParse(event({ detail: "x".repeat(501) })).success).toBe(false);
  });
});

describe("SSE framing", () => {
  test("progress round-trips through the parser", () => {
    const parser = new SseParser();
    const frames = parser.push(encodeProgressEvent(event({ seq: 2, stage: "finalizing" })));
    expect(frames.length).toBe(1);
    const first = frames[0];
    expect(first?.kind).toBe("progress");

    if (first?.kind === "progress") {
      expect(first.event.seq).toBe(2);
      expect(first.event.stage).toBe("finalizing");
    }
  });

  test("split chunks reassemble; heartbeats and unknown events are skipped", () => {
    const parser = new SseParser();

    const wire =
      encodeProgressEvent(event({ seq: 0 })) + HEARTBEAT_COMMENT + "event: future\ndata: {}\n\n";

    const part = Math.floor(wire.length / 2);
    expect(parser.push(wire.slice(0, part)).length).toBe(0);
    const frames = parser.push(wire.slice(part));
    expect(frames.length).toBe(1);
    expect(frames[0]?.kind).toBe("progress");
    // Skipped frames: the heartbeat comment and the unknown event name.
    expect(parser.droppedCount()).toBe(2);
  });

  test("malformed JSON frames drop without throwing", () => {
    const parser = new SseParser();
    const frames = parser.push("event: progress\ndata: not-json\n\n");
    expect(frames.length).toBe(0);
    expect(parser.droppedCount()).toBe(1);
  });

  test("result and error events decode", () => {
    const parser = new SseParser();

    const frames = parser.push(
      encodeResultEvent("req-9", {
        mode: "empty",
        dishes: [],
        warnings: [],
        reasons: [],
        ranking: RankingProvenance.DeterministicCatalog(),
      }) + encodeErrorEvent("req-9", "rate_limited", 7),
    );

    expect(frames.length).toBe(2);
    expect(frames[0]?.kind).toBe("result");
    expect(frames[1]?.kind).toBe("error");

    if (frames[1]?.kind === "error") {
      expect(frames[1].error.retryAfterSeconds).toBe(7);
    }
  });

  test("stream headers disable proxy buffering and carry the request id", () => {
    const headers = streamResponseHeaders("req-7");
    expect(headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    expect(headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(headers.get("X-Accel-Buffering")).toBe("no");
    expect(headers.get("X-Request-Id")).toBe("req-7");
  });
});

describe("ProgressSink", () => {
  test("accepts a fresh ordered sequence through one terminal", () => {
    const sink = new ProgressSink();
    expect(sink.push(event({ seq: 0 }))).toBe("accept");
    expect(sink.push(event({ seq: 1, stage: "searching-catalog" }))).toBe("accept");
    expect(sink.push(event({ seq: 2, stage: "completed", terminal: true }))).toBe("accept");
    expect(sink.isTerminated()).toBe(true);
    expect(sink.seenTerminalCount()).toBe(1);
  });

  test("drops out-of-order and duplicate deliveries", () => {
    const sink = new ProgressSink();
    expect(sink.push(event({ seq: 0 }))).toBe("accept");
    expect(sink.push(event({ seq: 2, stage: "finalizing" }))).toBe("accept");
    expect(sink.push(event({ seq: 1, stage: "searching-catalog" }))).toBe("drop-stale");
    expect(sink.push(event({ seq: 2, stage: "finalizing" }))).toBe("drop-stale");
    expect(sink.isTerminated()).toBe(false);
  });

  test("drops terminal/stage mismatches and enforces terminal-once", () => {
    const sink = new ProgressSink();
    expect(sink.push(event({ seq: 0, stage: "completed", terminal: false }))).toBe(
      "drop-malformed",
    );
    expect(sink.push(event({ seq: 0, stage: "preparing", terminal: true }))).toBe("drop-malformed");
    expect(sink.push(event({ seq: 0, stage: "degraded", terminal: true }))).toBe("accept");
    expect(sink.push(event({ seq: 1, stage: "failed", terminal: true }))).toBe(
      "drop-after-terminal",
    );
    expect(sink.seenTerminalCount()).toBe(1);
  });

  test("nothing is accepted after terminal", () => {
    const sink = new ProgressSink();
    expect(sink.push(event({ seq: 0, stage: "failed", terminal: true }))).toBe("accept");
    expect(sink.push(event({ seq: 1, stage: "preparing" }))).toBe("drop-after-terminal");
  });
});

describe("ProgressEmitter", () => {
  test("assigns monotonic seq, closes exactly once, silent after terminal", () => {
    const emitter = new ProgressEmitter("req-3");
    const parser = new SseParser();

    const first = emitter.stage("preparing", null);
    const second = emitter.stage("searching-catalog", "Scanning eligible dishes");
    const terminal = emitter.terminal("completed", "Recommendations ready");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(terminal).not.toBeNull();
    expect(emitter.isClosed()).toBe(true);

    // No events after terminal: every post-terminal call returns null.
    expect(emitter.stage("finalizing", null)).toBeNull();
    expect(emitter.terminal("failed", "late")).toBeNull();

    const frames = parser.push([first, second, terminal].join(""));
    const seqs = frames.flatMap((frame) => (frame.kind === "progress" ? [frame.event.seq] : []));
    expect(seqs).toEqual([0, 1, 2]);

    // The emitted stream replays cleanly through the sink: single terminal.
    const sink = new ProgressSink();

    for (const frame of frames) {
      if (frame.kind === "progress") {
        expect(sink.push(frame.event)).toBe("accept");
      }
    }

    expect(sink.seenTerminalCount()).toBe(1);
  });
});
