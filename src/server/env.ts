import { Data } from "effect";
import { z } from "zod";

/**
 * Server-only environment validation. Imported exclusively from server code
 * (Better Auth setup, email transport, TanStack server handlers); never from
 * browser components or client-safe schemas. All authentication providers and
 * email delivery are mandatory: startup fails loudly instead of silently
 * disabling Google, Facebook, or email.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_URL: z.string().url("BETTER_AUTH_URL must be a valid URL"),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),
  FACEBOOK_CLIENT_ID: z.string().min(1, "FACEBOOK_CLIENT_ID is required"),
  FACEBOOK_CLIENT_SECRET: z.string().min(1, "FACEBOOK_CLIENT_SECRET is required"),
  SMTP_HOST: z.string().min(1, "SMTP_HOST is required"),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  SMTP_USERNAME: z.string().min(1, "SMTP_USERNAME is required"),
  SMTP_PASSWORD: z.string().min(1, "SMTP_PASSWORD is required"),
  EMAIL_FROM: z.string().min(1, "EMAIL_FROM is required"),
  TRUSTED_PROXIES: z.string().default(""),
  // Optional owner bootstrap: when set, the account holding this address
  // receives the owner role right after signup (all creation paths). Leave
  // unset and the first signup stays a plain member; ownership is then
  // granted out of band with SQL.
  OWNER_EMAIL: z.string().email("OWNER_EMAIL must be a valid email address").optional(),
  // Optional Muse ranking integration. Every MODEL_* field stays optional
  // in both input and output so startup never depends on AI configuration
  // and existing ServerEnv literals keep compiling; resolveRankingConfig()
  // below applies the documented defaults at the use site. Note
  // RECOMMENDATION_PROVIDER is deliberately `.optional()` rather than
  // `.default("deterministic")`: a Zod default would make the field required
  // in the inferred ServerEnv output type and break existing literal
  // constructions; undefined means deterministic at the use site.
  RECOMMENDATION_PROVIDER: z.enum(["deterministic", "muse"]).optional(),
  MODEL_API_KEY: z.string().optional(),
  MODEL_MODEL_ID: z.string().optional(),
  MODEL_BASE_URL: z.string().optional(),
  MODEL_TIMEOUT_MS: z.coerce.number().int().optional(),
  MODEL_CANDIDATE_LIMIT: z.coerce.number().int().max(100).optional(),
  MODEL_OUTPUT_LIMIT: z.coerce.number().int().optional(),
  MODEL_MAX_TOKENS: z.coerce.number().int().optional(),
  // Scanner configuration is validated lazily when enabled; unrelated reads
  // never depend on Muse or private image storage configuration.
  MENU_SCANNER_ENABLED: z.string().optional(),
  MENU_SCAN_MODEL: z.string().optional(),
  MENU_SCAN_TIMEOUT_MS: z.string().optional(),
  MENU_SCAN_RETRIES: z.string().optional(),
  MENU_SCAN_MAX_RESPONSE_BYTES: z.string().optional(),
  MENU_SCAN_MAX_IMAGES: z.string().optional(),
  MENU_SCAN_MAX_IMAGE_BYTES: z.string().optional(),
  MENU_SCAN_MAX_COMPLETION_TOKENS: z.string().optional(),
});

export type ServerEnv = z.infer<typeof envSchema>;

let cached: ServerEnv | undefined;

export const serverEnv = (): ServerEnv => {
  cached ??= envSchema.parse(process.env);

  return cached;
};

/** Test-only escape hatch: reset the cached parse between cases. */
export const resetServerEnvCache = (): void => {
  cached = undefined;
};

/**
 * Accepted model identity shape: any Muse Spark `<major>.<minor>` release
 * (Standard or Contributor tier) or any Muse Wonder `<major>.<minor>`
 * release (Standard tier only — Contributor mode is not offered for Wonder).
 * An exact-ID list would force a code change for every new release; the
 * shape check keeps typo protection (`muse-sparc-…`, empty strings) while
 * letting new releases through without a redeploy. Self-hosted
 * (`muse-glimmer-*`) stays out: it is not served on this endpoint. Existence
 * of a well-formed version is the provider's job to confirm (unknown
 * versions fail loudly at request time, never silently).
 *
 * This is a misconfiguration guardrail, not an attacker boundary: the model
 * ID comes only from operator-owned server configuration, never from user
 * input — no client request can smuggle a model choice in. (A template type
 * like `muse-${string}` could not enforce this on its own: environment
 * values arrive as plain strings, so the runtime predicate below is the
 * real mechanism.)
 */
const SUPPORTED_MODEL_PATTERN = /^muse-(?:spark-\d+\.\d+(?:-contributor)?|wonder-\d+\.\d+)$/;

export const isSupportedModelId = (modelId: string): boolean =>
  SUPPORTED_MODEL_PATTERN.test(modelId);

