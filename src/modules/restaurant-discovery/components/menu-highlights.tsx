import { Link } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";

import { ObservedPrice } from "@/modules/restaurant-discovery/components/currency-tools";
import type { MenuHighlight } from "@/modules/restaurant-discovery/menu-presentation";
import type { MenuOffering } from "@/modules/restaurant-discovery/server/operations/discovery";
import type { Locale } from "@/shared/i18n";
import { isAmount, isCurrency, type ExchangeRate } from "@/shared/money";

const HIGHLIGHT_CAP = 3;

const listedPriceOf = (
  offerings: ReadonlyArray<MenuOffering>,
  itemId: string,
): { readonly amount: string; readonly currency: string } | null => {
  const row = offerings.find(
    (offering) =>
      offering.item_id === itemId &&
      offering.price_kind === "listed" &&
      offering.observation_id !== null &&
      offering.amount !== null &&
      offering.currency !== null &&
      isAmount(offering.amount) &&
      isCurrency(offering.currency),
  );

  if (row === undefined || row.amount === null || row.currency === null) return null;

  return { amount: row.amount, currency: row.currency };
};

/** Up-to-three reviewed dish cards from selectMenuHighlights. Dish names
 *  come only from reviewed offerings; prices render only when a listed
 *  reviewed price exists for the item, otherwise the price-unknown copy.
 *  Never invents names, prices, or images. Tapping a card opens that menu
 *  item via onOpenMenuItem (the coordinator scrolls the menu to it). */
export function MenuHighlights({
  highlights,
  lang,
  locale,
  offerings,
  onOpenMenuItem,
  priceUnknown,
  rates,
  scanLabel = "Scan a menu",
  title = "Menu highlights",
  emptyHeading = "No reviewed menu available yet",
  venueId,
  returnVenue,
  returnView = "menu",
}: {
  readonly highlights: ReadonlyArray<MenuHighlight>;
  readonly lang: Locale;
  readonly locale: string;
  readonly offerings: ReadonlyArray<MenuOffering>;
  readonly onOpenMenuItem: (itemId: string) => void;
  readonly priceUnknown: string;
  readonly rates?: ReadonlyMap<string, ExchangeRate> | undefined;
  readonly scanLabel?: string | undefined;
  readonly title?: string | undefined;
  readonly emptyHeading?: string | undefined;
  readonly venueId: string;
  readonly returnVenue?: string | undefined;
  readonly returnView?: "overview" | "menu" | "reviews" | undefined;
}) {
  const capped = highlights.slice(0, HIGHLIGHT_CAP);

  if (capped.length === 0) {
    return (
      <section className="venue-highlights" aria-labelledby="venue-highlights-title">
        <h2 id="venue-highlights-title">{title}</h2>
        <output className="venue-empty">
          <BookOpen aria-hidden="true" />
          <p>{emptyHeading}</p>
          <Link
            className="venue-action"
            to="/scan"
            search={{ lang, venueId, returnVenue, returnView }}
          >
            {scanLabel}
          </Link>
        </output>
      </section>
    );
  }

  return (
    <section className="venue-highlights" aria-labelledby="venue-highlights-title">
      <h2 id="venue-highlights-title">{title}</h2>
      <ul className="venue-highlight-list">
        {capped.map((highlight) => {
          const price = listedPriceOf(offerings, highlight.id);

          return (
            <li key={highlight.id}>
              <button
                type="button"
                className="venue-highlight-card"
                onClick={() => onOpenMenuItem(highlight.id)}
              >
                <span className="venue-highlight-name">{highlight.name}</span>
                {price !== null ? (
                  <ObservedPrice
                    amount={price.amount}
                    currency={price.currency}
                    locale={locale}
                    rate={rates?.get(price.currency)}
                  />
                ) : (
                  <span className="venue-price-na">{priceUnknown}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
