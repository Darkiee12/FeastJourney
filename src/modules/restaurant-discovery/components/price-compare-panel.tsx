import { useRef, useState } from "react";
import { z } from "zod";

import { MuseResearchStatus } from "@/components/research/muse-research-status";
import type { ResearchStatusState } from "@/components/research/muse-research-status";
import { researchCopyFor } from "@/components/research/research-copy";
import { ResearchFindingsList } from "@/components/research/research-findings";
import type { ResearchFinding } from "@/components/research/research-findings";
import {
  ObservedPrice,
  PriceProvenance,
  PriceUnavailable,
  priceAvailability,
} from "@/modules/restaurant-discovery/components/currency-tools";
import { researchPricesFn } from "@/server/web-research/research-functions";
import type { ResearchOutcome } from "@/server/web-research/research-types";
import type { Locale } from "@/shared/i18n";
import { isCurrency } from "@/shared/money";
import type { ExchangeRate } from "@/shared/money";

export interface PriceCompareRow {
  readonly venueId: string;
  readonly venueName: string;
  readonly area: string;
  readonly itemName: string;
  readonly variantName: string;
  readonly amount: string | null;
  readonly currency: string | null;
  /** YYYY-MM-DD observation date, sliced server-side from observed_at. */
  readonly evidenceDate: string;
  readonly stale: boolean;
  readonly channelLabel: string;
  readonly sourceCategory: string | null;
  readonly rate: ExchangeRate | undefined;
  readonly venueHref: string;
  /**
   * Serving-evidence match kind for this row. `"suggestion"` rows are
   * tentative (scanned item ↔ canonical dish uncertain) and render an
   * explicit tentative badge. Optional so older callers keep compiling;
   * absent kinds render without a badge rather than inventing certainty.
   */
  readonly matchKind?: "exact" | "variant" | "suggestion" | undefined;
}

/** Dish identity + comparability scope for one user-triggered web price lookup. */
export interface PriceResearchContext {
  readonly dish: string;
  readonly city: string;
  readonly country: string;
  readonly portion?: string | undefined;
  readonly channel?: string | undefined;
  readonly currency?: string | undefined;
  readonly language: "en" | "vi";
}

export type PriceResearchLoader = (
  request: PriceResearchContext,
) => Promise<ParsedPriceResearch | null>;

const defaultPriceResearchLoader: PriceResearchLoader = async (request) =>
  parsePriceResearchOutcome(
    await researchPricesFn({
      data: {
        dish: request.dish,
        city: request.city,
        country: request.country,
        portion: request.portion,
        channel: request.channel,
        currency: request.currency,
        language: request.language,
      },
    }),
  );

export interface PriceResearchLabels {
  readonly trigger: string;
  readonly comparabilityNote: string;
  readonly tentative: string;
}

const researchLabelsEn: PriceResearchLabels = {
  trigger: "Research public prices",
  comparabilityNote:
    "Public listings may mix portions or sales channels — takeaway vs dine-in and large vs small are never directly comparable. Confirm portion and channel per listing before comparing.",
  tentative: "Tentative match — confirm with the venue",
};

const researchLabelsVi: PriceResearchLabels = {
  trigger: "Tra cứu giá công khai",
  comparabilityNote:
    "Giá công khai có thể lẫn lộn khẩu phần hoặc kênh bán — mang đi so với ăn tại chỗ, cỡ lớn so với cỡ nhỏ không bao giờ so sánh trực tiếp được. Hãy xác nhận khẩu phần và kênh bán của từng giá trước khi so sánh.",
  tentative: "Món khớp gợi ý — hãy xác nhận với quán",
};

const researchPriceSourceSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
});

const researchPriceFindingSchema = z.object({
  title: z.string(),
  summary: z.string(),
  venueName: z.string().optional(),
  dishName: z.string().optional(),
  originalName: z.string().optional(),
  sources: z.array(researchPriceSourceSchema),
});

const researchFoundSchema = z.object({
  _tag: z.literal("ResearchFound"),
  findings: z.array(researchPriceFindingSchema),
});

const researchEmptySchema = z.object({ _tag: z.literal("ResearchEmpty") });

const researchUnavailableSchema = z.object({ _tag: z.literal("ResearchUnavailable") });

const researchSkippedSchema = z.object({ _tag: z.literal("ResearchSkipped") });

export interface ParsedPriceResearch {
  readonly tag: "ResearchFound" | "ResearchEmpty" | "ResearchUnavailable" | "ResearchSkipped";
  readonly findings: ReadonlyArray<ResearchFinding>;
}

/**
 * Boundary parser for the peer `ResearchOutcome`. Unknown shapes return
 * null so the caller renders failed/retry instead of inventing results.
 * Findings the shared list cannot render (no title/summary/linkable
 * sources) are dropped by that list, which then renders nothing.
 */
