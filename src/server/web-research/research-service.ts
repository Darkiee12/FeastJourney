import { Context, Effect, Layer } from "effect";
import { z } from "zod";

import {
  MetaResponsesClient,
  META_RESPONSES_MAX_BYTES,
  type MetaResponsesError,
  type MetaResponsesResearch,
  type ResponsesResearchResult,
} from "@/server/integrations/meta-responses";
import {
  makeResearchCache,
  normalizeResearchCacheKey,
  RESEARCH_CACHE_DEFAULT_MAX_ENTRIES,
  type ResearchCache,
  type ResearchCacheIntent,
} from "@/server/web-research/research-cache";
import { resolveResearchConfig, type ResearchConfig } from "@/server/web-research/research-config";
import {
  ResearchOutcome,
  type ResearchFinding,
  type ResearchPriceScope,
  type ResearchRestaurantScope,
  type ResearchScope,
} from "@/server/web-research/research-types";

/**
 * Web-research application service. Exactly one provider call per operation;
 * every provider or transport failure maps to ResearchUnavailable (never
 * thrown, never cached as negative). Budgets enforced here: single call,
 * response-byte cap (via the client), source cap, and result cap from the
 * resolved config. Structured logs carry kind/outcome/counts only — never
 * queries, PII, keys, prompts, or images.
 */

export const RESEARCH_DISABLED_REASON = "Web research is disabled.";

export const RESEARCH_UNAVAILABLE_REASON =
  "Web research is temporarily unavailable. Please try again.";

export const RESEARCH_MAX_TITLE_LENGTH = 200;

export const RESEARCH_MAX_SUMMARY_LENGTH = 1000;

export interface WebResearchService {
  readonly researchDishes: (scope: ResearchScope) => Effect.Effect<ResearchOutcome>;
  readonly researchRestaurants: (scope: ResearchRestaurantScope) => Effect.Effect<ResearchOutcome>;
  readonly researchPrices: (scope: ResearchPriceScope) => Effect.Effect<ResearchOutcome>;
}

export class WebResearch extends Context.Service<WebResearch, WebResearchService>()(
  "feastjourney/web-research/WebResearch",
) {}

export interface WebResearchDeps {
  readonly client: MetaResponsesResearch;
  readonly config: ResearchConfig;
  readonly cache: ResearchCache;
}

const DISHES_QUERY_INSTRUCTIONS = [
  "List traditional and popular local dishes for the area above.",
  "For each dish give a title and a one-to-two sentence summary for travellers.",
  'Respond with JSON only: {"findings": [{"title": "...", "summary": "...", "dish": "<dish name>"}]}.',
  "Never invent restaurant names, prices, opening hours, or URLs;",
  "report only what web search results support.",
].join(" ");

const RESTAURANTS_QUERY_INSTRUCTIONS = [
  "List well-known restaurants and eateries for the area above",
  "that serve the named dish when one is given, otherwise notable local venues.",
  "For each venue give a title and a one-to-two sentence summary for travellers.",
  'Respond with JSON only: {"findings": [{"title": "...", "summary": "...", "venue": "<venue name>", "dish": "<dish name>"}]}.',
  "Never invent menus, prices, opening hours, or URLs;",
  "report only what web search results support.",
].join(" ");

const PRICES_QUERY_INSTRUCTIONS = [
  "Report typical menu prices for the dish and area above,",
  "noting portion, channel, and currency context when given.",
  'Respond with JSON only: {"findings": [{"title": "...", "summary": "...", "venue": "<venue name>", "dish": "<dish name>"}]}.',
  "Put the price range and its context (portion, dine-in/takeaway, currency) in the summary.",
  "Never invent exact prices: report ranges only when search results support them,",
  "otherwise state that prices were unavailable.",
].join(" ");

const languageSuffix = (language: string | undefined): string =>
  language === undefined || language.length === 0 ? "" : ` Respond in ${language}.`;

