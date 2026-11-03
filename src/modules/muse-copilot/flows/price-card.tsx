import type { ReactNode } from "react";

import {
  PriceComparePanel,
  type PriceCompareRow,
  type PriceResearchContext,
} from "@/modules/restaurant-discovery/components/price-compare-panel";
import type { Locale } from "@/shared/i18n";

/**
 * Copilot price card. A thin scope wrapper over the canonical
 * `PriceComparePanel`: comparability math, provenance badges, and the
 * web-price research slot all stay inside that panel. This card only adds
 * the explicit comparability scope (portion, channel, currency) the copilot
 * was asked about, and only for facets the caller actually provides —
 * absent facets render no line rather than an assumed default. No
 * averages or fabricated totals are computed here.
 */
export function CopilotPriceCard({
  channel,
  currency,
  locale,
  portion,
  ratesAvailable,
  researchContext,
  rows,
  scopeNote,
}: {
  /** Sales channel the prices were compared under, when known. */
  readonly channel?: string | undefined;
  /** Currency the traveler asked about, when known. */
  readonly currency?: string | undefined;
  readonly locale: Locale;
  /** Portion the prices were compared under, when known. */
  readonly portion?: string | undefined;
  readonly ratesAvailable: boolean;
  readonly researchContext?: PriceResearchContext | null | undefined;
  readonly rows: ReadonlyArray<PriceCompareRow>;
  /** Short scope line, e.g. "Takeaway · large". Caller-composed. */
  readonly scopeNote?: string | undefined;
}): ReactNode {
  const scopeParts: Array<string> = [];

  if (portion !== undefined && portion.trim() !== "") {
    scopeParts.push(portion);
  }

  if (channel !== undefined && channel.trim() !== "") {
    scopeParts.push(channel);
  }

  if (currency !== undefined && currency.trim() !== "") {
    scopeParts.push(currency);
  }

  const scopeLine = scopeParts.join(" · ");

  return (
    <div className="flex flex-col gap-2">
      {scopeLine === "" && (scopeNote === undefined || scopeNote === "") ? null : (
        <p className="text-xs font-bold tracking-wide text-muted uppercase">
          {scopeNote === undefined || scopeNote === "" ? scopeLine : scopeNote}
        </p>
      )}
      <PriceComparePanel
        rows={rows}
        sortMode="recommended"
        ratesAvailable={ratesAvailable}
        locale={locale}
        researchContext={researchContext}
      />
    </div>
  );
}
