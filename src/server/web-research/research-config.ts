import { DEFAULT_MODEL_BASE_URL } from "@/server/env";
import { RESEARCH_MODEL_ID } from "@/server/integrations/meta-responses";

/**
 * Standalone web-research configuration. Reads only its own WEB_RESEARCH_*
 * variables plus the shared MODEL_API_KEY/MODEL_BASE_URL transport settings,
 * so research can be disabled independently of ranking or menu scanning.
 * Never imported from server/env.ts parsing: the caller passes the raw
 * environment bag, which keeps this pure and unit-testable.
 */

export const WEB_RESEARCH_ENABLED_VALUE = "true";

export const RESEARCH_DEFAULT_TIMEOUT_MS = 20000;

export const RESEARCH_DEFAULT_MAX_SOURCES = 6;

export const RESEARCH_DEFAULT_MAX_RESULTS = 5;

export const RESEARCH_DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const RESEARCH_DEFAULT_NEGATIVE_CACHE_TTL_MS = 30 * 60 * 1000;

export interface ResearchConfig {
  readonly enabled: boolean;
  /** Empty when MODEL_API_KEY is unset; the client fails loudly at call time. */
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly maxSources: number;
  readonly maxResults: number;
  readonly cacheTtlMs: number;
  readonly negativeCacheTtlMs: number;
}

/**
 * Operator-owned positive integers flow through exactly as configured; the
 * default applies only when the variable is unset. There is intentionally
 * no upper bound — upstream provider limits are the provider's
 * responsibility and surface as provider failures, never as silent
 * rewrites. An explicitly set value that is not a positive safe integer
 * fails loudly naming field + reason.
 */
const parseOperatorPositiveInt = (
  raw: string | undefined,
  field: string,
  fallback: number,
): number => {
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `${field} must be a positive safe integer or unset (unset uses ${fallback}).`,
    );
  }

  return parsed;
};

const parseTtlMs = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.floor(parsed);
};

/**
 * Pure resolver over the raw environment bag (`process.env` in production).
 * Takes `Record<string, string | undefined>` deliberately: the env bag is an
 * untrusted external boundary, not an application map. Disabled unless
 * WEB_RESEARCH_ENABLED is exactly "true".
 */
export const resolveResearchConfig = (env: Record<string, string | undefined>): ResearchConfig => ({
  enabled: env["WEB_RESEARCH_ENABLED"] === WEB_RESEARCH_ENABLED_VALUE,
  apiKey: env["MODEL_API_KEY"] ?? "",
  baseUrl: env["MODEL_BASE_URL"] ?? DEFAULT_MODEL_BASE_URL,
  modelId: RESEARCH_MODEL_ID,
  timeoutMs: parseOperatorPositiveInt(
    env["WEB_RESEARCH_TIMEOUT_MS"],
    "WEB_RESEARCH_TIMEOUT_MS",
    RESEARCH_DEFAULT_TIMEOUT_MS,
  ),
  maxSources: parseOperatorPositiveInt(
    env["WEB_RESEARCH_MAX_SOURCES"],
    "WEB_RESEARCH_MAX_SOURCES",
    RESEARCH_DEFAULT_MAX_SOURCES,
  ),
  maxResults: parseOperatorPositiveInt(
    env["WEB_RESEARCH_MAX_RESULTS"],
    "WEB_RESEARCH_MAX_RESULTS",
    RESEARCH_DEFAULT_MAX_RESULTS,
  ),
  cacheTtlMs: parseTtlMs(env["WEB_RESEARCH_CACHE_TTL_MS"], RESEARCH_DEFAULT_CACHE_TTL_MS),
  negativeCacheTtlMs: parseTtlMs(
    env["WEB_RESEARCH_NEGATIVE_CACHE_TTL_MS"],
    RESEARCH_DEFAULT_NEGATIVE_CACHE_TTL_MS,
  ),
});
