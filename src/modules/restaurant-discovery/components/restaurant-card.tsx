import { ArrowRight, MapPin } from "lucide-react";
import type { ReactElement } from "react";

import { ObservedPrice } from "@/modules/restaurant-discovery/components/currency-tools";
import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import type { PhotoRef } from "@/modules/restaurant-discovery/components/restaurant-photos";
import { RestaurantPhoto } from "@/modules/restaurant-discovery/components/restaurant-photos-gallery";
import type { RestaurantSearch } from "@/modules/restaurant-discovery/restaurant.schema";
import type { Locale } from "@/shared/i18n";
import type { ExchangeRate } from "@/shared/money";

export interface RestaurantCardDish {
  readonly itemName: string;
  readonly variantName: string;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly matchKind: string;
  readonly evidenceDate: string;
  readonly stale: boolean;
  readonly channelLabel: string;
  readonly sourceCategory: string | null;
  readonly rate: ExchangeRate | undefined;
}

export interface RestaurantCardModel {
  readonly id: string;
  readonly name: string;
  readonly area: string;
  readonly address: string;
  readonly distanceKm: string | null;
  readonly dish: RestaurantCardDish | null;
  /** Published photos in display order. Absent until the search loader
   *  lands photo wiring; cards fall back to the branded initial tile. */
  readonly photos?: ReadonlyArray<PhotoRef> | undefined;
  readonly detailSearch: {
    readonly lang: Locale;
    readonly channel: RestaurantSearch["channel"];
    readonly variant: string | undefined;
    readonly dish: string | undefined;
    readonly fromDish: string | undefined;
  };
}

interface CardProps {
  readonly copy: RestaurantCopy;
  readonly model: RestaurantCardModel;
  readonly selected: boolean;
  readonly onShowOnMap: (() => void) | null;
  readonly onOpenVenue: () => void;
  readonly onViewMenu: () => void;
}

/** Number of accent palettes in restaurant-overhaul.css (`data-tint` 0..3). */
const VENUE_TINTS = 4;

/** Stable accent per venue name so a restaurant keeps its colour on the
 *  list card, the map and its overview panel; purely decorative. */
export function venueTint(name: string): number {
  let hash = 0;

  for (const char of name) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 9973;
  }

  return hash % VENUE_TINTS;
}

/** Layout-only loading placeholder for a result card. Shimmer blocks
 *  only; no price, evidence, or rating content is rendered here (price
 *  semantics stay with the card body and E-owned components). */
export function RestaurantCardSkeleton(): ReactElement {
  return (
    <article className="res-card" aria-hidden="true">
      <div className="res-card-body mapapp-skel" aria-hidden="true">
        <span className="mapapp-skel-line narrow" />
        <span className="mapapp-skel-line wide" />
        <span className="mapapp-skel-line" />
      </div>
    </article>
  );
}

/** One restaurant as a "food passport" card: area and name with the
 *  venue's accent stamp (photo when published), reviewed dish match with
 *  price, and a clear path to the menu.
 *  Names and menu actions open the in-map venue panel (no whole-page
 *  navigation); nothing here invents content. */
export function RestaurantCard({
  copy,
  model,
  selected,
  onShowOnMap,
  onOpenVenue,
  onViewMenu,
}: CardProps) {
  const photos = model.photos ?? [];
  const primary = photos.find((photo) => photo.primary) ?? photos[0];
  const initial = Array.from(model.name.trim())[0] ?? "";

  return (
    <article className="res-card" data-selected={selected} data-tint={venueTint(model.name)}>
      <div className="res-card-top">
        <div className="res-card-heading">
          <p className="res-card-meta">
            <span className="res-card-area">{model.area}</span>
            {model.distanceKm !== null && (
              <span className="res-card-distance">
                {copy.kmAway.replace("{km}", model.distanceKm)}
              </span>
            )}
          </p>
          <h3>
            <button type="button" className="res-name" onClick={onOpenVenue}>
              {model.name}
            </button>
          </h3>
        </div>
        {primary === undefined ? (
          <span className="res-stamp" aria-hidden="true">
            <span className="res-stamp-initial">{initial}</span>
          </span>
        ) : (
          <RestaurantPhoto photo={primary} className="res-stamp res-stamp-photo" />
        )}
      </div>
      {model.dish !== null && (
        <div className="res-match">
          <p className="res-match-dish">
            {model.dish.itemName} · {model.dish.variantName}
          </p>
          {model.dish.amount !== null && model.dish.currency !== null ? (
            <ObservedPrice
              amount={model.dish.amount}
              currency={model.dish.currency}
              locale={model.detailSearch.lang}
              rate={model.dish.rate}
            />
          ) : (
            <p className="res-price-na">{copy.priceUnknown}</p>
          )}
          <p className="res-match-meta">
            {model.dish.matchKind} · {model.dish.evidenceDate}
            {model.dish.stale && ` · ${copy.staleNote}`}
          </p>
          <p className="res-match-meta">
            {model.dish.channelLabel} · {model.dish.sourceCategory?.replaceAll("_", " ")}
          </p>
        </div>
      )}
      <div className="res-card-foot">
        <button type="button" className="res-view" onClick={onViewMenu}>
          {copy.viewMenu}
          <ArrowRight aria-hidden="true" />
        </button>
        {onShowOnMap !== null && (
          <button
            type="button"
            className="res-mapbtn"
            onClick={onShowOnMap}
            aria-label={copy.showOnMap}
            title={copy.showOnMap}
          >
            <MapPin aria-hidden="true" />
          </button>
        )}
      </div>
    </article>
  );
}