const buildDishesQuery = (scope: ResearchScope): string =>
  `Traditional and popular local dishes in ${scope.city}, ${scope.country}. ${DISHES_QUERY_INSTRUCTIONS}${languageSuffix(scope.language)}`;

const buildRestaurantsQuery = (scope: ResearchRestaurantScope): string => {
  const dishLine =
    scope.dish === undefined || scope.dish.length === 0 ? "" : ` Focus dish: ${scope.dish}.`;

  return `Restaurants and eateries in ${scope.city}, ${scope.country}.${dishLine} ${RESTAURANTS_QUERY_INSTRUCTIONS}${languageSuffix(scope.language)}`;
};

const buildPricesQuery = (scope: ResearchPriceScope): string => {
  const context: Array<string> = [];

  if (scope.portion !== undefined && scope.portion.length > 0) {
    context.push(`portion ${scope.portion}`);
  }

  if (scope.channel !== undefined && scope.channel.length > 0) {
    context.push(`channel ${scope.channel}`);
  }

  if (scope.currency !== undefined && scope.currency.length > 0) {
    context.push(`currency ${scope.currency}`);
  }

  const contextLine = context.length === 0 ? "" : ` Context: ${context.join("; ")}.`;

  return `Menu prices for ${scope.dish} in ${scope.city}, ${scope.country}.${contextLine} ${PRICES_QUERY_INSTRUCTIONS}${languageSuffix(scope.language)}`;
};

const toOutcomeScope = (scope: {
  readonly city: string;
  readonly country: string;
  readonly language?: string | undefined;
  readonly portion?: string | undefined;
  readonly channel?: string | undefined;
  readonly currency?: string | undefined;
}): ResearchScope => ({
  city: scope.city,
  country: scope.country,
  language: scope.language,
  portion: scope.portion,
  channel: scope.channel,
  currency: scope.currency,
});

const findingPayloadSchema = z.object({
  title: z.string().trim().min(1).max(RESEARCH_MAX_TITLE_LENGTH),
  summary: z.string().trim().min(1).max(4000),
  venue: z.string().trim().min(1).max(RESEARCH_MAX_TITLE_LENGTH).optional(),
  dish: z.string().trim().min(1).max(RESEARCH_MAX_TITLE_LENGTH).optional(),
});

const findingsPayloadSchema = z.object({ findings: z.array(findingPayloadSchema) });

const truncateSummary = (value: string): string => {
  const flattened = value.replace(/\s+/g, " ").trim();

  return flattened.length <= RESEARCH_MAX_SUMMARY_LENGTH
    ? flattened
    : flattened.slice(0, RESEARCH_MAX_SUMMARY_LENGTH);
};

