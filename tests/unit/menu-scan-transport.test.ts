import { describe, expect, test } from "bun:test";

import { menuScanClient } from "@/modules/restaurant-discovery/menu-scan-client";
import {
  applyRetryAfter,
  handleMenuScanRequest,
} from "@/modules/restaurant-discovery/server/scan-http";
import { resetServerEnvCache } from "@/server/env";
import { clientFailureSchema } from "@/shared/client-failure";

/** Replaces the network boundary with a canned response; keeps fetch's full type. */
const stubFetch = (respond: () => Promise<Response>, originalFetch: typeof fetch): typeof fetch =>
  Object.assign(async (): Promise<Response> => respond(), { preconnect: originalFetch.preconnect });

const scanViewBodyFor = (scanId: string) => ({
  scan: {
    id: scanId,
    status: "complete",
    current_revision: 1,
    target_language: "en",
    venue_id: null,
    venue_name: null,
    expires_at: new Date().toISOString(),
  },
  assets: [],
  document: null,
  revision: null,
  contribution: null,
});

/** Raw wire payload decodeResponse parses; kept as text, as received. */
const retryableFailureJson = `{"_tag":"ExtractionUnavailable","code":"unavailable","status":503,"message":"Menu analysis is unavailable. Please retry later.","retryable":true,"retryAfterSeconds":30}`;

describe("concurrent Analyze taps share one extraction", () => {
  test("in-flight extract calls dedupe by scanId", async () => {
    const scanId = crypto.randomUUID();
    let calls = 0;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = stubFetch(async (): Promise<Response> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));

      return Response.json(scanViewBodyFor(scanId));
    }, originalFetch);

    try {
      const [first, second] = await Promise.all([
        menuScanClient.extract(scanId),
        menuScanClient.extract(scanId),
      ]);

      expect(calls).toBe(1);
      expect(first).toEqual(second);

      await menuScanClient.extract(scanId);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sharers receive the same typed retryable failure", async () => {
    const scanId = crypto.randomUUID();
    let calls = 0;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = stubFetch(async (): Promise<Response> => {
      calls += 1;

      return new Response(retryableFailureJson, { status: 503 });
    }, originalFetch);

    try {
      const outcomes = await Promise.allSettled([
        menuScanClient.extract(scanId),
        menuScanClient.extract(scanId),
      ]);

      expect(calls).toBe(1);

      for (const outcome of outcomes) {
        expect(outcome.status).toBe("rejected");

        if (outcome.status !== "rejected") throw new Error("unreachable");
        expect(outcome.reason).toMatchObject({ retryable: true, retryAfterSeconds: 30 });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("scan failure Retry-After honesty", () => {
  test("Retry-After is sent only for retryable failures", () => {
    const headers = new Headers();
    applyRetryAfter(headers, { retryable: true, retryAfterSeconds: 30 });
    expect(headers.get("Retry-After")).toBe("30");

    const withheld = new Headers();
    applyRetryAfter(withheld, { retryable: false, retryAfterSeconds: 30 });
    expect(withheld.get("Retry-After")).toBeNull();

    const absent = new Headers();
    applyRetryAfter(absent, { retryable: true, retryAfterSeconds: null });
    expect(absent.get("Retry-After")).toBeNull();
  });

  test("a non-retryable scan failure carries no Retry-After header", async () => {
    delete process.env["MENU_SCANNER_ENABLED"];
    resetServerEnvCache();

    // The transport only accepts same-origin actions; mirror the deployment origin.
    const appOrigin = new URL(process.env["BETTER_AUTH_URL"] ?? "http://localhost:3000").origin;

    const response = await handleMenuScanRequest(
      new Request(`${appOrigin}/api/menu-scans`, {
        method: "POST",
        headers: { origin: appOrigin, "content-type": "application/json" },
        body: JSON.stringify({ action: "extract", scanId: crypto.randomUUID() }),
      }),
    );

    const body = clientFailureSchema.parse(await response.json());

    expect(response.status).toBe(503);
    expect(body.retryable).toBe(false);
    expect(response.headers.get("Retry-After")).toBeNull();
  });
});
