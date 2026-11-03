import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import {
  acceptableRate,
  frankfurterProvider,
  parsePairCsv,
} from "@/modules/restaurant-discovery/server/operations/fx-provider";

const csv = "date,base,quote,rate\n2026-10-28,VND,USD,0.000038765123456789123456789\n";

describe("Frankfurter v2 adapter (mock HTTP only)", () => {
  test("preserves every provider decimal and checks pair direction", () => {
    expect(parsePairCsv(csv, "VND", "USD", "fixture").rate).toBe("0.000038765123456789123456789");
    expect(() => parsePairCsv(csv, "USD", "VND", "fixture")).toThrow();
  });
  test("rejects malformed dates, extra rows, nonpositive and invalid rates", () => {
    for (const body of [
      "{}",
      csv + "2026-10-28,VND,USD,1",
      csv.replace("2026-10-28", "2026-02-30"),
      ...["0", "-1", "NaN", "Infinity", "1e-4"].map(
        (rate) => `date,base,quote,rate\n2026-10-28,VND,USD,${rate}`,
      ),
    ]) {
      expect(() => parsePairCsv(body, "VND", "USD", "fixture")).toThrow();
    }
  });
  test("uses configured endpoint, base and quote with CSV", async () => {
    const requested: Array<string> = [];

    const provider = frankfurterProvider("https://fx.example.test/v2", async (url) => {
      requested.push(url.toString());

      return new Response(csv);
    });

    const rate = await Effect.runPromise(provider.pair("VND", "USD"));
    expect(rate.base).toBe("VND");
    expect(rate.quote).toBe("USD");
    expect(requested).toEqual(["https://fx.example.test/v2/rates.csv?base=VND&quotes=USD"]);
  });
  test.each([400, 404, 422, 429, 500, 503])(
    "turns HTTP %s into a typed unavailable failure",
    async (status) => {
      const provider = frankfurterProvider(
        "https://fx.example.test/v2/",
        async () => new Response("{}", { status }),
      );

      const failure = await Effect.runPromise(Effect.flip(provider.pair("VND", "USD")));
      expect(failure._tag).toBe("FxUnavailable");
    },
  );
  test("turns timeout and invalid response into typed failures", async () => {
    const timeout = frankfurterProvider("https://fx.example.test/v2/", () =>
      Promise.reject(new DOMException("timed out", "TimeoutError")),
    );

    const invalid = frankfurterProvider(
      "https://fx.example.test/v2/",
      async () => new Response("not CSV"),
    );

    expect((await Effect.runPromise(Effect.flip(timeout.pair("EUR", "USD"))))._tag).toBe(
      "FxUnavailable",
    );
    expect((await Effect.runPromise(Effect.flip(invalid.pair("EUR", "USD"))))._tag).toBe(
      "FxUnavailable",
    );
  });
  test("accepts only provider-supported ISO currencies, excluding crypto", async () => {
    const provider = frankfurterProvider("https://fx.example.test/v2/", async () =>
      Response.json([
        { iso_code: "VND", iso_numeric: "704" },
        { iso_code: "USD", iso_numeric: "840" },
        { iso_code: "BTC", iso_numeric: null },
        { iso_code: "XYZ", iso_numeric: "001" },
      ]),
    );

    expect(await Effect.runPromise(provider.currencies)).toEqual(["VND", "USD"]);
  });
  test("cancels oversized streamed bodies before reading the entire response", async () => {
    let cancelled = false;
    let chunks = 0;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(100000));
      },
      cancel() {
        cancelled = true;
      },
    });

    const provider = frankfurterProvider(
      "https://fx.example.test/v2/",
      async () => new Response(stream),
    );

    expect((await Effect.runPromise(Effect.flip(provider.pair("VND", "USD"))))._tag).toBe(
      "FxUnavailable",
    );
    expect(cancelled).toBe(true);
    expect(chunks).toBeLessThanOrEqual(3);
  });
  test("rejects declared oversized bodies without consuming them", async () => {
    let cancelled = false;

    const provider = frankfurterProvider(
      "https://fx.example.test/v2/",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-length": "150001" } },
        ),
    );

    expect((await Effect.runPromise(Effect.flip(provider.pair("VND", "USD"))))._tag).toBe(
      "FxUnavailable",
    );
    expect(cancelled).toBe(true);
  });
  test("measures holiday/weekend freshness using effective date rather than fetch date", () => {
    const friday = {
      base: "USD",
      quote: "VND",
      rate: "25000",
      effectiveDate: "2026-10-23",
      provider: "fixture",
    };

    expect(acceptableRate(friday, Date.parse("2026-10-25T12:00:00Z"), 72 * 3600000)).toBe(true);
    expect(acceptableRate(friday, Date.parse("2026-10-28T12:00:00Z"), 72 * 3600000)).toBe(false);
    expect(acceptableRate(friday, Date.parse("2026-10-22T12:00:00Z"), 72 * 3600000)).toBe(false);
  });
});