const buildFindings = (
  result: ResponsesResearchResult,
  scope: ResearchScope,
  maxResults: number,
  maxSources: number,
  fallbackTitle: string,
): ResearchOutcome => {
  const retrievedAt = new Date().toISOString();

  const sources = result.sources
    .slice(0, maxSources)
    .map((source) => ({ title: source.title, url: source.url, snippet: source.snippet }));

  const text = result.text.trim();

  if (text.length === 0 && sources.length === 0) {
    return ResearchOutcome.ResearchEmpty({
      scope,
      retrievedAt,
      searchExecuted: result.searchExecuted,
    });
  }

  if (text.length > 0) {
    const decoded = ((): ReturnType<typeof findingsPayloadSchema.safeParse> | null => {
      try {
        return findingsPayloadSchema.safeParse(JSON.parse(text));
      } catch {
        return null;
      }
    })();

    const findings = decoded !== null && decoded.success ? decoded.data.findings : null;

    if (findings !== null && findings.length > 0) {
      const capped: Array<ResearchFinding> = findings.slice(0, maxResults).map((finding) => ({
        title: finding.title,
        summary: truncateSummary(finding.summary),
        venueName: finding.venue,
        dishName: finding.dish,
        sources,
      }));

      return ResearchOutcome.ResearchFound({
        findings: capped,
        scope,
        retrievedAt,
        searchExecuted: result.searchExecuted,
      });
    }

    const fallback: ResearchFinding = {
      title: fallbackTitle,
      summary: truncateSummary(text),
      venueName: undefined,
      dishName: undefined,
      sources,
    };

    return ResearchOutcome.ResearchFound({
      findings: [fallback],
      scope,
      retrievedAt,
      searchExecuted: result.searchExecuted,
    });
  }

  const fromSources: Array<ResearchFinding> = [];

  for (const source of sources) {
    if (fromSources.length >= maxResults) {
      break;
    }

    if (source.title.length === 0) {
      continue;
    }

    fromSources.push({
      title: source.title.slice(0, RESEARCH_MAX_TITLE_LENGTH),
      summary: truncateSummary(source.snippet.length === 0 ? source.title : source.snippet),
      venueName: undefined,
      dishName: undefined,
      sources: [source],
    });
  }

  if (fromSources.length === 0) {
    return ResearchOutcome.ResearchEmpty({
      scope,
      retrievedAt,
      searchExecuted: result.searchExecuted,
    });
  }

  return ResearchOutcome.ResearchFound({
    findings: fromSources,
    scope,
    retrievedAt,
    searchExecuted: result.searchExecuted,
  });
};

const describeOutcome = (
  outcome: ResearchOutcome,
): {
  readonly findingCount: number;
  readonly sourceCount: number;
  readonly searchExecuted: boolean;
} =>
  ResearchOutcome.$match(outcome, {
    ResearchFound: (found) => ({
      findingCount: found.findings.length,
      sourceCount: found.findings.reduce((total, finding) => total + finding.sources.length, 0),
      searchExecuted: found.searchExecuted,
    }),
    ResearchEmpty: (empty) => ({
      findingCount: 0,
      sourceCount: 0,
      searchExecuted: empty.searchExecuted,
    }),
    ResearchUnavailable: () => ({ findingCount: 0, sourceCount: 0, searchExecuted: false }),
    ResearchSkipped: () => ({ findingCount: 0, sourceCount: 0, searchExecuted: false }),
  });