export function parsePriceResearchOutcome(outcome: ResearchOutcome): ParsedPriceResearch | null {
  const found = researchFoundSchema.safeParse(outcome);

  if (found.success) return { tag: "ResearchFound", findings: found.data.findings };

  if (researchEmptySchema.safeParse(outcome).success) return { tag: "ResearchEmpty", findings: [] };

  if (researchUnavailableSchema.safeParse(outcome).success)
    return { tag: "ResearchUnavailable", findings: [] };

  if (researchSkippedSchema.safeParse(outcome).success)
    return { tag: "ResearchSkipped", findings: [] };

  return null;
}

const isPricedRow = (row: PriceCompareRow): boolean =>
  row.amount !== null &&
  row.currency !== null &&
  priceAvailability(row.amount, row.currency) === "priced";

const validResearchContext = (context: PriceResearchContext): boolean => {
  if (context.dish.trim() === "") return false;

  if (context.city.trim() === "") return false;

  if (context.country.trim() === "") return false;

  if (context.currency !== undefined && !isCurrency(context.currency)) return false;

  return true;
};

/** Scope line from request data only — dish names and places, never invented prices. */
const scopeLine = (context: PriceResearchContext): string => {
  const parts = [context.dish];

  if (context.portion !== undefined && context.portion.trim() !== "") parts.push(context.portion);

  if (context.channel !== undefined && context.channel.trim() !== "") parts.push(context.channel);

  parts.push(`${context.city}, ${context.country}`);

  if (context.currency !== undefined) parts.push(context.currency);

  return parts.join(" · ");
};

function PriceResearchSection({
  context,
  loader,
  locale,
  labels,
}: {
  readonly context: PriceResearchContext;
  readonly loader: PriceResearchLoader;
  readonly locale: Locale;
  readonly labels: PriceResearchLabels;
}) {
  const strings = researchCopyFor(locale === "vi" ? "vi" : "en");
  const [state, setState] = useState<ResearchStatusState>("idle");
  const [contextLine, setContextLine] = useState("");
  const [findings, setFindings] = useState<ReadonlyArray<ResearchFinding>>([]);
  const runRef = useRef(0);

  const dismiss = (): void => {
    runRef.current += 1;
    setState("idle");
    setContextLine("");
    setFindings([]);
  };

  const run = (): void => {
    if (!validResearchContext(context)) {
      runRef.current += 1;
      setFindings([]);
      setContextLine(strings.statusFailed);
      setState("failed");

      return;
    }

    const runId = runRef.current + 1;

    runRef.current = runId;

    const alive = (): boolean => runRef.current === runId;

    setFindings([]);
    setContextLine(strings.statusSearching);
    setState("preparing");
    void (async () => {
      try {
        if (!alive()) return;

        setState("searching");

        const raw = await loader(context);

        if (!alive()) return;

        setContextLine(strings.statusReviewing);
        setState("reviewing");

        const outcome = raw;

        if (!alive()) return;

        if (outcome === null || outcome.tag === "ResearchUnavailable") {
          setContextLine(strings.statusFailed);
          setState("failed");

          return;
        }

        if (outcome.tag === "ResearchFound" && outcome.findings.length > 0) {
          setFindings(outcome.findings);
          setContextLine(`${strings.statusCompleted} ${scopeLine(context)}`);
          setState("completed");

          return;
        }

        setContextLine(strings.statusNoEvidence);
        setState("no-evidence");
      } catch {
        if (!alive()) return;

        setContextLine(strings.statusFailed);
        setState("failed");
      }
    })();
  };

  if (state === "idle") {
    return (
      <section className="price-research" aria-label={labels.trigger}>
        <button type="button" className="mapapp-ghost-btn price-research-trigger" onClick={run}>
          {labels.trigger}
        </button>
      </section>
    );
  }

  return (
    <section className="price-research" aria-label={labels.trigger}>
      <MuseResearchStatus
        state={state}
        contextLine={contextLine}
        onRetry={run}
        onContinue={dismiss}
        retryLabel={strings.retryAction}
        continueLabel={strings.continueCatalogAction}
      />
      {state === "completed" && (
        <>
          <p className="mapapp-note">{labels.comparabilityNote}</p>
          <ResearchFindingsList
            findings={findings}
            badgeLabel={strings.webResultBadge}
            notVerifiedNote={strings.notVerifiedNote}
          />
        </>
      )}
    </section>
  );
}

/**
 * Dish price comparison view. Presentational only: rows arrive in server
 * order from the dish-scoped search (same canonical dish, compatible
 * portion, sales channel, eligible current listed prices). No float math,
 * no receipt-total normalization, no currency mixing before conversion —
 * conversions render only from the supplied real FX rate with provenance.
 *
 * Ranking honesty: a "lowest/highest comparable" badge appears only when
 * the server sorted by price AND at least two comparable prices are
 * present. One price renders as-is with no cheapest claim; no priced rows
 * render the empty state without implying any venue serves the dish.
 *
 * Web research (optional `researchContext`): when first-party observations
 * are insufficient for a valid comparison (fewer than two priced rows),
 * the panel offers one user-triggered public-price lookup. Findings render
 * in a SEPARATE section labeled publicly-listed/not-verified, never merged
 * into reviewed rows. The peer outcome carries no machine-readable
 * amounts, so no median/range/average is ever computed from prose — the
 * comparability warning stands in place of statistics. Web evidence stays
 * in memory and is never promoted to canonical tables.
 */
