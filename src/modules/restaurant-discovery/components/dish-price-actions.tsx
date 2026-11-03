import { Link } from "@tanstack/react-router";
import { BadgeDollarSign, UtensilsCrossed } from "lucide-react";

import type { RestaurantSearch } from "@/modules/restaurant-discovery/restaurant.schema";
import type { Locale } from "@/shared/i18n";

type Channel = RestaurantSearch["channel"];

interface DishPriceTargets {
  readonly restaurantsSearch: {
    readonly lang: Locale;
    readonly dish: string;
    readonly fromDish: string;
    readonly channel: Channel;
  };
  readonly compareSearch:
    | {
        readonly lang: Locale;
        readonly dish: string;
        readonly fromDish: string;
        readonly channel: Channel;
        readonly sort: "price_low";
        readonly portion: string;
        readonly currency: string;
      }
    | {
        readonly lang: Locale;
        readonly dish: string;
        readonly fromDish: string;
        readonly channel: Channel;
      };
}

/**
 * Pure target builder for the dish→restaurant entry actions (test seam).
 * The compare-prices target deep-links into server-side price sorting only
 * when a comparable portion and a comparison currency are already known;
 * otherwise it lands on the dish-filtered restaurant list without
 * inventing a sort, and the traveler picks serving size + currency in
 * filters.
 */
export function dishPriceTargets({
  dishId,
  fromDish,
  lang,
  channel,
  portion,
  currency,
}: {
  dishId: string;
  fromDish: string;
  lang: Locale;
  channel: Channel;
  portion?: string;
  currency?: string;
}): DishPriceTargets {
  const restaurantsSearch = { lang, dish: dishId, fromDish, channel } as const;

  if (portion !== undefined && currency !== undefined) {
    return {
      restaurantsSearch,
      compareSearch: { ...restaurantsSearch, sort: "price_low", portion, currency } as const,
    };
  }

  return { restaurantsSearch, compareSearch: restaurantsSearch };
}

/**
 * Compact dish→restaurant entry actions. Render ONLY when a canonical dish
 * is selected (dishId is required) — never globally.
 *
 * Single-trigger rule: this file owns navigation triggers only. Price
 * research has exactly one user-triggered entry point per screen — the
 * research section inside PriceComparePanel (compare view) or the per-dish
 * research action on scan results. Never add a research button here; that
 * would create competing triggers on the same screen.
 *
 * Mount point is owned by the dish page / results sheet owner; this file
 * only exposes the actions.
 */
export function DishPriceActions({
  dishId,
  dishSlug,
  lang,
  portion,
  currency,
  channel = "dine_in",
  restaurantsLabel = "Restaurants",
  compareLabel = "Compare prices",
}: {
  readonly dishId: string;
  readonly dishSlug: string;
  readonly lang: Locale;
  readonly portion?: string | undefined;
  readonly currency?: string | undefined;
  readonly channel?: Channel;
  readonly restaurantsLabel?: string | undefined;
  readonly compareLabel?: string | undefined;
}) {
  const targets = dishPriceTargets({
    dishId,
    fromDish: dishSlug,
    lang,
    channel,
    portion,
    currency,
  });

  return (
    <nav className="dish-price-actions" aria-label={compareLabel}>
      <Link className="dish-price-action" to="/restaurants" search={targets.restaurantsSearch}>
        <UtensilsCrossed aria-hidden="true" />
        {restaurantsLabel}
      </Link>
      <Link className="dish-price-action" to="/restaurants" search={targets.compareSearch}>
        <BadgeDollarSign aria-hidden="true" />
        {compareLabel}
      </Link>
    </nav>
  );
}
