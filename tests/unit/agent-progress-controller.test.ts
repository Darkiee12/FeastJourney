import { describe, expect, test } from "bun:test";

import {
  AgentStreamController,
  canonicalStreamKey,
  type StreamFetch,
} from "@/components/home/recommend/agent-progress-controller";
import {
  encodeErrorEvent,
  encodeProgressEvent,
} from "@/modules/food-discovery/server/agent/stream-codec";

/** Narrow wire contract for the deterministic success chunks below. */
interface ModeWire {
  readonly mode: string;
}

/** Narrow wire contract for the stale-guard markers below. */
interface MarkerWire {
  readonly marker: string;
}

const sseBody = (chunks: Array<string>): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }

      controller.close();
    },
  });
};

const successChunks = [
  encodeProgressEvent({
    requestId: "r1",
    seq: 0,
    stage: "preparing",
    detail: null,
    terminal: false,
  }),
  encodeProgressEvent({
    requestId: "r1",
    seq: 1,
    stage: "searching-catalog",
    detail: null,
    terminal: false,
  }),
  // Out-of-order redelivery of seq 1: must drop.
  encodeProgressEvent({
    requestId: "r1",
    seq: 1,
    stage: "searching-catalog",
    detail: null,
    terminal: false,
  }),
  encodeProgressEvent({
    requestId: "r1",
    seq: 2,
    stage: "completed",
    detail: null,
    terminal: true,
  }),
  `event: result\ndata: {"requestId":"r1","wire":{"mode":"deterministic"}}\n\n`,
];

const okFetch =
  (chunks: Array<string> = successChunks): StreamFetch =>
  () =>
    Promise.resolve(
      new Response(sseBody(chunks), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

/** Aborts on signal; used by the navigation-cancellation test. */
const abortingFetch: StreamFetch = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException("aborted", "AbortError"));
    };

    if (init?.signal?.aborted === true) {
      reject(new DOMException("aborted", "AbortError"));

      return;
    }

    init?.signal?.addEventListener("abort", onAbort, { once: true });
  });

