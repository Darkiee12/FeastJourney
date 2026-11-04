import { z } from "zod";

import { DEFAULT_MODEL_BASE_URL, DEFAULT_MODEL_ID, isSupportedModelId } from "@/server/env";

/**
 * Review-intelligence contracts (Muse Spark 1.3, structured output only).
 *
 * Scope and safety rules shared by the client, service, cache, and
 * transport in this directory:
 *
 * - Inputs are published customer reviews only (never pending, rejected,
 *   removed, other venues, PII, or moderation notes). The request carries
 *   only published text plus rating and recency; author identity is stripped
 *   before the provider call and never leaves the server.
 * - No web search: the client uses plain chat completions with a strict
 *   JSON response format. Model output is untrusted until decoded here and
 *   validated against the supplied review set (evidence review IDs must be
 *   members of the sampled set; snippets must occur verbatim in the cited
 *   body, modulo whitespace).
 * - Generated text (overview, positives, cautions) must carry no HTML or
 *   markup and no invented safety, allergy, price, or availability claims.
 *   Snippets are verbatim user text, so markup/safety screening applies to
 *   model-generated fields only.
 * - Summaries are never persisted as customer reviews, never auto-published
 *   into canonical records, and the model never approves, rejects, or
 *   removes anything.
 * - Sections are never forced: positives and cautions may both be empty
 *   when the evidence is thin, and fewer than five meaningful reviews
 *   yields Insufficient instead of a padded summary.
 * - Cache keys are content-aware (review IDs plus timestamps plus bodies
 *   plus totals); a bare count is never a key, so moderation, edits, and
 *   removals always invalidate.
 */

export const REVIEW_INTELLIGENCE_PROVIDER = "muse";

export const REVIEW_INTELLIGENCE_PROMPT_VERSION = "review-highlights-v1";

export const REVIEW_INTELLIGENCE_ENABLED_VALUE = "true";

export const REVIEW_INTELLIGENCE_DEFAULT_TIMEOUT_MS = 20000;

/**
 * Default response-body budget (bytes). The documented unset default, not a
 * ceiling — REVIEW_INTELLIGENCE_MAX_RESPONSE_BYTES overrides it exactly when
 * explicitly set. Cache TTLs/entries and per-review char bounds stay
 * hardcoded: they are output-contract or deployment constants, not
 * load-bearing operational budgets.
 */
export const REVIEW_INTELLIGENCE_MAX_RESPONSE_BYTES = 24 * 1024;

/** Minimum meaningful published reviews required before summarizing. */
export const REVIEW_INTELLIGENCE_MIN_MEANINGFUL = 5;

/** Minimum trimmed body characters for a review to count as meaningful. */
export const REVIEW_INTELLIGENCE_MIN_MEANINGFUL_CHARS = 20;

/**
 * Default sampling budget: upper bound on reviews sent to the provider in
 * one call. This constant is the documented unset default, not a ceiling —
 * REVIEW_INTELLIGENCE_MAX_SAMPLE overrides it exactly when explicitly set.
 * Output-contract bounds (overview/bullet/snippet lengths and counts below)
 * stay hardcoded; only this operational budget is operator-owned.
 */
export const REVIEW_INTELLIGENCE_MAX_SAMPLE = 12;

/**
 * Default completion-token budget for one review-intelligence call. The
 * previous hardcoded 2000-token output truncated 12-review prompts
 * (12 x 1000 input chars), surfacing as indistinguishable decode failures.
 * 12000 matches the menu-scanner completion budget for the same endpoint
 * family; the provider's own limit is still the final authority and
 * surfaces as a provider failure, never a silent rewrite.
 */
export const REVIEW_INTELLIGENCE_DEFAULT_MAX_COMPLETION_TOKENS = 12000;

/** Per-review prompt bound: flattened text is truncated to this length. */
export const REVIEW_INTELLIGENCE_MAX_REVIEW_CHARS = 1000;

/** Recent/highest/lowest page sizes bounding the sampling pool. */
export const REVIEW_INTELLIGENCE_RECENT_POOL = 50;

export const REVIEW_INTELLIGENCE_EXTREME_POOL = 25;

export const REVIEW_INTELLIGENCE_MAX_OVERVIEW_LENGTH = 600;