/**
 * Explicitly discriminated ranking backend selection. Pure: takes the parsed
 * environment so unit tests can construct ServerEnv literals without touching
 * process.env. Reads no network and performs no I/O.
 *
 * - Deterministic: local relevance order, no provider call.
 * - Muse: provider call with a validated key, supported model shape, https base.
 * - Misconfigured: muse was requested but key/model/baseUrl is unusable.
 *   Callers must fail loudly (HTTP 500), never silently degrade.
 */
export type RankingConfig = Data.TaggedEnum<{
  Deterministic: {
    readonly candidateLimit: number;
    readonly outputLimit: number;
  };
  Muse: {
    readonly apiKey: string;
    readonly modelId: string;
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly candidateLimit: number;
    readonly outputLimit: number;
    readonly maxTokens: number;
  };
  Misconfigured: { readonly reason: string };
}>;

export const RankingConfig = Data.taggedEnum<RankingConfig>();

export const DEFAULT_MODEL_ID = "muse-spark-1.3";

export const DEFAULT_MODEL_BASE_URL = "https://api.meta.ai/v1";

export const DEFAULT_MODEL_TIMEOUT_MS = 15000;

/**
 * Default ceiling on a single ranking call's tokens (reasoning + output).
 * The reasoning model burns ~1k tokens ranking 3 dishes; uncapped, a
 * 30-candidate prompt routinely blows the 15s budget (timeout) or
 * truncates the strict JSON (invalid output). The candidate trim below is
 * the primary guard; this cap bounds cost per call.
 */
export const DEFAULT_MODEL_MAX_TOKENS = 4000;

/**
 * Bounded per-call token ceiling: 1000 floor keeps reasoning models usable,
 * 16000 ceiling keeps a single call from eating the request budget. Ranks
 * only (reasoning + the short id list), never the candidate catalog itself.
 */
const clampMaxTokens = (value: number | undefined): number => {
  if (value === undefined || Number.isNaN(value)) {
    return DEFAULT_MODEL_MAX_TOKENS;
  }

  return Math.min(Math.max(Math.floor(value), 1000), 16000);
};

const clampCandidateLimit = (value: number | undefined): number => {
  if (value === undefined || Number.isNaN(value)) {
    return 60;
  }

  return Math.min(Math.max(Math.floor(value), 1), 100);
};

const clampOutputLimit = (value: number | undefined): number => {
  if (value === undefined || Number.isNaN(value)) {
    return 10;
  }

  return Math.min(Math.max(Math.floor(value), 1), 10);
};

/**
 * Bounded provider timeout: 1s floor avoids instant-abort loops, 60s
 * ceiling avoids hung recommendation requests holding the 30s server-fn
 * budget hostage. Out-of-range values clamp instead of failing startup
 * (offline shape validation only; the provider is never contacted here).
 */
const clampTimeoutMs = (value: number | undefined): number => {
  if (value === undefined || Number.isNaN(value)) {
    return DEFAULT_MODEL_TIMEOUT_MS;
  }

  return Math.min(Math.max(Math.floor(value), 1000), 60000);
};

const isHttpsUrl = (value: string): boolean => {
  // Operator-controlled endpoint: any https URL passes shape validation so
  // self-hosted Meta-compatible gateways work; the API key is only ever sent
  // to this operator-chosen host. There is no host allowlist by design —
  // the trust boundary is the operator's own configuration, never client input.
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  return parsed.protocol === "https:";
};

export const resolveRankingConfig = (env: ServerEnv): RankingConfig => {
  const candidateLimit = clampCandidateLimit(env.MODEL_CANDIDATE_LIMIT);
  const outputLimit = clampOutputLimit(env.MODEL_OUTPUT_LIMIT);

  if (env.RECOMMENDATION_PROVIDER !== "muse") {
    return RankingConfig.Deterministic({ candidateLimit, outputLimit });
  }

  const apiKey = env.MODEL_API_KEY;

  if (apiKey === undefined || apiKey.length === 0) {
    return RankingConfig.Misconfigured({ reason: "MODEL_API_KEY is not configured" });
  }

  const modelId = env.MODEL_MODEL_ID ?? DEFAULT_MODEL_ID;

  if (!isSupportedModelId(modelId)) {
    return RankingConfig.Misconfigured({
      reason: `Unsupported model "${modelId}" (expected muse-spark-<major>.<minor>[-contributor] or muse-wonder-<major>.<minor>)`,
    });
  }

  const baseUrl = env.MODEL_BASE_URL ?? DEFAULT_MODEL_BASE_URL;

  if (!isHttpsUrl(baseUrl)) {
    return RankingConfig.Misconfigured({ reason: "MODEL_BASE_URL must be an https URL" });
  }

  return RankingConfig.Muse({
    apiKey,
    modelId,
    baseUrl,
    timeoutMs: clampTimeoutMs(env.MODEL_TIMEOUT_MS),
    candidateLimit,
    outputLimit,
    maxTokens: clampMaxTokens(env.MODEL_MAX_TOKENS),
  });
};
