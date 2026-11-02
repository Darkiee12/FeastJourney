import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import {
  assertImportUrlAllowed,
  buildImportAttribution,
  fetchImportBytes,
  resolvePhotoScope,
  toStagingInput,
  verifyPhotoRights,
  MAX_IMPORT_BYTES,
  type PhotoImportFetchBlocked,
  type PhotoRightsCandidate,
} from "@/modules/restaurant-discovery/server/operations/photo-import";

const candidate = (overrides: Partial<PhotoRightsCandidate>): PhotoRightsCandidate => ({
  license: "cc-by",
  creator: "Linh Nguyen",
  title: "Pho Bo",
  sourceUrl: "https://example.com/photos/pho-bo",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  modificationNote: null,
  adapted: false,
  permissionRef: null,
  ...overrides,
});

/** Routes by URL so redirect and content-type behavior is scriptable per test. */
const stubFetch = (respond: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch =>
  Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();

      return respond(url, init);
    },
    { preconnect: globalThis.fetch.preconnect },
  );

const imageResponse = (bytes: Uint8Array<ArrayBuffer>, contentType = "image/png"): Response =>
  new Response(bytes, { status: 200, headers: { "content-type": contentType } });

const redirectResponse = (location: string): Response =>
  new Response(null, { status: 302, headers: { location } });

const fetchFailure = async (
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs = 1000,
): Promise<PhotoImportFetchBlocked> =>
  Effect.runPromise(fetchImportBytes(url, fetchImpl, timeoutMs).pipe(Effect.flip));

describe("verifyPhotoRights license matrix", () => {
  test("cc0 passes with source provenance and advisory warnings", () => {
    const check = verifyPhotoRights(candidate({ license: "cc0", creator: null, licenseUrl: null }));

    expect(check.rights).not.toBeNull();
    expect(check.reasons).toEqual([]);
    expect(check.warnings.length).toBeGreaterThan(0);
  });

  test("cc-by passes complete and is not ShareAlike", () => {
    const check = verifyPhotoRights(candidate({}));

    expect(check.rights?.license).toBe("cc-by");
    expect(check.rights?.shareAlike).toBe(false);
    expect(check.reasons).toEqual([]);
  });

  test("cc-by is case-insensitive and trimmed", () => {
    const check = verifyPhotoRights(candidate({ license: "  CC-BY " }));

    expect(check.rights?.license).toBe("cc-by");
  });

  test("cc-by blocks missing creator, title, and license link", () => {
    const check = verifyPhotoRights(candidate({ creator: null, title: null, licenseUrl: null }));

    expect(check.rights).toBeNull();
    expect(check.reasons.some((reason) => reason.includes("creator"))).toBe(true);
    expect(check.reasons.some((reason) => reason.includes("title"))).toBe(true);
    expect(check.reasons.some((reason) => reason.includes("license_url"))).toBe(true);
  });

  test("cc-by-sa passes complete with the ShareAlike flag preserved", () => {
    const check = verifyPhotoRights(
      candidate({ license: "cc-by-sa", adapted: true, modificationNote: "cropped" }),
    );

    expect(check.rights?.license).toBe("cc-by-sa");
    expect(check.rights?.shareAlike).toBe(true);
    expect(check.reasons).toEqual([]);
  });

  test("cc-by-sa blocks adapted works without a modification notice", () => {
    const check = verifyPhotoRights(
      candidate({ license: "cc-by-sa", adapted: true, modificationNote: null }),
    );

    expect(check.rights).toBeNull();
    expect(check.reasons.some((reason) => reason.includes("modification_note"))).toBe(true);
  });

  test("licensed requires a documented permission reference", () => {
    const blocked = verifyPhotoRights(candidate({ license: "licensed", permissionRef: null }));

    expect(blocked.rights).toBeNull();
    expect(blocked.reasons.some((reason) => reason.includes("permission_ref"))).toBe(true);

    const allowed = verifyPhotoRights(
      candidate({ license: "licensed", permissionRef: "email-2026-10-31-photographer" }),
    );

    expect(allowed.rights?.license).toBe("licensed");
    expect(allowed.reasons).toEqual([]);
  });

  test("unspecified and unsupported licenses block", () => {
    for (const license of ["unknown", "", "all-rights-reserved", "fair-use"]) {
      const check = verifyPhotoRights(candidate({ license }));

      expect(check.rights).toBeNull();
      expect(check.reasons.length).toBeGreaterThan(0);
    }
  });

  test("own-work is rejected for remote import with a redirect to uploads", () => {
    const check = verifyPhotoRights(candidate({ license: "own-work" }));

    expect(check.rights).toBeNull();
    expect(check.reasons.some((reason) => reason.includes("upload"))).toBe(true);
  });

  test("source provenance must be an https URL", () => {
    const missing = verifyPhotoRights(candidate({ sourceUrl: null }));

    expect(missing.rights).toBeNull();

    const plain = verifyPhotoRights(candidate({ sourceUrl: "http://example.com/photo" }));

    expect(plain.rights).toBeNull();
    expect(plain.reasons.some((reason) => reason.includes("https"))).toBe(true);
  });

  test("over-long rights fields block instead of truncating", () => {
    const check = verifyPhotoRights(candidate({ creator: "x".repeat(501) }));

    expect(check.rights).toBeNull();
    expect(check.reasons.some((reason) => reason.includes("creator"))).toBe(true);
  });
});

