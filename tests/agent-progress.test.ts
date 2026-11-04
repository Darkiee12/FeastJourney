import { describe, expect, test } from "bun:test";

import {
  applyProgressEvent,
  consumeProgressStream,
  initialAgentProgress,
  isActiveProgressStage,
  isProgressEvent,
  parseProgressLine,
  presenceForSnapshot,
  type AgentProgressSnapshot,
} from "@/components/home/recommend/agent-progress";
import type { ProgressEvent } from "@/modules/food-discovery/server/agent/protocol";

const REQUEST_ID = "req-1";

const makeEvent = (
  overrides: Partial<ProgressEvent> & { readonly seq: number },
): ProgressEvent => ({
  requestId: REQUEST_ID,
  stage: "preparing",
  detail: null,
  terminal: false,
  ...overrides,
});

const streamOf = (chunks: ReadonlyArray<string>): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const parts = chunks.map((chunk) => encoder.encode(chunk));

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }

      controller.close();
    },
  });
};

const liveForStage = (stage: AgentProgressSnapshot["stage"]): boolean => {
  const snapshot: AgentProgressSnapshot = {
    ...initialAgentProgress(REQUEST_ID),
    started: true,
    stage,
    lastSeq: 0,
    eventCount: 1,
  };

  return presenceForSnapshot(snapshot).live;
};

describe("isProgressEvent validates the network boundary", () => {
  test("accepts a well-formed event and ignores extra keys", () => {
    const wire = {
      requestId: "r",
      seq: 0,
      stage: "muse-curating",
      detail: "x",
      terminal: false,
      extra: 1,
    };

    expect(isProgressEvent(wire)).toBe(true);
  });

  test("rejects non-objects, arrays, and missing fields", () => {
    expect(isProgressEvent(null)).toBe(false);
    expect(isProgressEvent("nope")).toBe(false);
    expect(isProgressEvent([])).toBe(false);
    expect(isProgressEvent({ requestId: "r", seq: 0, stage: "preparing", terminal: false })).toBe(
      false,
    );
  });

  test("rejects empty request IDs, non-integer or negative seq, unknown stages", () => {
    const base = { requestId: "r", stage: "preparing", detail: null, terminal: false };

    expect(isProgressEvent({ ...base, requestId: "", seq: 0 })).toBe(false);
    expect(isProgressEvent({ ...base, seq: -1 })).toBe(false);
    expect(isProgressEvent({ ...base, seq: 1.5 })).toBe(false);
    expect(isProgressEvent({ ...base, seq: Number.NaN })).toBe(false);
    expect(isProgressEvent({ ...base, seq: 0, stage: "pondering" })).toBe(false);
    expect(isProgressEvent({ ...base, seq: 0, terminal: "yes" })).toBe(false);
    expect(isProgressEvent({ ...base, seq: 0, detail: 42 })).toBe(false);
  });
});

describe("applyProgressEvent keeps the snapshot monotonic", () => {
  test("first in-order event starts the snapshot", () => {
    const next = applyProgressEvent(initialAgentProgress(REQUEST_ID), makeEvent({ seq: 0 }));

    expect(next.started).toBe(true);
    expect(next.stage).toBe("preparing");
    expect(next.lastSeq).toBe(0);
    expect(next.eventCount).toBe(1);
  });

  test("drops duplicates and out-of-order arrivals", () => {
    let state = initialAgentProgress(REQUEST_ID);

    state = applyProgressEvent(state, makeEvent({ seq: 0, stage: "preparing" }));
    state = applyProgressEvent(state, makeEvent({ seq: 2, stage: "muse-curating" }));

    const duplicate = applyProgressEvent(state, makeEvent({ seq: 2, stage: "finalizing" }));
    const older = applyProgressEvent(state, makeEvent({ seq: 1, stage: "searching-catalog" }));

    expect(duplicate).toBe(state);
    expect(older).toBe(state);
    expect(state.stage).toBe("muse-curating");
    expect(state.eventCount).toBe(2);
  });

  test("drops events for a stale request and everything after terminal", () => {
    let state = initialAgentProgress(REQUEST_ID);

    state = applyProgressEvent(state, makeEvent({ seq: 0 }));

    const stale = applyProgressEvent(state, { ...makeEvent({ seq: 1 }), requestId: "req-2" });

    expect(stale).toBe(state);

    const terminal = applyProgressEvent(
      state,
      makeEvent({ seq: 1, stage: "completed", terminal: true }),
    );

    expect(terminal.terminal).toBe(true);

    const after = applyProgressEvent(terminal, makeEvent({ seq: 2, stage: "finalizing" }));

    expect(after).toBe(terminal);
  });

  test("advances stage and detail on genuine transitions", () => {
    let state = initialAgentProgress(REQUEST_ID);

    state = applyProgressEvent(state, makeEvent({ seq: 0, stage: "searching-catalog" }));
    state = applyProgressEvent(
      state,
      makeEvent({ seq: 1, stage: "inspecting-dishes", detail: "3 dishes" }),
    );

    expect(state.stage).toBe("inspecting-dishes");
    expect(state.detail).toBe("3 dishes");
  });
});