export const makeWebResearch = (deps: WebResearchDeps): WebResearchService => {
  const run = (
    kind: ResearchCacheIntent["kind"],
    intent: ResearchCacheIntent,
    scope: ResearchScope,
    query: string,
    fallbackTitle: string,
  ): Effect.Effect<ResearchOutcome> =>
    Effect.gen(function* () {
      if (!deps.config.enabled) {
        yield* Effect.logInfo("Web research skipped").pipe(
          Effect.annotateLogs({ kind, reason: "disabled" }),
        );

        return ResearchOutcome.ResearchSkipped({ reason: RESEARCH_DISABLED_REASON });
      }

      const startedAt = Date.now();
      const key = normalizeResearchCacheKey(intent);

      const toUnavailable = (error: MetaResponsesError) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Web research provider failed").pipe(
            Effect.annotateLogs({ kind, failure: error._tag }),
          );

          return ResearchOutcome.ResearchUnavailable({ reason: RESEARCH_UNAVAILABLE_REASON });
        });

      const fetchOnce: Effect.Effect<ResearchOutcome> = deps.client
        .research({
          query,
          locale: scope.language,
          geoCity: scope.city,
          geoCountry: scope.country,
          maxSources: deps.config.maxSources,
        })
        .pipe(
          Effect.map((result) =>
            buildFindings(
              result,
              scope,
              deps.config.maxResults,
              deps.config.maxSources,
              fallbackTitle,
            ),
          ),
          Effect.catchTags({
            MetaResponsesAuthError: toUnavailable,
            MetaResponsesRateLimited: toUnavailable,
            MetaResponsesRequestError: toUnavailable,
            MetaResponsesInvalidOutput: toUnavailable,
          }),
        );

      const { outcome, cacheHit } = yield* deps.cache.getOrCompute(key, fetchOnce);
      const summary = describeOutcome(outcome);

      yield* Effect.logInfo("Web research completed").pipe(
        Effect.annotateLogs({
          kind,
          outcome: outcome._tag,
          cacheHit,
          findingCount: summary.findingCount,
          sourceCount: summary.sourceCount,
          searchExecuted: summary.searchExecuted,
          durationMs: Date.now() - startedAt,
        }),
      );

      return outcome;
    });

  return {
    researchDishes: (scope) =>
      run(
        "dishes",
        {
          kind: "dishes",
          city: scope.city,
          country: scope.country,
          portion: scope.portion,
          channel: scope.channel,
          language: scope.language,
        },
        toOutcomeScope(scope),
        buildDishesQuery(scope),
        `Dishes in ${scope.city}`,
      ),
    researchRestaurants: (scope) =>
      run(
        "restaurants",
        {
          kind: "restaurants",
          dish: scope.dish,
          city: scope.city,
          country: scope.country,
          portion: scope.portion,
          channel: scope.channel,
          language: scope.language,
        },
        toOutcomeScope(scope),
        buildRestaurantsQuery(scope),
        scope.dish === undefined || scope.dish.length === 0
          ? `Restaurants in ${scope.city}`
          : `${scope.dish} in ${scope.city}`,
      ),
    researchPrices: (scope) =>
      run(
        "prices",
        {
          kind: "prices",
          dish: scope.dish,
          city: scope.city,
          country: scope.country,
          portion: scope.portion,
          channel: scope.channel,
          language: scope.language,
        },
        toOutcomeScope(scope),
        buildPricesQuery(scope),
        `Prices for ${scope.dish} in ${scope.city}`,
      ),
  };
};

let sharedCache: ResearchCache | undefined;
let sharedCacheSignature: string | undefined;

const getSharedCache = (config: ResearchConfig): ResearchCache => {
  const signature = `${config.cacheTtlMs}/${config.negativeCacheTtlMs}`;

  if (sharedCache === undefined || sharedCacheSignature !== signature) {
    sharedCache = makeResearchCache({
      maxEntries: RESEARCH_CACHE_DEFAULT_MAX_ENTRIES,
      positiveTtlMs: config.cacheTtlMs,
      negativeTtlMs: config.negativeCacheTtlMs,
    });
    sharedCacheSignature = signature;
  }

  return sharedCache;
};

/** Test and lifecycle escape hatch: drop the process-shared cache. */
export const resetResearchCache = (): void => {
  sharedCache = undefined;
  sharedCacheSignature = undefined;
};

export const makeWebResearchLive = (deps: WebResearchDeps): Layer.Layer<WebResearch> =>
  Layer.succeed(WebResearch, makeWebResearch(deps));

/**
 * Request-scoped wiring: resolves config from the process environment at
 * layer build, takes the MetaResponses client from the environment, and
 * reuses the process-shared TTL cache. The client carries the response-byte
 * budget (META_RESPONSES_MAX_BYTES, ~24KB).
 */
export const WebResearchLive: Layer.Layer<WebResearch, never, MetaResponsesClient> = Layer.effect(
  WebResearch,
  Effect.gen(function* () {
    const client = yield* MetaResponsesClient;

    let config: ResearchConfig;

    try {
      config = resolveResearchConfig(process.env);
    } catch (error) {
      // Invalid operator configuration fails loudly in server logs (field
      // + reason, never values) and fail-closed at the transport.
      yield* Effect.logError("Web research configuration invalid").pipe(
        Effect.annotateLogs({
          reason: error instanceof Error ? error.message : "unknown",
        }),
      );

      throw error;
    }

    return makeWebResearch({ client, config, cache: getSharedCache(config) });
  }),
);

export { META_RESPONSES_MAX_BYTES as RESEARCH_RESPONSE_BYTE_CAP };