describe("buildImportAttribution", () => {
  test("cc-by attribution preserves every rights field", () => {
    const check = verifyPhotoRights(candidate({}));

    if (check.rights === null) throw new Error("unreachable");

    const line = buildImportAttribution(check.rights);

    expect(line).toContain("Linh Nguyen");
    expect(line).toContain("Pho Bo");
    expect(line).toContain("CC BY");
    expect(line).toContain("https://creativecommons.org/licenses/by/4.0/");
    expect(line).toContain("source: https://example.com/photos/pho-bo");
    expect(line).not.toContain("ShareAlike");
  });

  test("cc-by-sa attribution carries the ShareAlike notice", () => {
    const check = verifyPhotoRights(
      candidate({ license: "cc-by-sa", adapted: true, modificationNote: "cropped" }),
    );

    if (check.rights === null) throw new Error("unreachable");

    const line = buildImportAttribution(check.rights);

    expect(line).toContain("CC BY-SA");
    expect(line).toContain("modifications: cropped");
    expect(line).toContain("ShareAlike");
  });

  test("unadapted works carry no modification segment", () => {
    const check = verifyPhotoRights(candidate({}));

    if (check.rights === null) throw new Error("unreachable");

    expect(buildImportAttribution(check.rights)).not.toContain("modifications:");
  });

  test("documented permission names its reference", () => {
    const check = verifyPhotoRights(
      candidate({ license: "licensed", permissionRef: "email-2026-10-31" }),
    );

    if (check.rights === null) throw new Error("unreachable");

    expect(buildImportAttribution(check.rights)).toContain("email-2026-10-31");
  });
});

describe("assertImportUrlAllowed SSRF gate", () => {
  test("rejects plaintext http", () => {
    const gated = assertImportUrlAllowed("http://example.com/photo.jpg");

    expect("reason" in gated && gated.reason).toContain("https");
  });

  test("rejects private and special IPv4 hosts", () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
    ]) {
      const gated = assertImportUrlAllowed(`https://${host}/photo.jpg`);

      expect("reason" in gated, host).toBe(true);
    }
  });

  test("rejects loopback IPv6 and internal DNS names", () => {
    for (const rawUrl of [
      "https://[::1]/photo.jpg",
      "https://localhost/photo.jpg",
      "https://tiles.local/photo.jpg",
      "https://meta.internal/photo.jpg",
      "https://intranet/photo.jpg",
    ]) {
      const gated = assertImportUrlAllowed(rawUrl);

      expect("reason" in gated, rawUrl).toBe(true);
    }
  });

  test("rejects credentials and non-default ports", () => {
    expect("reason" in assertImportUrlAllowed("https://user@example.com/photo.jpg")).toBe(true);
    expect("reason" in assertImportUrlAllowed("https://example.com:8443/photo.jpg")).toBe(true);
  });

  test("rejects unparseable input", () => {
    expect("reason" in assertImportUrlAllowed("not a url")).toBe(true);
  });

  test("accepts public https URLs including literal public IPs", () => {
    for (const rawUrl of ["https://example.com/photo.jpg", "https://8.8.8.8/photo.jpg"]) {
      const gated = assertImportUrlAllowed(rawUrl);

      expect("url" in gated, rawUrl).toBe(true);
    }
  });
});