describe("parseProgressLine separates events from heartbeats", () => {
  test("blank lines and SSE comments are heartbeats, never stages", () => {
    expect(parseProgressLine("")).toEqual({ kind: "heartbeat" });
    expect(parseProgressLine("   ")).toEqual({ kind: "heartbeat" });
    expect(parseProgressLine(": keep-alive")).toEqual({ kind: "heartbeat" });
    expect(parseProgressLine("event: progress")).toEqual({ kind: "heartbeat" });
    expect(parseProgressLine("data:")).toEqual({ kind: "heartbeat" });
  });

  test("accepts bare NDJSON and data-prefixed SSE framing", () => {
    const line = JSON.stringify(makeEvent({ seq: 0 }));

    const bare = parseProgressLine(line);
    const framed = parseProgressLine("data: " + line);

    expect(bare.kind).toBe("event");
    expect(framed.kind).toBe("event");
  });

  test("invalid JSON and wrong shapes are invalid, never fatal", () => {
    expect(parseProgressLine("not json").kind).toBe("invalid");
    expect(parseProgressLine('{"seq": 0}').kind).toBe("invalid");

    const wrongStage = '{"requestId":"r","seq":0,"stage":"nope","detail":null,"terminal":false}';

    expect(parseProgressLine(wrongStage).kind).toBe("invalid");
  });
});

describe("consumeProgressStream reads framed bytes", () => {
  test("reassembles events split across chunk boundaries", async () => {
    const first = JSON.stringify(makeEvent({ seq: 0, stage: "preparing" }));
    const second = JSON.stringify(makeEvent({ seq: 1, stage: "finalizing", terminal: true }));

    const seen: Array<ProgressEvent> = [];

    const result = await consumeProgressStream(
      streamOf([first.slice(0, 20), first.slice(20) + "\n" + second + "\n"]),
      { onEvent: (event) => seen.push(event) },
    );

    expect(result).toEqual({ events: 2, invalidLines: 0, end: { reason: "terminal" } });
    expect(seen.map((event) => event.seq)).toEqual([0, 1]);
  });

  test("counts invalid lines but keeps consuming, CRLF included", async () => {
    const valid = JSON.stringify(makeEvent({ seq: 0, terminal: true }));

    const invalid: Array<string> = [];
    const seen: Array<ProgressEvent> = [];

    const result = await consumeProgressStream(streamOf(["oops\n" + valid + '\r\n{"seq":1}\n']), {
      onEvent: (event) => seen.push(event),
      onInvalidLine: (line) => invalid.push(line),
    });

    expect(result.events).toBe(1);
    expect(result.invalidLines).toBe(2);
    expect(result.end).toEqual({ reason: "terminal" });
    expect(invalid).toEqual(["oops", '{"seq":1}']);
  });

  test("EOF without a terminal event reports an interrupted stream", async () => {
    const line = JSON.stringify(makeEvent({ seq: 0 }));

    const seen: Array<ProgressEvent> = [];

    const result = await consumeProgressStream(streamOf([line + "\n"]), {
      onEvent: (event) => seen.push(event),
    });

    expect(result.end).toEqual({ reason: "closed" });
    expect(seen).toHaveLength(1);
  });

  test("skips heartbeats without counting events", async () => {
    const result = await consumeProgressStream(streamOf(["\n: ping\n\ndata:\n"]), {
      onEvent: () => {
        throw new Error("heartbeat must never surface as an event");
      },
    });

    expect(result).toEqual({ events: 0, invalidLines: 0, end: { reason: "closed" } });
  });

  test("aborts promptly on cancellation", async () => {
    const controller = new AbortController();

    controller.abort();

    const hanging = new ReadableStream<Uint8Array>({ start() {} });

    const result = await consumeProgressStream(
      hanging,
      {
        onEvent: () => {
          throw new Error("aborted streams deliver no events");
        },
      },
      controller.signal,
    );

    expect(result.end).toEqual({ reason: "aborted" });
  });

  test("aborts between chunks and keeps events already applied", async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const first = JSON.stringify(makeEvent({ seq: 0 }));
    const second = JSON.stringify(makeEvent({ seq: 1 }));

    const seen: Array<ProgressEvent> = [];

    let pulls = 0;

    // One chunk per pull: after the first event the callback cancels, so the
    // already-queued second chunk is never read and its event never applies.
    const stream = new ReadableStream<Uint8Array>({
      pull(push) {
        pulls += 1;
        push.enqueue(encoder.encode(pulls === 1 ? first + "\n" : second + "\n"));
      },
    });

    const result = await consumeProgressStream(
      stream,
      {
        onEvent: (event) => {
          seen.push(event);
          controller.abort();
        },
      },
      controller.signal,
    );

    expect(result.end).toEqual({ reason: "aborted" });
    expect(seen.map((event) => event.seq)).toEqual([0]);
  });
});

describe("presence gating stays honest", () => {
  test("idle snapshots never go live", () => {
    expect(presenceForSnapshot(null)).toEqual({ stage: null, live: false });
    expect(presenceForSnapshot(initialAgentProgress(REQUEST_ID))).toEqual({
      stage: null,
      live: false,
    });
  });

  test("only active stages go live; terminal stages stay neutral", () => {
    expect(liveForStage("preparing")).toBe(true);
    expect(liveForStage("muse-curating")).toBe(true);
    expect(liveForStage("completed")).toBe(false);
    expect(liveForStage("degraded")).toBe(false);
    expect(liveForStage("failed")).toBe(false);
  });

  test("active-stage set matches the five ongoing stages", () => {
    expect(isActiveProgressStage("preparing")).toBe(true);
    expect(isActiveProgressStage("searching-catalog")).toBe(true);
    expect(isActiveProgressStage("muse-curating")).toBe(true);
    expect(isActiveProgressStage("inspecting-dishes")).toBe(true);
    expect(isActiveProgressStage("finalizing")).toBe(true);
    expect(isActiveProgressStage("completed")).toBe(false);
    expect(isActiveProgressStage("degraded")).toBe(false);
    expect(isActiveProgressStage("failed")).toBe(false);
  });
});