export const REVIEW_INTELLIGENCE_MAX_BULLET_LENGTH = 200;

export const REVIEW_INTELLIGENCE_MAX_SNIPPET_LENGTH = 200;

export const REVIEW_INTELLIGENCE_MAX_BULLETS = 6;

export const REVIEW_INTELLIGENCE_MAX_EVIDENCE = 6;

export const REVIEW_INTELLIGENCE_CACHE_MAX_ENTRIES = 200;

export const REVIEW_INTELLIGENCE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export const REVIEW_INTELLIGENCE_NEGATIVE_CACHE_TTL_MS = 30 * 60 * 1000;

export const REVIEW_INTELLIGENCE_DISABLED_REASON = "Review highlights are disabled.";

export const REVIEW_INTELLIGENCE_UNAVAILABLE_REASON =
  "Review highlights are temporarily unavailable. Please try again.";

/**
 * Fail-closed guard against invented safety claims in model-generated text.
 * A generated field matching this pattern is rejected unless the same
 * assurance already appears in the cited source review (checked by the
 * service); the model must never invent allergy, dietary-safety, or
 * guarantee claims. Snippets are verbatim user text and skip this screen.
 */
export const UNSAFE_REVIEW_CLAIM_PATTERN =
  /\b(allergen[-\s]?free|gluten[-\s]?free|nut[-\s]?free|dairy[-\s]?free|safe for (your )?allerg|no allerg|guaranteed safe|100%\s?safe)\b/i;

/** Model-generated fields must be plain text: no tags or markup. */
export const REVIEW_HTML_TAG_PATTERN = /<[a-zA-Z/!][^<>]*>/;

export const reviewIntelligenceLanguageSchema = z.enum(["en", "vi"]);

export type ReviewIntelligenceLanguage = z.infer<typeof reviewIntelligenceLanguageSchema>;

export const reviewHighlightsRequestSchema = z.object({
  venueId: z.string().trim().min(1).max(120),
  language: reviewIntelligenceLanguageSchema,
});

export type ReviewHighlightsRequest = z.infer<typeof reviewHighlightsRequestSchema>;

export const reviewHighlightEvidenceSchema = z.object({
  reviewId: z.string().min(1).max(120),
  snippet: z.string().min(1).max(REVIEW_INTELLIGENCE_MAX_SNIPPET_LENGTH),
});

export type ReviewHighlightEvidence = z.infer<typeof reviewHighlightEvidenceSchema>;

const reviewHighlightsBulletsSchema = z
  .array(z.string().min(1).max(REVIEW_INTELLIGENCE_MAX_BULLET_LENGTH))
  .max(REVIEW_INTELLIGENCE_MAX_BULLETS);

export const reviewHighlightsReadySchema = z.object({
  _tag: z.literal("Ready"),
  overview: z.string().min(1).max(REVIEW_INTELLIGENCE_MAX_OVERVIEW_LENGTH),
  positives: reviewHighlightsBulletsSchema,
  cautions: reviewHighlightsBulletsSchema,
  evidence: z.array(reviewHighlightEvidenceSchema).max(REVIEW_INTELLIGENCE_MAX_EVIDENCE),
  sampleCount: z.number().int().min(1),
  totalCount: z.number().int().nonnegative(),
  generatedAt: z.string().min(1).max(64),
});

export type ReviewHighlightsReady = z.infer<typeof reviewHighlightsReadySchema>;

export const reviewHighlightsOutcomeSchema = z.discriminatedUnion("_tag", [
  reviewHighlightsReadySchema,
  z.object({ _tag: z.literal("Insufficient") }),
  z.object({ _tag: z.literal("Unavailable") }),
]);

export type ReviewHighlightsOutcome = z.infer<typeof reviewHighlightsOutcomeSchema>;

export const translateReviewRequestSchema = z.object({
  reviewId: z.string().trim().min(1).max(120),
  target: reviewIntelligenceLanguageSchema,
});

export type TranslateReviewRequest = z.infer<typeof translateReviewRequestSchema>;

export const translateReviewOutcomeSchema = z.discriminatedUnion("_tag", [
  z.object({
    _tag: z.literal("Done"),
    translation: z.string().min(1).max(4000),
    sourceLang: z.string().min(2).max(16),
  }),
  z.object({ _tag: z.literal("Failed") }),
]);

