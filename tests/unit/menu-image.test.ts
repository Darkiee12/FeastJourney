import { describe, expect, test } from "bun:test";

import { Effect } from "effect";
import sharp from "sharp";

import { MAX_IMAGE_BYTES, validateMenuImage } from "@/server/integrations/private-menu-storage";

describe("private menu photograph validation", () => {
  test("decodes a synthetic image and removes metadata before storage", async () => {
    const original = await sharp({
      create: { width: 48, height: 64, channels: 3, background: "#304080" },
    })
      .withMetadata({ exif: { IFD0: { Artist: "Synthetic fixture" } } })
      .png()
      .toBuffer();

    const verified = await Effect.runPromise(
      validateMenuImage(original, "image/png", MAX_IMAGE_BYTES),
    );
    const metadata = await sharp(verified.bytes).metadata();
    expect(verified).toMatchObject({ mediaType: "image/jpeg", width: 48, height: 64 });
    expect(verified.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(verified.byteLength).toBe(verified.bytes.length);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.format).toBe("jpeg");
  });

  test("rejects forged MIME even when the bytes decode", async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#fff" } })
      .png()
      .toBuffer();

    const failure = await Effect.runPromise(
      Effect.flip(validateMenuImage(png, "image/jpeg", MAX_IMAGE_BYTES)),
    );
    expect(failure._tag).toBe("InvalidImage");
  });

  test("rejects executable formats and empty files", async () => {
    const inputs = [
      new Uint8Array(),
      new TextEncoder().encode("<svg><script>bad()</script></svg>"),
    ];
    const failures = await Promise.all(
      inputs.map((bytes) =>
        Effect.runPromise(
          Effect.flip(validateMenuImage(bytes, "image/png", MAX_IMAGE_BYTES)),
        ),
      ),
    );

    for (const failure of failures) {
      expect(failure._tag).toBe("InvalidImage");
    }
  });

  test("rejects byte sizes above the passed bound before attempting to decode", async () => {
    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1);
    const failure = await Effect.runPromise(
      Effect.flip(validateMenuImage(oversized, "image/jpeg", MAX_IMAGE_BYTES)),
    );

    expect(failure._tag).toBe("InvalidImage");
  });

  test("rejects decoded dimensions beyond the configured bound", async () => {
    const png = await sharp({
      create: { width: 12001, height: 1, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();

    const failure = await Effect.runPromise(
      Effect.flip(validateMenuImage(png, "image/png", MAX_IMAGE_BYTES)),
    );
    expect(failure._tag).toBe("InvalidImage");
  });
});
