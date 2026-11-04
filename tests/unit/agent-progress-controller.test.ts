import { describe, expect, test } from "bun:test";

import {
  AgentStreamController,
  canonicalStreamKey,
} from "@/components/home/recommend/agent-progress-controller";
import {
  encodeErrorEvent,
  encodeProgressEvent,
  encodeResultEvent,
} from "@/modules/food-discovery/server/agent/stream-codec";

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
  encodeProgressEvent({ requestId: "r1", seq: 0, stage: "preparing", detail: null, terminal: false }),
  encodeProgressEvent({ requestId: "r1", seq: 1, stage: "searching-catalog", detail: null, terminal: false }),
  // Out-of-order redelivery of seq 1: must drop.
  encodeProgressEvent({ requestId: "r1", seq: 1, stage: "searching-catalog", detail: null, terminal: false }),
  encodeProgressEvent({ requestId: "r1", seq: 2, stage: "completed", detail: null, terminal: true }),
  encodeResultEvent("r1", { mode: "deterministic", dishes: [{ id: "1" }] }),
];

const okFetch = (chunks: Array<string> = successChunks): typeof fetch =>
  (() =>
    Promise.resolve(
      new Response(sseBody(chunks), { status: 200, headers: { "content-type": "text/event-stream" } }),
    )) as typeof fetch;

