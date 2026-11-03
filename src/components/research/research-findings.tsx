import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

/** One cited web source. Only http(s) URLs render as links; others are dropped. */
export interface ResearchSource {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/**
 * One web-research finding. Names are display strings exactly as reported —
 * this list never invents ingredients, history, prices, or health claims;
 * anything the evidence does not state simply stays absent.
 */
export interface ResearchFinding {
  readonly title: string;
  readonly summary: string;
  readonly venueName?: string | undefined;
  readonly dishName?: string | undefined;
  readonly originalName?: string | undefined;
  readonly sources: ReadonlyArray<ResearchSource>;
}

export interface ResearchFindingsListProps {
  readonly findings: ReadonlyArray<ResearchFinding>;
  /** Provenance badge text (research-copy `webResultBadge`). */
  readonly badgeLabel: string;
  /** Unverified-data note (research-copy `notVerifiedNote`). */
  readonly notVerifiedNote: string;
}

/** Renderable only over http(s); rejects javascript:, data:, and malformed URLs. */
const safeSourceUrl = (raw: string): string | null => {
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  return parsed.toString();
};

const hasText = (value: string): boolean => value.trim() !== "";

const renderableSources = (sources: ReadonlyArray<ResearchSource>): Array<ResearchSource> => {
  const kept: Array<ResearchSource> = [];

  for (const source of sources) {
    if (!hasText(source.title) || safeSourceUrl(source.url) === null) {
      continue;
    }

    kept.push(source);
  }

  return kept;
};

/**
 * Cited web-research results, rendered separately from the canonical dish
 * carousel: every finding is a plain card with its title, summary, and real
 * outbound source links plus a provenance badge marking it as unverified
 * web data. Findings or sources without usable text/links are dropped, not
 * padded — an empty result renders nothing so the caller can fall back to
 * its no-evidence state.
 */
export function ResearchFindingsList({
  badgeLabel,
  findings,
  notVerifiedNote,
}: ResearchFindingsListProps): ReactNode {
  const cards: Array<{ finding: ResearchFinding; sources: Array<ResearchSource> }> = [];

  for (const finding of findings) {
    if (!hasText(finding.title) || !hasText(finding.summary)) {
      continue;
    }

    const sources = renderableSources(finding.sources);

    if (sources.length === 0) {
      continue;
    }

    cards.push({ finding, sources });
  }

  if (cards.length === 0) {
    return null;
  }

  return (
    <section aria-label={badgeLabel} className="mt-4 w-full">
      <div className="overflow-hidden rounded-2xl border border-border-soft bg-white shadow-[0_12px_28px_rgba(194,65,12,0.08)]">
        <div className="flex flex-wrap items-center gap-2 border-b border-border-soft bg-cream/60 px-5 py-3">
          <span className="inline-flex items-center rounded-full bg-space-deep px-3 py-1 text-xs font-bold tracking-wide text-cream uppercase">
            {badgeLabel}
          </span>
          <p className="min-w-0 flex-1 text-xs font-semibold text-muted">{notVerifiedNote}</p>
        </div>
        <ul className="divide-y divide-border-soft">
          {cards.map(({ finding, sources }) => (
            <li key={finding.title} className="px-5 py-4 text-left">
              <h4 className="font-display text-xl leading-tight tracking-wide text-ink">
                {finding.title}
              </h4>
              {finding.originalName !== undefined && hasText(finding.originalName) ? (
                <p className="mt-0.5 truncate text-sm font-bold text-ink">{finding.originalName}</p>
              ) : null}
              {finding.dishName !== undefined && hasText(finding.dishName) ? (
                <p className="mt-0.5 text-xs font-bold tracking-[0.14em] text-food-orange-strong uppercase">
                  {finding.dishName}
                </p>
              ) : null}
              {finding.venueName !== undefined && hasText(finding.venueName) ? (
                <p className="mt-0.5 text-sm font-semibold text-muted">{finding.venueName}</p>
              ) : null}
              <p className="mt-2 text-sm leading-relaxed text-ink">{finding.summary}</p>
              <ul className="mt-3 flex flex-col gap-2">
                {sources.map((source) => (
                  <li key={source.url} className="min-w-0">
                    <a
                      href={safeSourceUrl(source.url) ?? undefined}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="group inline-flex max-w-full items-center gap-1.5 text-sm font-bold text-brand-blue underline-offset-2 hover:underline"
                    >
                      <ExternalLinkIcon
                        aria-hidden="true"
                        className="size-3.5 flex-none text-muted group-hover:text-brand-blue"
                      />
                      <span className="min-w-0 truncate">{source.title}</span>
                    </a>
                    {hasText(source.snippet) ? (
                      <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">
                        {source.snippet}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
