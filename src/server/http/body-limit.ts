import { Data } from "effect";

/**
 * Transport helper failure. The HTTP adapter maps it to a client-safe
 * `ScanInputError`; it never escapes the transport boundary, so no
 * client-failure trouble code is registered for this tag.
 */
export class BodyLimitError extends Data.TaggedError("BodyLimitError")<{
  readonly reason: string;
}> {}

/** Count bytes before JSON/form-data allocation. The outer request budget covers reads. */
export async function boundedBody(
  request: Request,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > limit || request.body === null)
    throw new BodyLimitError({ reason: "Request body is missing or too large." });
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let length = 0;

  const abort = () => {
    void reader.cancel();
  };

  signal.addEventListener("abort", abort, { once: true });

  try {
    for (;;) {
      if (signal.aborted) throw new BodyLimitError({ reason: "Upload was interrupted." });
      // oxlint-disable-next-line no-await-in-loop -- A stream reader advances one chunk at a time.
      const part = await reader.read();

      if (part.done) break;
      length += part.value.length;

      if (length > limit)
        throw new BodyLimitError({
          reason: "The upload is too large. Choose a smaller photograph.",
        });
      chunks.push(part.value);
    }

    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel();
  }
}