export type TranslateReviewOutcome = z.infer<typeof translateReviewOutcomeSchema>;

export const supportingReviewsRequestSchema = z.object({
  ids: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
});

export type SupportingReviewsRequest = z.infer<typeof supportingReviewsRequestSchema>;

export const supportingReviewSchema = z.object({
  id: z.string().min(1).max(120),
  rating: z.number().int().min(1).max(5),
  body: z.string().min(1).max(2000),
  publishedAt: z.string().min(1),
});

export type SupportingReview = z.infer<typeof supportingReviewSchema>;

export const supportingReviewListSchema = z.array(supportingReviewSchema).max(20);

/**
 * Provider wire shape for one highlights call. Strict (no optionals) so
 * the strict JSON-schema response format accepts it; memberOf-set and
 * safety validation happen in the service, not here.
 */
export const reviewHighlightsDraftSchema = z.strictObject({
  overview: z.string().min(1).max(REVIEW_INTELLIGENCE_MAX_OVERVIEW_LENGTH),
  positives: z.array(z.string().min(1).max(REVIEW_INTELLIGENCE_MAX_BULLET_LENGTH)).max(6),
  cautions: z.array(z.string().min(1).max(REVIEW_INTELLIGENCE_MAX_BULLET_LENGTH)).max(6),
  evidence: z
    .array(
      z.strictObject({
        reviewId: z.string().min(1).max(120),
        snippet: z.string().min(1).max(REVIEW_INTELLIGENCE_MAX_SNIPPET_LENGTH),
      }),
    )
    .max(6),
});

export type ReviewHighlightsDraft = z.infer<typeof reviewHighlightsDraftSchema>;

/** Provider wire shape for one translation call. */
export const reviewTranslationDraftSchema = z.strictObject({
  translation: z.string().min(1).max(4000),
  sourceLang: z.string().min(2).max(16),
});

export type ReviewTranslationDraft = z.infer<typeof reviewTranslationDraftSchema>;

export interface ReviewIntelligenceConfig {
  readonly enabled: boolean;
  /** Empty when MODEL_API_KEY is unset; the client fails loudly at call time. */
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  /**
   * Completion-token budget serialized as `max_tokens` on the
   * `/chat/completions` request (see the client for the field choice).
   * Operator-owned: REVIEW_INTELLIGENCE_MAX_COMPLETION_TOKENS flows through
   * exactly as configured; unset uses
   * REVIEW_INTELLIGENCE_DEFAULT_MAX_COMPLETION_TOKENS.
   */
  readonly maxCompletionTokens: number;
  /**
   * Reviews sent to the provider in one call. Operator-owned:
   * REVIEW_INTELLIGENCE_MAX_SAMPLE flows through exactly as configured;
   * unset uses REVIEW_INTELLIGENCE_MAX_SAMPLE.
   */
  readonly maxSample: number;
}

/**
 * Operator-owned timeout: a valid explicitly configured value flows through
 * exactly as set; the default applies only when unset. No upper bound —
 * upstream provider limits surface as provider failures. Strict
 * whole-string matching: Number.parseInt alone would accept "20000abc" as
 * 20000, so anything that is not all digits fails loudly naming field +
 * reason.
 */
const parseOperatorTimeoutMs = (raw: string | undefined): number => {
  if (raw === undefined) {
    return REVIEW_INTELLIGENCE_DEFAULT_TIMEOUT_MS;
  }

  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `REVIEW_INTELLIGENCE_TIMEOUT_MS must be a positive safe integer of milliseconds or unset (unset uses ${REVIEW_INTELLIGENCE_DEFAULT_TIMEOUT_MS}).`,
    );
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `REVIEW_INTELLIGENCE_TIMEOUT_MS must be a positive safe integer of milliseconds or unset (unset uses ${REVIEW_INTELLIGENCE_DEFAULT_TIMEOUT_MS}).`,
    );
  }

  return parsed;
};

/**
 * Operator-owned positive integer: a valid explicitly configured value flows
 * through exactly as set and the default applies only when the variable is
 * unset. There is intentionally no upper bound — provider-side limits are
 * the provider's responsibility and surface as provider failures, never as
 * silent configuration rewrites. Strict whole-string matching:
 * Number.parseInt alone would accept "12000abc" as 12000, so anything that
 * is not all digits fails loudly naming field + reason.
 */
