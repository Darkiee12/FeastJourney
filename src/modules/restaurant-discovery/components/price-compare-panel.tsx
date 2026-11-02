import {
  ObservedPrice,
  PriceProvenance,
  PriceUnavailable,
  priceAvailability,
} from "@/modules/restaurant-discovery/components/currency-tools";
import type { Locale } from "@/shared/i18n";
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
}

const isPricedRow = (row: PriceCompareRow): boolean =>
  row.amount !== null &&
  row.currency !== null &&
  priceAvailability(row.amount, row.currency) === "priced";

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
}) {
  const pricedCount = rows.filter(
    (row) => priceAvailability(row.amount, row.currency) === "priced",
  ).length;

  if (pricedCount === 0) {
    return (
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
    );
  }

  // Rank badges preserve the local-range comparative gate: a cheapest /
  // priciest claim needs a real comparison (2+ priced rows) under an
  // explicit price sort. Anything else renders unranked. The badge target
  // is computed up front so rendering stays mutation-free.
  const ranked = (sortMode === "price_low" || sortMode === "price_high") && pricedCount >= 2;
  const rankLabel = sortMode === "price_high" ? highestLabel : lowestLabel;

  const rankedBadgeVenueId = ranked
    ? (rows.find((row) => isPricedRow(row))?.venueId ?? null)
    : null;

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
    </div>
  );
}