describe("AgentStreamController", () => {
  test("streams progress, commits only the terminal result", async () => {
    const controller = new AgentStreamController<ModeWire>();
    const seen: Array<string> = [];
    let done: ModeWire | null = null;

    const { done: finished } = controller.start(
      { meal: "dinner" },
      "key-1",
      { requestId: "r1", fetchImpl: okFetch() },
      {
        onProgress: (event) => {
          seen.push(`${event.seq}:${event.stage}`);
        },
        onDone: (result) => {
          done = result;
        },
      },
    );

    const result = await finished;
    // Duplicate seq-1 redelivery never reached onProgress.
    expect(seen).toEqual(["0:preparing", "1:searching-catalog", "2:completed"]);
    expect(done).not.toBeNull();
    expect(result.mode).toBe("deterministic");
    // Back-nav cache holds the committed result.
    expect(controller.cachedResult("key-1")).toEqual(result);
  });

  test("interrupted stream errors without committing", async () => {
    const encoder = new TextEncoder();

    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            encodeProgressEvent({
              requestId: "r2",
              seq: 0,
              stage: "preparing",
              detail: null,
              terminal: false,
            }),
          ),
        );
        controller.error(new Error("connection reset"));
      },
    });

    const fetchImpl: StreamFetch = () => Promise.resolve(new Response(broken, { status: 200 }));

    const controller = new AgentStreamController();
    let done = false;
    let code: string | null = null;

    const { done: finished } = controller.start(
      { meal: "dinner" },
      "key-2",
      { requestId: "r2", fetchImpl },
      {
        onDone: () => {
          done = true;
        },
        onError: (errorCode) => {
          code = errorCode;
        },
      },
    );

    expect(finished).rejects.toThrow();
    expect(done).toBe(false);
    expect(code).toBe("interrupted");
    expect(controller.cachedResult("key-2")).toBeNull();
  });

  test("truncated stream (no terminal) never commits", async () => {
    const controller = new AgentStreamController();
    let committed = false;

    const { done: finished } = controller.start(
      { meal: "dinner" },
      "key-3",
      {
        requestId: "r3",
        fetchImpl: okFetch([
          encodeProgressEvent({
            requestId: "r3",
            seq: 0,
            stage: "preparing",
            detail: null,
            terminal: false,
          }),
        ]),
      },
      {
        onDone: () => {
          committed = true;
        },
      },
    );

    expect(finished).rejects.toThrow("truncated");
    expect(committed).toBe(false);
  });

  test("server error event surfaces the code and ends the attempt", async () => {
    const controller = new AgentStreamController();
    let code: string | null = null;

    const { done: finished } = controller.start(
      { meal: "dinner" },
      "key-4",
      { requestId: "r4", fetchImpl: okFetch([encodeErrorEvent("r4", "rate_limited", 12)]) },
      {
        onError: (errorCode) => {
          code = errorCode;
        },
      },
    );

    expect(finished).rejects.toThrow("rate_limited");
    expect(code).toBe("rate_limited");
  });

  test("navigation cancellation aborts and late frames never commit", async () => {
    const aborter = new AbortController();

    const controller = new AgentStreamController();
    let committed = false;
    let code: string | null = null;

    const { done: finished } = controller.start(
      { meal: "dinner" },
      "key-5",
      {
        requestId: "r5",
        fetchImpl: abortingFetch,
        signal: aborter.signal,
      },
      {
        onDone: () => {
          committed = true;
        },
        onError: (errorCode) => {
          code = errorCode;
        },
      },
    );

    aborter.abort();
    expect(finished).rejects.toThrow();
    expect(committed).toBe(false);
    expect(code).toBe("aborted");
    expect(controller.cachedResult("key-5")).toBeNull();
  });

  test("stale attempt resolving after a newer start never commits", async () => {
    const encoder = new TextEncoder();
    const deferreds: Array<() => void> = [];
    let calls = 0;

    // Call-ordered markers (no body parsing): the first started attempt is
    // "old", the second is "new". Gates resolve newest-first below.
    const gatedFetch: StreamFetch = () => {
      calls += 1;
      const marker = calls === 1 ? "old" : "new";

      const gate = new Promise<void>((resolve) => {
        deferreds.push(resolve);
      });

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await gate;
          controller.enqueue(
            encoder.encode(
              encodeProgressEvent({
                requestId: marker,
                seq: 0,
                stage: "completed",
                detail: null,
                terminal: true,
              }),
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: result\ndata: ${JSON.stringify({ requestId: marker, wire: { marker } })}\n\n`,
            ),
          );
          controller.close();
        },
      });

      return Promise.resolve(new Response(stream, { status: 200 }));
    };

    const controller = new AgentStreamController<MarkerWire>();
    const committed: Array<string> = [];

    const first = controller.start(
      { marker: "old" },
      "key-old",
      { requestId: "old", fetchImpl: gatedFetch },
      {
        onDone: (result) => {
          committed.push(result.marker);
        },
      },
    );

    const second = controller.start(
      { marker: "new" },
      "key-new",
      { requestId: "new", fetchImpl: gatedFetch },
      {
        onDone: (result) => {
          committed.push(result.marker);
        },
      },
    );

    // Newer attempt finishes first and commits; the older attempt resolves
    // later and resolves its promise without committing.
    deferreds[1]?.();
    expect(second.done).resolves.toEqual({ marker: "new" });
    deferreds[0]?.();
    expect(first.done).resolves.toEqual({ marker: "old" });
    expect(committed).toEqual(["new"]);
  });

  test("concurrent duplicate submissions share one fetch", async () => {
    let calls = 0;

    const counting: StreamFetch = () => {
      calls += 1;

      return Promise.resolve(new Response(sseBody(successChunks), { status: 200 }));
    };

    const controller = new AgentStreamController();

    const first = controller.start({ meal: "dinner" }, "key-dupe", {
      requestId: "a",
      fetchImpl: counting,
    });

    const second = controller.start({ meal: "dinner" }, "key-dupe", {
      requestId: "b",
      fetchImpl: counting,
    });

    expect(first.done).resolves.toBeDefined();
    expect(second.done).resolves.toBeDefined();
    expect(calls).toBe(1);
  });

  test("cache identity isolates actors and key order, honors TTL", async () => {
    const base = { mood: "comfort", meal: "dinner" };
    const reordered = { meal: "dinner", mood: "comfort" };

    const keyA = canonicalStreamKey({
      payload: base,
      actorId: "guest",
      locale: "en",
      agentEnabled: true,
    });

    const keyB = canonicalStreamKey({
      payload: reordered,
      actorId: "guest",
      locale: "en",
      agentEnabled: true,
    });

    const keyC = canonicalStreamKey({
      payload: base,
      actorId: "member-1",
      locale: "en",
      agentEnabled: true,
    });

    const keyD = canonicalStreamKey({
      payload: base,
      actorId: "guest",
      locale: "vi",
      agentEnabled: true,
    });

    const keyE = canonicalStreamKey({
      payload: base,
      actorId: "guest",
      locale: "en",
      agentEnabled: false,
    });

    expect(keyA).toBe(keyB);
    expect(new Set([keyA, keyC, keyD, keyE]).size).toBe(4);

    // TTL: populate through a real stream, then read fresh vs far-future.
    const controller = new AgentStreamController<ModeWire>();

    const { done } = controller.start({ meal: "dinner" }, keyA, {
      requestId: "ttl",
      fetchImpl: okFetch(),
    });

    const result = await done;
    expect(controller.cachedResult(keyA)).toEqual(result);
    expect(controller.cachedResult(keyA, Date.now() + 10 * 60_000)).toBeNull();
    // A different actor's key never sees this entry.
    expect(controller.cachedResult(keyC)).toBeNull();
  });
});
