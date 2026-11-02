import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, MapPin, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { ObservedPrice } from "@/modules/restaurant-discovery/components/currency-tools";
import type { RestaurantCardModel } from "@/modules/restaurant-discovery/components/restaurant-card";
import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import type { PhotoRef } from "@/modules/restaurant-discovery/components/restaurant-photos";
import {
  RestaurantPhoto,
  RestaurantPhotoFallback,
} from "@/modules/restaurant-discovery/components/restaurant-photos-gallery";
import type { Locale } from "@/shared/i18n";

function PhotoStrip({
  photos,
  venueName,
}: {
  readonly photos: ReadonlyArray<PhotoRef>;
  readonly venueName: string;
}) {
  if (photos.length === 0) {
    return <RestaurantPhotoFallback name={venueName} className="mapapp-preview-photo" />;
  }

  const ordered = photos.toSorted((left, right) => Number(right.primary) - Number(left.primary));

  return (
    <ul className="mapapp-preview-photos" aria-label="Venue photos">
      {ordered.map((photo) => (
        <li key={photo.assetId}>
          <RestaurantPhoto photo={photo} className="mapapp-preview-photo" />
        </li>
      ))}
    </ul>
  );
}

/** Compact restaurant preview inside the drawer or bottom sheet.
 *  Focus moves to the heading on open; closing returns focus to results.
 *  Photos come from the published set; venues without photos render the
 *  branded fallback — never fixtures or invented imagery. */
export function VenuePreview({
  copy,
  lang,
  model,
  onBack,
  onClose,
  onShowOnMap,
  photos,
}: {
  copy: RestaurantCopy;
  lang: Locale;
  model: RestaurantCardModel;
  onBack: () => void;
  onClose: () => void;
  onShowOnMap: () => void;
  photos?: ReadonlyArray<PhotoRef> | undefined;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <article className="mapapp-preview" aria-label={model.name}>
      <div className="mapapp-preview-nav">
        <button type="button" className="mapapp-preview-back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {copy.backToResults}
        </button>
        <button
          type="button"
          className="mapapp-preview-x"
          onClick={onClose}
          aria-label={copy.closePreview}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <p className="mapapp-preview-eyebrow">
        {model.area}
        {model.distanceKm !== null && ` · ${copy.kmAway.replace("{km}", model.distanceKm)}`}
      </p>
      <PhotoStrip photos={photos ?? model.photos ?? []} venueName={model.name} />
      <h3 ref={headingRef} tabIndex={-1} className="mapapp-preview-title">
        <Link to="/restaurants/$venueId" params={{ venueId: model.id }} search={model.detailSearch}>
          {model.name}
        </Link>
      </h3>
      <p className="mapapp-preview-addr">{model.address}</p>
      {model.dish !== null && (
        <div className="mapapp-preview-dish">
          <p className="mapapp-preview-dishname">
            {model.dish.itemName} · {model.dish.variantName}
          </p>
          {model.dish.amount !== null && model.dish.currency !== null ? (
            <ObservedPrice
              amount={model.dish.amount}
              currency={model.dish.currency}
              locale={lang}
              rate={model.dish.rate}
            />
          ) : (
            <p className="mapapp-preview-na">{copy.priceUnknown}</p>
          )}
          <p className="mapapp-preview-meta">
            {model.dish.matchKind} · {model.dish.evidenceDate}
            {model.dish.stale && ` · ${copy.staleNote}`}
          </p>
          <p className="mapapp-preview-meta">
            {model.dish.channelLabel} · {model.dish.sourceCategory?.replaceAll("_", " ")}
          </p>
        </div>
      )}
      <div className="mapapp-preview-actions">
        <Link
          className="mapapp-preview-view"
          to="/restaurants/$venueId"
          params={{ venueId: model.id }}
          search={model.detailSearch}
        >
          {copy.viewMenu}
          <ArrowRight aria-hidden="true" />
        </Link>
        <button type="button" className="mapapp-preview-mapbtn" onClick={onShowOnMap}>
          <MapPin aria-hidden="true" />
          {copy.showOnMap}
        </button>
      </div>
    </article>
  );
}
