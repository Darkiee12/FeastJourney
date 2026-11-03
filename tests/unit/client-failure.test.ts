import { describe, expect, test } from "bun:test";

import { Data } from "effect";

import { clientFailure } from "@/server/http/client-failure";
import { clientFailureSchema } from "@/shared/client-failure";

class ScanNotFound extends Data.TaggedError("ScanNotFound")<{}> {}

class ExtractionUnavailable extends Data.TaggedError("ExtractionUnavailable")<{
  readonly reason: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
}> {}

class PersistenceError extends Data.TaggedError("PersistenceError")<{ readonly cause: string }> {}

describe("safe client failure transport", () => {
  test("preserves domain identity and status as plain serializable data", () => {
    const failure = clientFailure(new ScanNotFound());
    expect(failure._tag).toBe("ScanNotFound");
    expect(failure).toMatchObject({ status: 404, retryable: false });
    expect(clientFailureSchema.parse(JSON.parse(JSON.stringify(failure)))).toEqual(failure);
  });

  test("permanent provider failures do not advertise retry", () => {
    expect(
      clientFailure(
        new ExtractionUnavailable({ reason: "Private provider details", retryable: false }),
      ),
    ).toMatchObject({ status: 503, retryable: false });
  });

  test("retryable provider failures retain their cooldown", () => {
    expect(
      clientFailure(
        new ExtractionUnavailable({
          reason: "Not disclosed",
          retryable: true,
          retryAfterSeconds: 45,
        }),
      ),
    ).toMatchObject({ status: 503, retryable: true, retryAfterSeconds: 45 });
  });

  test("database failures disclose neither SQL nor private parameters", () => {
    const failure = clientFailure(
      new PersistenceError({ cause: "SELECT secret FROM private_customer_data" }),
    );

    expect(failure.status).toBe(500);
    expect(JSON.stringify(failure)).not.toContain("secret");
    expect(JSON.stringify(failure)).not.toContain("private_customer_data");
  });

  test("unexpected exceptions do not serialize their stack or message", () => {
    const failure = clientFailure(new Error("sensitive-internal-detail"));
    expect(failure._tag).toBe("InternalError");
    expect(failure).toMatchObject({ code: "internal", status: 500 });
    expect(JSON.stringify(failure)).not.toContain("sensitive-internal-detail");
    expect(failure).not.toHaveProperty("stack");
  });
});
