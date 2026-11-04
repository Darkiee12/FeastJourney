// Resolve the build-time MapLibre style URL for Vite.
//
// Usage:
//   VITE_MAP_STYLE_URL="${{ vars.VITE_MAP_STYLE_URL }}" bun .github/workflows/scripts/resolve-map-style-url.ts
//   bun .github/workflows/scripts/resolve-map-style-url.ts https://example.test/style.json
//
// Prints the resolved URL to stdout for capture into $GITHUB_ENV. Exit 0
// with the validated default when the variable is unset or blank; exit 1
// with an actionable error (variable name + fix, never the value) when an
// explicit override is malformed or non-HTTPS. Reads argv[2] first so the
// value can be probed locally, then the VITE_MAP_STYLE_URL environment.
//
// Checks (key names only — never prints values):
// - repository variable VITE_MAP_STYLE_URL when set is a valid https URL
// - otherwise the validated CARTO Positron default is used
//
// This is deployment-configuration validation, not an application test:
// it exits non-zero on the first violation so the build step never runs
// map-less. The single default constant lives with the validator:
//   src/shared/map-style-url.ts
// Run with bun (the validator is TypeScript); CI already sets up bun.
import { resolveMapStyleUrl } from "../../../src/shared/map-style-url.ts";

const raw = process.argv[2] ?? process.env.VITE_MAP_STYLE_URL;

try {
  process.stdout.write(`${resolveMapStyleUrl(raw)}\n`);
} catch (error) {
  const reason = error instanceof Error ? error.message : "unknown validation failure";

  process.stderr.write(`map style URL validation failed: ${reason}\n`);
  process.exitCode = 1;
}
