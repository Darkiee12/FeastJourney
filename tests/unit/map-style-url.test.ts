import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MAP_STYLE_URL,
  resolveMapStyleUrl,
  validateMapStyleUrl,
} from "@/shared/map-style-url";

const readSource = async (path: string): Promise<string> => Bun.file(path).text();

describe("map style URL default", () => {
  test("default is the validated public CARTO Positron style", () => {
    expect(DEFAULT_MAP_STYLE_URL).toBe(
      "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    );
    expect(validateMapStyleUrl(DEFAULT_MAP_STYLE_URL)).toEqual({
      success: true,
      url: DEFAULT_MAP_STYLE_URL,
    });
  });
});

describe("validateMapStyleUrl", () => {
  test("accepts a valid https override", () => {
    const override = "https://api.maptiler.com/maps/streets-v2/style.json?key=public-key";

    expect(validateMapStyleUrl(override)).toEqual({ success: true, url: override });
  });

  test("rejects missing and empty values with a named fix", () => {
    for (const value of [undefined, "", "   "]) {
      const result = validateMapStyleUrl(value);

      expect(result.success).toBe(false);

      if (result.success) {
        expect.unreachable("expected validation to fail");
      }

      expect(result.reason).toContain("VITE_MAP_STYLE_URL");
    }
  });

  test("rejects malformed values with a named fix", () => {
    for (const value of ["not-a-url", "basemaps.cartocdn.com/style.json", "https://"]) {
      const result = validateMapStyleUrl(value);

      expect(result.success).toBe(false);

      if (result.success) {
        expect.unreachable("expected validation to fail");
      }

      expect(result.reason).toContain("VITE_MAP_STYLE_URL");
    }
  });

  test("rejects non-HTTPS values without ever echoing the value", () => {
    const secretLooking = "http://tiles.example.test/style.json?key=SECRET-ABC-123";

    for (const value of [secretLooking, "ftp://tiles.example.test/style.json"]) {
      const result = validateMapStyleUrl(value);

      expect(result.success).toBe(false);

      if (result.success) {
        expect.unreachable("expected validation to fail");
      }

      expect(result.reason).toContain("VITE_MAP_STYLE_URL");
      expect(result.reason).toContain("https");
      expect(result.reason).not.toContain("SECRET-ABC-123");
      expect(result.reason).not.toContain(value);
    }
  });
});

describe("resolveMapStyleUrl", () => {
  test("falls back to the validated default when unset or blank", () => {
    expect(resolveMapStyleUrl(undefined)).toBe(DEFAULT_MAP_STYLE_URL);
    expect(resolveMapStyleUrl("")).toBe(DEFAULT_MAP_STYLE_URL);
    expect(resolveMapStyleUrl("   ")).toBe(DEFAULT_MAP_STYLE_URL);
  });

  test("accepts a valid override verbatim, trimmed", () => {
    const override = "https://api.maptiler.com/maps/streets-v2/style.json?key=public-key";

    expect(resolveMapStyleUrl(override)).toBe(override);
    expect(resolveMapStyleUrl(`  ${override}  `)).toBe(override);
  });

  test("throws an actionable error for malformed or non-HTTPS overrides", () => {
    for (const value of ["not-a-url", "http://tiles.example.test/style.json"]) {
      let message = "";

      try {
        resolveMapStyleUrl(value);
      } catch (error) {
        message = error instanceof Error ? error.message : "non-Error thrown";
      }

      expect(message).toContain("VITE_MAP_STYLE_URL");
      expect(message).not.toContain(value);
    }
  });
});

describe("map style build wiring (static guards)", () => {
  test("both CI gates resolve the style URL from the Actions variable before building", async () => {
    const sources = await Promise.all(
      [".github/workflows/release.yml", ".github/workflows/quality.yml"].map((workflow) =>
        readSource(workflow),
      ),
    );

    for (const source of sources) {
      expect(source).toContain("resolve-map-style-url");
      expect(source).toContain("vars.VITE_MAP_STYLE_URL");
      expect(source).toContain("VITE_MAP_STYLE_URL=${resolved}");
      expect(source).toContain("Prove the map style URL is embedded in the bundle");
    }
  });

  test("the resolver CLI delegates to the single shared validator", async () => {
    const cli = await readSource(".github/workflows/scripts/resolve-map-style-url.ts");

    expect(cli).toContain("shared/map-style-url");
    expect(cli).toContain("resolveMapStyleUrl");
  });

  test("the Swarm stack carries the style URL as informational-only runtime config", async () => {
    const stack = await readSource("docker-compose.swarm.yml");

    expect(stack).toContain(
      "VITE_MAP_STYLE_URL: ${VITE_MAP_STYLE_URL:-https://basemaps.cartocdn.com/gl/positron-gl-style/style.json}",
    );
    expect(stack).toContain("informational only");
  });
});
