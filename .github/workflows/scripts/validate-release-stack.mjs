// Validate a rendered release stack before it reaches Dokploy.
//
// Usage:
//   node .github/workflows/scripts/validate-release-stack.mjs \
//     --in /tmp/docker-compose.release.yml
//
// Checks (key names only — never prints values):
// - the app service forwards every expected Muse scanner / web-research /
//   review-intelligence / copilot-vision setting with its documented default
// - all four opt-in feature flags default to disabled
// - shared MODEL_* wiring is preserved
// - reference FX settings (Frankfurter v2) are forwarded with their
//   Effect-Config defaults
// - all three images carry an immutable tag (no GHCR_IMAGE_PREFIX/VERSION
//   placeholder survives, no :latest)
// - runtime ${VAR} expressions remain for Dokploy substitution
// - the document keeps its services/app/environment structure
//
// This is deployment-configuration validation, not an application test:
// it reads the rendered file and exits non-zero on the first violation.
import { readFileSync } from "node:fs";

const args = new Map();
const raw = process.argv.slice(2);

for (let index = 0; index < raw.length; index += 2) {
  const flag = raw[index];
  const value = raw[index + 1];

  if (flag === undefined || value === undefined || !flag.startsWith("--")) {
    throw new Error("usage: --in <rendered-stack-file>");
  }

  args.set(flag.slice(2), value);
}

const input = args.get("in") ?? "";

if (input === "") {
  throw new Error("refusing to validate: --in is required");
}

// Authoritative variable names/defaults live with the resolvers:
//   src/server/integrations/menu-scan-config.ts
//   src/server/web-research/research-config.ts
//   src/server/review-intelligence/review-schemas.ts
//   src/server/muse-copilot/copilot-vision.ts
//   src/modules/restaurant-discovery/server/operations/fx.ts
// Keep this list in sync with those files and docker-compose.swarm.yml.
const expectedEnvironment = [
  "MENU_SCANNER_ENABLED: ${MENU_SCANNER_ENABLED:-false}",
  "MENU_SCAN_MODEL: ${MENU_SCAN_MODEL:-muse-spark-1.3}",
  "MENU_SCAN_TIMEOUT_MS: ${MENU_SCAN_TIMEOUT_MS:-20000}",
  "MENU_SCAN_RETRIES: ${MENU_SCAN_RETRIES:-1}",
  "MENU_SCAN_MAX_RESPONSE_BYTES: ${MENU_SCAN_MAX_RESPONSE_BYTES:-1048576}",
  "MENU_SCAN_MAX_IMAGES: ${MENU_SCAN_MAX_IMAGES:-6}",
  "MENU_SCAN_MAX_IMAGE_BYTES: ${MENU_SCAN_MAX_IMAGE_BYTES:-8388608}",
  "MENU_SCAN_MAX_COMPLETION_TOKENS: ${MENU_SCAN_MAX_COMPLETION_TOKENS:-12000}",
  "WEB_RESEARCH_ENABLED: ${WEB_RESEARCH_ENABLED:-false}",
  "WEB_RESEARCH_TIMEOUT_MS: ${WEB_RESEARCH_TIMEOUT_MS:-20000}",
  "WEB_RESEARCH_MAX_SOURCES: ${WEB_RESEARCH_MAX_SOURCES:-6}",
  "WEB_RESEARCH_MAX_RESULTS: ${WEB_RESEARCH_MAX_RESULTS:-5}",
  "WEB_RESEARCH_CACHE_TTL_MS: ${WEB_RESEARCH_CACHE_TTL_MS:-21600000}",
  "WEB_RESEARCH_NEGATIVE_CACHE_TTL_MS: ${WEB_RESEARCH_NEGATIVE_CACHE_TTL_MS:-1800000}",
  "REVIEW_INTELLIGENCE_ENABLED: ${REVIEW_INTELLIGENCE_ENABLED:-false}",
  "REVIEW_INTELLIGENCE_TIMEOUT_MS: ${REVIEW_INTELLIGENCE_TIMEOUT_MS:-20000}",
  "COPILOT_VISION_ENABLED: ${COPILOT_VISION_ENABLED:-false}",
  "COPILOT_VISION_TIMEOUT_MS: ${COPILOT_VISION_TIMEOUT_MS:-20000}",
  "FX_ENDPOINT: ${FX_ENDPOINT:-https://api.frankfurter.dev/v2/}",
  "FX_REFRESH_HOURS: ${FX_REFRESH_HOURS:-24}",
  "FX_MAX_AGE_HOURS: ${FX_MAX_AGE_HOURS:-72}",
  "MODEL_API_KEY: ${MODEL_API_KEY:-}",
  "MODEL_MODEL_ID: ${MODEL_MODEL_ID:-muse-spark-1.3}",
  "MODEL_BASE_URL: ${MODEL_BASE_URL:-https://api.meta.ai/v1}",
];

const fail = (message) => {
  throw new Error(`invalid release stack: ${message}`);
};

const rendered = readFileSync(input, "utf8");
const lines = rendered.split("\n");

for (const expected of expectedEnvironment) {
  if (!lines.some((line) => line.trim() === expected)) {
    fail(`app environment is missing "${expected.split(":")[0]}"`);
  }
}

// All four opt-in flags must default to disabled — never enabled by default.
for (const flag of [
  "MENU_SCANNER_ENABLED",
  "WEB_RESEARCH_ENABLED",
  "REVIEW_INTELLIGENCE_ENABLED",
  "COPILOT_VISION_ENABLED",
]) {
  if (!lines.some((line) => line.trim() === `${flag}: ${"${" + flag + ":-false}"}`)) {
    fail(`${flag} does not default to disabled`);
  }
}

// Structure: services -> app -> environment must exist in that order.
// (Earlier services have their own environment blocks, so the app's block
// is the first one after the app service line.)
const servicesIndex = lines.findIndex((line) => line === "services:");
const appIndex = lines.findIndex((line) => line === "  app:");

const environmentIndex = lines.findIndex(
  (line, index) => index > appIndex && line === "    environment:",
);

if (servicesIndex === -1 || appIndex <= servicesIndex || environmentIndex <= appIndex) {
  fail("services/app/environment structure is missing");
}

// Immutable image tags on all three built images; no CI placeholder or
// mutable tag survives rendering.
const imageLines = lines.filter((line) => line.trim().startsWith("image:"));

if (imageLines.length < 3) {
  fail(`expected at least 3 image lines, found ${imageLines.length}`);
}

const tagPattern = /:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

for (const line of imageLines) {
  if (line.includes("${GHCR_IMAGE_PREFIX}") || line.includes("${VERSION}")) {
    fail("unsubstituted CI image token remains");
  }

  const match = line.trim().match(tagPattern);

  if (match === null || match[1] === "latest") {
    fail("image without an immutable tag");
  }
}

// Runtime configuration must stay parameterized for Dokploy: the rendered
// stack keeps ${VAR} expressions (only the two CI-owned tokens are pinned).
const runtimeExpressions = rendered.match(/\$\{[A-Z_]+(?::[-?][^}]*)?\}/g) ?? [];

if (runtimeExpressions.length < expectedEnvironment.length) {
  fail("runtime ${VAR} expressions were resolved instead of preserved for Dokploy");
}

console.log(
  `release stack valid: ${expectedEnvironment.length} environment entries, ` +
    `${imageLines.length} pinned images, ${runtimeExpressions.length} runtime expressions preserved`,
);
