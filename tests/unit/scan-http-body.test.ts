import { describe, expect, test } from "bun:test";

import { BodyLimitError, boundedBody } from "@/server/http/body-limit";

function streamRequest(bytes: Uint8Array, contentLength: string | null): Request {
  const headers = new Headers();

  if (contentLength !== null) headers.set("content-length", contentLength);

  return new Request("https://example.invalid/menu-scans", {
    method: "POST",
    headers,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    // @ts-expect-error Bun RequestInit duplex marker for stream bodies.
    duplex: "half",
  });
}

async function capture(input: Promise<Uint8Array>): Promise<BodyLimitError> {
  try {
    await input;
  } catch (error) {
    if (error instanceof BodyLimitError) return error;
    throw error;
  }

  throw new Error("Expected boundedBody to fail.");
}

describe("bounded menu-scan request bodies", () => {
  test("returns bytes within the declared and streamed budget", async () => {
    const bytes = new Uint8Array([1, 2, 3]);

    expect(
      await boundedBody(streamRequest(bytes, "3"), 1024, new AbortController().signal),
    ).toEqual(bytes);
  });

  test("rejects an overstated stream even when content-length fits", async () => {
    const failure = await capture(
      boundedBody(streamRequest(new Uint8Array(2048), "16"), 1024, new AbortController().signal),
    );

    expect(failure.reason).toContain("too large");
  });

  test("rejects an over-limit stream with a malformed content-length", async () => {
    const failure = await capture(
      boundedBody(
        streamRequest(new Uint8Array(2048), "not-a-number"),
        1024,
        new AbortController().signal,
      ),
    );

    expect(failure.reason).toContain("too large");
  });

  test("rejects a missing body", async () => {
    const failure = await capture(
      boundedBody(
        new Request("https://example.invalid/menu-scans", { method: "POST" }),
        1024,
        new AbortController().signal,
      ),
    );

    expect(failure.reason).toContain("missing");
  });

  test("an already-aborted request interrupts instead of allocating", async () => {
    const controller = new AbortController();
    controller.abort();

    const failure = await capture(
      boundedBody(streamRequest(new Uint8Array([1]), "1"), 1024, controller.signal),
    );

    expect(failure.reason).toContain("interrupted");
  });
});