export function PriceComparePanel({
  rows,
  sortMode,
  ratesAvailable,
  locale,
  emptyTitle = "No comparable menu prices yet",
  emptyBody = "You can still explore restaurants or check their available menus.",
  singlePriceNote = "Only one comparable price in this view.",
  lowestLabel = "Lowest comparable price",
  highestLabel = "Highest comparable price",
  fxNote = "Approximate conversions are unavailable. Original menu prices are still shown.",
  researchContext,
  researchLoader = defaultPriceResearchLoader,
  researchLabels,
}: {
  readonly rows: ReadonlyArray<PriceCompareRow>;
  readonly sortMode: "price_low" | "price_high" | "recommended" | "nearest";
  readonly ratesAvailable: boolean;
  readonly locale: Locale;
  readonly emptyTitle?: string | undefined;
  readonly emptyBody?: string | undefined;
  readonly singlePriceNote?: string | undefined;
  readonly lowestLabel?: string | undefined;
  readonly highestLabel?: string | undefined;
  readonly fxNote?: string | undefined;
  readonly researchContext?: PriceResearchContext | null | undefined;
  readonly researchLoader?: PriceResearchLoader | undefined;
  readonly researchLabels?: Partial<PriceResearchLabels> | undefined;
}) {
  const labels: PriceResearchLabels = {
    ...(locale === "vi" ? researchLabelsVi : researchLabelsEn),
    ...researchLabels,
  };

  const pricedCount = rows.filter(
    (row) => priceAvailability(row.amount, row.currency) === "priced",
  ).length;

  // Rank badges preserve the local-range comparative gate: a cheapest /
  // priciest claim needs a real comparison (2+ priced rows) under an
  // explicit price sort. Anything else renders unranked. The badge target
  // is computed up front so rendering stays mutation-free.
  const ranked = (sortMode === "price_low" || sortMode === "price_high") && pricedCount >= 2;
  const rankLabel = sortMode === "price_high" ? highestLabel : lowestLabel;

  const rankedBadgeVenueId = ranked
    ? (rows.find((row) => isPricedRow(row))?.venueId ?? null)
    : null;

  const researchOffered = pricedCount < 2 ? (researchContext ?? null) : null;

  if (pricedCount === 0) {
    return (
      <div className="price-compare">
        <div className="price-compare-empty" aria-live="polite">
          <h3>{emptyTitle}</h3>
          <p>{emptyBody}</p>
          {rows.length > 0 && (
            <ul className="price-compare-list">
              {rows.map((row) => (
                <li key={row.venueId}>
                  <a href={row.venueHref}>{row.venueName}</a>
                  <p>
                    {row.itemName} · {row.variantName}
                  </p>
                  <PriceUnavailable />
                </li>
              ))}
            </ul>
          )}
        </div>
        {!ratesAvailable && (
          <p aria-live="polite" className="mapapp-note">
            {fxNote}
          </p>
        )}
        {researchOffered !== null && (
          <PriceResearchSection
            context={researchOffered}
            loader={researchLoader}
            locale={locale}
            labels={labels}
          />
        )}
      </div>
    );
  }

  return (
    <div className="price-compare">
      {!ratesAvailable && (
        <p aria-live="polite" className="mapapp-note">
          {fxNote}
        </p>
      )}
      {pricedCount === 1 && (
        <p aria-live="polite" className="mapapp-note">
          {singlePriceNote}
        </p>
      )}
      <ul className="price-compare-list">
        {rows.map((row) => {
          const { amount, currency } = row;

          if (!isPricedRow(row) || amount === null || currency === null) {
            return (
              <li key={row.venueId} className="price-compare-row">
                <a href={row.venueHref}>{row.venueName}</a>
                <p>
                  {row.itemName} · {row.variantName}
                </p>
                <PriceUnavailable />
                <PriceProvenance
                  observedAt={row.evidenceDate}
                  sourceCategory={row.sourceCategory}
                  channelLabel={row.channelLabel}
                  stale={row.stale}
                />
              </li>
            );
          }

          return (
            <li key={row.venueId} className="price-compare-row">
              <a href={row.venueHref}>{row.venueName}</a>
              <p>
                {row.itemName} · {row.variantName}
              </p>
              {row.matchKind === "suggestion" && (
                <p className="mapapp-note price-compare-tentative">{labels.tentative}</p>
              )}
              {row.venueId === rankedBadgeVenueId && (
                <p className="price-compare-rank">{rankLabel}</p>
              )}
              <ObservedPrice amount={amount} currency={currency} locale={locale} rate={row.rate} />
              <PriceProvenance
                observedAt={row.evidenceDate}
                sourceCategory={row.sourceCategory}
                channelLabel={row.channelLabel}
                stale={row.stale}
              />
            </li>
          );
        })}
      </ul>
      {researchOffered !== null && (
        <PriceResearchSection
          context={researchOffered}
          loader={researchLoader}
          locale={locale}
          labels={labels}
        />
      )}
    </div>
  );
}