describe("fetchImportBytes with mocked fetch", () => {
  test("returns bytes, content type, and source URL for an image", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const fetchImpl = stubFetch(async () => imageResponse(bytes));

    const fetched = await Effect.runPromise(
      fetchImportBytes("https://example.com/a.png", fetchImpl),
    );

    expect(fetched.bytes).toEqual(bytes);
    expect(fetched.contentType).toBe("image/png");
    expect(fetched.sourceUrl).toBe("https://example.com/a.png");
  });

  test("rejects wrong and missing content types", async () => {
    const html = stubFetch(async () => imageResponse(Uint8Array.from([1]), "text/html"));
    const htmlFailure = await fetchFailure("https://example.com/a", html);

    expect(htmlFailure._tag).toBe("PhotoImportFetchBlocked");
    expect(htmlFailure.reason).toContain("not an image");

    const missing = stubFetch(async () => new Response(Uint8Array.from([1]), { status: 200 }));
    const missingFailure = await fetchFailure("https://example.com/a", missing);

    expect(missingFailure._tag).toBe("PhotoImportFetchBlocked");
  });

  test("never follows a redirect to an internal host", async () => {
    let calls = 0;

    const fetchImpl = stubFetch(async (url) => {
      calls += 1;

      if (url === "https://good.example/i.jpg") {
        return redirectResponse("https://169.254.169.254/latest/meta-data");
      }

      throw new Error("must not fetch the internal hop");
    });

    const failure = await fetchFailure("https://good.example/i.jpg", fetchImpl);

    expect(failure._tag).toBe("PhotoImportFetchBlocked");
    expect(calls).toBe(1);
  });

  test("follows public redirects and records the final URL as provenance", async () => {
    const fetchImpl = stubFetch(async (url) => {
      if (url === "https://example.com/start") {
        return redirectResponse("https://cdn.example/final.jpg");
      }

      return imageResponse(Uint8Array.from([9]), "image/jpeg");
    });

    const fetched = await Effect.runPromise(
      fetchImportBytes("https://example.com/start", fetchImpl),
    );

    expect(fetched.sourceUrl).toBe("https://cdn.example/final.jpg");
    expect(fetched.contentType).toBe("image/jpeg");
  });

  test("caps the redirect chain", async () => {
    let calls = 0;

    const fetchImpl = stubFetch(async (url) => {
      calls += 1;

      return redirectResponse(`${url}/next`);
    });

    const failure = await fetchFailure("https://example.com/start", fetchImpl);

    expect(failure._tag).toBe("PhotoImportFetchBlocked");
    expect(failure.reason).toContain("redirect");
    expect(calls).toBe(4);
  });

  test("rejects error statuses without leaking the body", async () => {
    const fetchImpl = stubFetch(async () => new Response("nope", { status: 404 }));

    const failure = await fetchFailure("https://example.com/missing.jpg", fetchImpl);

    expect(failure.reason).toContain("404");
  });

  test("rejects declared oversized payloads before reading the body", async () => {
    const fetchImpl = stubFetch(
      async () =>
        new Response(Uint8Array.from([1]), {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(MAX_IMPORT_BYTES + 1),
          },
        }),
    );

    const failure = await fetchFailure("https://example.com/big.png", fetchImpl);

    expect(failure.reason).toContain("byte ceiling");
  });

  test("rejects oversized bodies with a lying content length", async () => {
    const fetchImpl = stubFetch(async () => imageResponse(new Uint8Array(MAX_IMPORT_BYTES + 1)));

    const failure = await fetchFailure("https://example.com/big.png", fetchImpl);

    expect(failure.reason).toContain("byte ceiling");
  });

  test("rejects empty bodies", async () => {
    const fetchImpl = stubFetch(async () => imageResponse(Uint8Array.from([])));

    const failure = await fetchFailure("https://example.com/empty.png", fetchImpl);

    expect(failure.reason).toContain("no bytes");
  });

  test("times out a hanging source", async () => {
    const hanging: typeof fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
      { preconnect: globalThis.fetch.preconnect },
    );

    const failure = await fetchFailure("https://example.com/slow.jpg", hanging, 50);

    expect(failure.reason).toContain("timed out");
  });
});

describe("resolvePhotoScope", () => {
  test("venue-scoped by default and for bare dish ids", () => {
    expect(resolvePhotoScope({ venueId: "v1", dishId: null, dishEvidenceMediaId: null })).toEqual({
      scope: "venue",
      venueId: "v1",
    });
    expect(
      resolvePhotoScope({ venueId: "v1", dishId: "d1", dishEvidenceMediaId: null }).scope,
    ).toBe("venue");
    expect(
      resolvePhotoScope({ venueId: "v1", dishId: "d1", dishEvidenceMediaId: "  " }).scope,
    ).toBe("venue");
  });

  test("dish-scoped only with evidence-backed dish identity", () => {
    expect(
      resolvePhotoScope({ venueId: "v1", dishId: "d1", dishEvidenceMediaId: "media-9" }),
    ).toEqual({ scope: "dish", venueId: "v1", dishId: "d1", dishEvidenceMediaId: "media-9" });
  });
});

describe("toStagingInput", () => {
  test("maps a prepared import onto the existing staging input", () => {
    const check = verifyPhotoRights(candidate({ license: "cc0" }));

    if (check.rights === null) throw new Error("unreachable");

    const staging = toStagingInput({
      venueId: "venue-1",
      bytes: Uint8Array.from([1]),
      filename: "import.png",
      contentType: "image/png",
      altText: null,
      attribution: buildImportAttribution(check.rights),
      license: "cc0",
      sourceUrl: check.rights.sourceUrl,
      scope: { scope: "venue", venueId: "venue-1" },
      shareAlike: false,
    });

    expect(staging.makePrimary).toBe(false);
    expect(staging.focalX).toBeNull();
    expect(staging.focalY).toBeNull();
    expect(staging.license).toBe("cc0");
  });
});
