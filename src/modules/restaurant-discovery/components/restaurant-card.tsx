import { Link } from "@tanstack/react-router";
import { ArrowRight, MapPin } from "lucide-react";

import { ObservedPrice } from "@/modules/restaurant-discovery/components/currency-tools";
import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import type { PhotoRef } from "@/modules/restaurant-discovery/components/restaurant-photos";
import {
  RestaurantPhoto,
  RestaurantPhotoFallback,
} from "@/modules/restaurant-discovery/components/restaurant-photos-gallery";
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
}

/** One restaurant: photo, name, area, reviewed dish match with price,
 *  and a clear path to the menu. No invented content. */
export function RestaurantCard({ copy, model, selected, onShowOnMap }: CardProps) {
  const photos = model.photos ?? [];
  const primary = photos.find((photo) => photo.primary) ?? photos[0];

  return (
    <article className="res-card" data-selected={selected}>
      {primary === undefined ? (
        <RestaurantPhotoFallback name={model.name} className="res-photo" />
      ) : (
        <RestaurantPhoto photo={primary} className="res-photo" />
      )}
      <div className="res-card-body">
        <p className="res-card-eyebrow">
          {model.area}
          {model.distanceKm !== null && ` · ${copy.kmAway.replace("{km}", model.distanceKm)}`}
        </p>
        <h3>
          <Link
            to="/restaurants/$venueId"
            params={{ venueId: model.id }}
            search={model.detailSearch}
          >
            {model.name}
          </Link>
        </h3>
        <p className="res-card-addr">{model.address}</p>
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
          <Link
            className="res-view"
            to="/restaurants/$venueId"
            params={{ venueId: model.id }}
            search={model.detailSearch}
          >
            {copy.viewMenu}
            <ArrowRight aria-hidden="true" />
          </Link>
          {onShowOnMap !== null && (
            <button type="button" className="res-mapbtn" onClick={onShowOnMap}>
              <MapPin aria-hidden="true" />
              {copy.showOnMap}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