describe("AgentStreamController", () => {
  test("streams progress, commits only the terminal result", async () => {
    const controller = new AgentStreamController<Record<string, unknown>>();
    const seen: Array<string> = [];
    let done: Record<string, unknown> | null = null;

    const { done: finished } = controller.start({ meal: "dinner" }, "key-1", { requestId: "r1", fetchImpl: okFetch() }, {
      onProgress: (event) => {
        seen.push(`${event.seq}:${event.stage}`);
      },
      onDone: (result) => {
        done = result;
      },
    });

    const result = await finished;
    // Duplicate seq-1 redelivery never reached onProgress.
    expect(seen).toEqual(["0:preparing", "1:searching-catalog", "2:completed"]);
    expect(done).not.toBeNull();
    expect((result as { mode: string }).mode).toBe("deterministic");
    // Back-nav cache holds the committed result.
    expect(controller.cachedResult("key-1")).toEqual(result);
  });

  test("interrupted stream errors without committing", async () => {
    const encoder = new TextEncoder();
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            encodeProgressEvent({ requestId: "r2", seq: 0, stage: "preparing", detail: null, terminal: false }),
          ),
        );
        controller.error(new Error("connection reset"));
      },
    });
    const fetchImpl = (() =>
      Promise.resolve(new Response(broken, { status: 200 }))) as typeof fetch;

    const controller = new AgentStreamController();
    let done = false;
    let code: string | null = null;
    const { done: finished } = controller.start({ meal: "dinner" }, "key-2", { requestId: "r2", fetchImpl }, {
      onDone: () => {
        done = true;
      },
      onError: (errorCode) => {
        code = errorCode;
      },
    });

    await expect(finished).rejects.toThrow();
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
          encodeProgressEvent({ requestId: "r3", seq: 0, stage: "preparing", detail: null, terminal: false }),
        ]),
      },
      {
        onDone: () => {
          committed = true;
        },
      },
    );
    await expect(finished).rejects.toThrow("truncated");
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
    await expect(finished).rejects.toThrow("rate_limited");
    expect(code).toBe("rate_limited");
  });

  test("navigation cancellation aborts and late frames never commit", async () => {
    const aborter = new AbortController();
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => {
          reject(new DOMException("aborted", "AbortError"));
        };
        if (init?.signal?.aborted === true) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener("abort", onAbort, { once: true });
      })) as typeof fetch;

    const controller = new AgentStreamController();
    let committed = false;
    let code: string | null = null;
    const { done: finished } = controller.start({ meal: "dinner" }, "key-5", {
      requestId: "r5",
      fetchImpl,
      signal: aborter.signal,
    }, {
      onDone: () => {
        committed = true;
      },
      onError: (errorCode) => {
        code = errorCode;
      },
    });

    aborter.abort();
    await expect(finished).rejects.toThrow();
    expect(committed).toBe(false);
    expect(code).toBe("aborted");
    expect(controller.cachedResult("key-5")).toBeNull();
  });

  test("stale attempt resolving after a newer start never commits", async () => {
    const encoder = new TextEncoder();
    const deferreds: Array<() => void> = [];
    const gatedFetch = ((_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const gate = new Promise<void>((resolve) => {
        deferreds.push(resolve);
      });
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await gate;
          const body = JSON.parse((init?.body as string | null) ?? "{}") as { marker?: string };
          const marker = body.marker === "new" ? "new" : "old";
          controller.enqueue(encoder.encode(encodeProgressEvent({ requestId: marker, seq: 0, stage: "completed", detail: null, terminal: true })));
          controller.enqueue(encoder.encode(encodeResultEvent(marker, { marker })));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as typeof fetch;

    const controller = new AgentStreamController<Record<string, unknown>>();
    const committed: Array<string> = [];

    const first = controller.start({ marker: "old" }, "key-old", { requestId: "old", fetchImpl: gatedFetch }, {
      onDone: (result) => {
        committed.push(result["marker"] as string);
      },
    });
    const second = controller.start({ marker: "new" }, "key-new", { requestId: "new", fetchImpl: gatedFetch }, {
      onDone: (result) => {
        committed.push(result["marker"] as string);
      },
    });

    // Newer attempt finishes first and commits; the older attempt resolves
    // later and resolves its promise without committing.
    deferreds[1]?.();
    await expect(second.done).resolves.toEqual({ marker: "new" });
    deferreds[0]?.();
    await expect(first.done).resolves.toEqual({ marker: "old" });
    expect(committed).toEqual(["new"]);
  });

  test("concurrent duplicate submissions share one fetch", async () => {
    let calls = 0;
    const counting = ((): Promise<Response> => {
      calls += 1;
      return Promise.resolve(
        new Response(sseBody(successChunks), { status: 200 }),
      );
    }) as typeof fetch;

    const controller = new AgentStreamController();
    const first = controller.start({ meal: "dinner" }, "key-dupe", { requestId: "a", fetchImpl: counting });
    const second = controller.start({ meal: "dinner" }, "key-dupe", { requestId: "b", fetchImpl: counting });
    await expect(first.done).resolves.toBeDefined();
    await expect(second.done).resolves.toBeDefined();
    expect(calls).toBe(1);
  });

  test("cache identity isolates actors and key order, honors TTL", async () => {
    const base = { mood: "comfort", meal: "dinner" };
    const reordered = { meal: "dinner", mood: "comfort" };
    const keyA = canonicalStreamKey({ payload: base, actorId: "guest", locale: "en", agentEnabled: true });
    const keyB = canonicalStreamKey({ payload: reordered, actorId: "guest", locale: "en", agentEnabled: true });
    const keyC = canonicalStreamKey({ payload: base, actorId: "member-1", locale: "en", agentEnabled: true });
    const keyD = canonicalStreamKey({ payload: base, actorId: "guest", locale: "vi", agentEnabled: true });
    const keyE = canonicalStreamKey({ payload: base, actorId: "guest", locale: "en", agentEnabled: false });
    expect(keyA).toBe(keyB);
    expect(new Set([keyA, keyC, keyD, keyE]).size).toBe(4);

    // TTL: populate through a real stream, then read fresh vs far-future.
    const controller = new AgentStreamController<Record<string, unknown>>();
    const { done } = controller.start({ meal: "dinner" }, keyA, { requestId: "ttl", fetchImpl: okFetch() });
    const result = await done;
    expect(controller.cachedResult(keyA)).toEqual(result);
    expect(controller.cachedResult(keyA, Date.now() + 10 * 60_000)).toBeNull();
    // A different actor's key never sees this entry.
    expect(controller.cachedResult(keyC)).toBeNull();
  });
});
