import { Data } from "effect";

/**
 * Geographic and preference scope for a web-research operation. City and
 * country are required; every other field refines the provider query.
 * Client-safe: plain strings, JSON-serializable.
 */
export interface ResearchScope {
  readonly city: string;
  readonly country: string;
  readonly language?: string | undefined;
  readonly portion?: string | undefined;
  readonly channel?: string | undefined;
  readonly currency?: string | undefined;
}

/** Restaurant search scope: a base scope plus an optional dish focus. */
export interface ResearchRestaurantScope extends ResearchScope {
  readonly dish?: string | undefined;
}

/** Price lookup input: the dish is required, refinements stay optional. */
export interface ResearchPriceScope {
  readonly dish: string;
  readonly city: string;
  readonly country: string;
  readonly language?: string | undefined;
  readonly portion?: string | undefined;
  readonly channel?: string | undefined;
  readonly currency?: string | undefined;
}

/** One provider-cited web source. URLs are validated http(s) only. */
export interface ResearchSource {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/**
 * One research finding derived from provider output. Sources are
 * operation-level evidence shared across the findings of one call.
 */
export interface ResearchFinding {
  readonly title: string;
  readonly summary: string;
  readonly venueName?: string | undefined;
  readonly dishName?: string | undefined;
  readonly sources: ReadonlyArray<ResearchSource>;
}

/**
 * Client-safe research outcome. Every provider or transport failure maps to
 * ResearchUnavailable with a safe reason; the error channel stays `never`
 * so server-function callers receive plain JSON in all cases.
 */
export type ResearchOutcome = Data.TaggedEnum<{
  ResearchFound: {
    readonly findings: ReadonlyArray<ResearchFinding>;
    readonly scope: ResearchScope;
    readonly retrievedAt: string;
    readonly searchExecuted: boolean;
  };
  ResearchEmpty: {
    readonly scope: ResearchScope;
    readonly retrievedAt: string;
    readonly searchExecuted: boolean;
  };
  ResearchUnavailable: {
    readonly reason: string;
  };
  ResearchSkipped: {
    readonly reason: string;
  };
}>;

export const ResearchOutcome = Data.taggedEnum<ResearchOutcome>();