const parseOperatorPositiveInt = (
  raw: string | undefined,
  field: string,
  fallback: number,
): number => {
  if (raw === undefined) {
    return fallback;
  }

  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${field} must be a positive safe integer or unset (unset uses ${fallback}).`);
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive safe integer or unset (unset uses ${fallback}).`);
  }

  return parsed;
};

/**
 * Model ownership: the shared MODEL_MODEL_ID is the default so review
 * summaries move with the rest of the Muse fleet with no extra configuration.
 * REVIEW_INTELLIGENCE_MODEL_ID is a dedicated override for operators who must
 * pin review output independently of ranking experiments — the highlights
 * contract (strict schema, verbatim evidence snippets) is validated against a
 * specific model's behavior, so ranking model churn must never silently
 * change review output. Either way the resolved id must satisfy the shared
 * supported-model shape; an explicitly set unusable id throws naming field +
 * reason at startup instead of silently falling back to another model. There
 * is no silent fallback anywhere on this path: unset means the documented
 * default, invalid means a loud startup failure.
 */
const resolveReviewIntelligenceModelId = (env: Record<string, string | undefined>): string => {
  const override = env["REVIEW_INTELLIGENCE_MODEL_ID"];

  if (override !== undefined) {
    if (!isSupportedModelId(override)) {
      throw new Error(
        "REVIEW_INTELLIGENCE_MODEL_ID is not a supported Muse model id (expected muse-spark-<major>.<minor>[-contributor] or muse-wonder-<major>.<minor>).",
      );
    }

    return override;
  }

  const shared = env["MODEL_MODEL_ID"];

  if (shared !== undefined) {
    if (!isSupportedModelId(shared)) {
      throw new Error(
        "MODEL_MODEL_ID is not a supported Muse model id (expected muse-spark-<major>.<minor>[-contributor] or muse-wonder-<major>.<minor>).",
      );
    }

    return shared;
  }

  return DEFAULT_MODEL_ID;
};

/**
 * Pure resolver over the raw environment bag (`process.env` in production).
 * Takes `Record<string, string | undefined>` deliberately: the env bag is an
 * untrusted external boundary, not an application map. Disabled unless
 * REVIEW_INTELLIGENCE_ENABLED is exactly "true". Never imported from
 * server/env.ts parsing: the caller passes the raw bag, which keeps this
 * pure and unit-testable without touching process state.
 */
export const resolveReviewIntelligenceConfig = (
  env: Record<string, string | undefined>,
): ReviewIntelligenceConfig => ({
  enabled: env["REVIEW_INTELLIGENCE_ENABLED"] === REVIEW_INTELLIGENCE_ENABLED_VALUE,
  apiKey: env["MODEL_API_KEY"] ?? "",
  baseUrl: env["MODEL_BASE_URL"] ?? DEFAULT_MODEL_BASE_URL,
  modelId: resolveReviewIntelligenceModelId(env),
  timeoutMs: parseOperatorTimeoutMs(env["REVIEW_INTELLIGENCE_TIMEOUT_MS"]),
  maxResponseBytes: parseOperatorPositiveInt(
    env["REVIEW_INTELLIGENCE_MAX_RESPONSE_BYTES"],
    "REVIEW_INTELLIGENCE_MAX_RESPONSE_BYTES",
    REVIEW_INTELLIGENCE_MAX_RESPONSE_BYTES,
  ),
  maxCompletionTokens: parseOperatorPositiveInt(
    env["REVIEW_INTELLIGENCE_MAX_COMPLETION_TOKENS"],
    "REVIEW_INTELLIGENCE_MAX_COMPLETION_TOKENS",
    REVIEW_INTELLIGENCE_DEFAULT_MAX_COMPLETION_TOKENS,
  ),
  maxSample: parseOperatorPositiveInt(
    env["REVIEW_INTELLIGENCE_MAX_SAMPLE"],
    "REVIEW_INTELLIGENCE_MAX_SAMPLE",
    REVIEW_INTELLIGENCE_MAX_SAMPLE,
  ),
});
