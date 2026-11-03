import { afterEach, describe, expect, test } from "bun:test";

import { z } from "zod";

import { handleMenuScanRequest } from "@/modules/restaurant-discovery/server/scan-http";
import { resetServerEnvCache } from "@/server/env";

const failureSchema = z.object({ _tag: z.string(), message: z.string() });

const readFailure = async (response: Response) => failureSchema.parse(await response.json());

const ENDPOINT = "http://localhost:3000/api/menu-scans";

const createRequest = () =>
  new Request(ENDPOINT, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "create", targetLanguage: "en", venueId: null }),
  });

afterEach(() => {
  delete process.env["MENU_SCANNER_ENABLED"];
  delete process.env["MODEL_API_KEY"];
  resetServerEnvCache();
});

describe("menu scan creation with scanner misconfiguration", () => {
  test("a disabled scanner is a 503 outage, not a 400 user error", async () => {
    const response = await handleMenuScanRequest(createRequest());
    const body = await readFailure(response);

    expect(response.status).toBe(503);
    expect(body._tag).toBe("ExtractionUnavailable");
    expect(body.message).toBe("Menu analysis is unavailable. Please retry later.");
    expect(JSON.stringify(body)).not.toContain("enabled");
  });

  test("an enabled scanner without credentials is a 503 outage, not a 400 user error", async () => {
    process.env["MENU_SCANNER_ENABLED"] = "true";
    delete process.env["MODEL_API_KEY"];
    resetServerEnvCache();

    const response = await handleMenuScanRequest(createRequest());
    const body = await readFailure(response);

    expect(response.status).toBe(503);
    expect(body._tag).toBe("ExtractionUnavailable");
    expect(body.message).toBe("Menu analysis is unavailable. Please retry later.");
    expect(JSON.stringify(body)).not.toContain("MODEL_API_KEY");
  });
});
