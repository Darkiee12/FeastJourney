import { Link } from "@tanstack/react-router";
import { ArrowLeft, Star } from "lucide-react";

import { MenuHighlights } from "@/modules/restaurant-discovery/components/menu-highlights";
import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import type { PhotoRef } from "@/modules/restaurant-discovery/components/restaurant-photos";
import {
  RestaurantPhoto,
  RestaurantPhotoFallback,
} from "@/modules/restaurant-discovery/components/restaurant-photos-gallery";
import { VenueActionBar } from "@/modules/restaurant-discovery/components/venue-action-bar";
import type { MenuHighlight } from "@/modules/restaurant-discovery/menu-presentation";
import type { MenuOffering } from "@/modules/restaurant-discovery/server/operations/discovery";
import type { Locale } from "@/shared/i18n";
import type { ExchangeRate } from "@/shared/money";

export interface VenueOverviewIdentity {
  readonly id: string;
  readonly name: string;
  readonly businessName: string | null;
  readonly area: string;
  readonly address: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly distanceKm: string | null;
}

/** Layout-only loading placeholder for the venue overview. Shimmer
 *  blocks only; no invented name, price, photo, or rating content. */
export function VenueOverviewSkeleton({
  label,
  hint,
}: {
  readonly label: string;
  readonly hint?: string | undefined;
}) {
  return (
    <div
      className="mapapp-skel venue-overview"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
    >
      <p className="mapapp-note">{label}</p>
      {hint !== undefined && hint !== "" ? <p className="mapapp-note">{hint}</p> : null}
      <span className="mapapp-skel-line wide" aria-hidden="true" />
      <span className="mapapp-skel-line" aria-hidden="true" />
      <span className="mapapp-skel-line narrow" aria-hidden="true" />
    </div>
  );
}

/** Genuine aggregate only: published customer reviews. Null (or zero
 *  total) renders no rating row — never an invented score. */
export interface VenueRatingSummary {
  readonly total: number;
  readonly average: number;
}

/** Venue identity header: name, area/address, distance when known, and
 *  the genuine rating summary when available. No photos, hours, prices,
 *  or ratings are invented here. */
export function VenueOverview({
  copy,
  highlights,
  lang,
  locale,
  offerings,
  onBackToResults,
  backToResultsLabel = "Back to results",
  fromDish = null,
  onOpenMenuItem,
  onShowMenu,
  onShowReviews,
  photos,
  rates,
  reviewSummary,
  venue,
}: {
  readonly copy: RestaurantCopy;
  readonly highlights: ReadonlyArray<MenuHighlight>;
  readonly lang: Locale;
  readonly locale: string;
  readonly offerings: ReadonlyArray<MenuOffering>;
  readonly onBackToResults?: (() => void) | undefined;
  readonly backToResultsLabel?: string | undefined;
  readonly fromDish?: string | null | undefined;
  readonly onOpenMenuItem: (itemId: string) => void;
  readonly onShowMenu: () => void;
  readonly onShowReviews: () => void;
  readonly photos: ReadonlyArray<PhotoRef>;
  readonly rates?: ReadonlyMap<string, ExchangeRate> | undefined;
  readonly reviewSummary: VenueRatingSummary | null;
  readonly venue: VenueOverviewIdentity;
}) {
  const ordered = photos.toSorted((left, right) => Number(right.primary) - Number(left.primary));
  const directionsHref = `https://www.google.com/maps/dir/?api=1&destination=${venue.latitude},${venue.longitude}`;
  const genuine = reviewSummary !== null && reviewSummary.total > 0 ? reviewSummary : null;

  return (
    <article className="venue-overview gap-3" aria-label={venue.name}>
      <header className="venue-head">
        {onBackToResults !== undefined && (
          <button type="button" className="venue-back" onClick={onBackToResults}>
            <ArrowLeft aria-hidden="true" />
            {backToResultsLabel}
          </button>
        )}
        {fromDish !== null && fromDish !== "" && (
          <p className="venue-dish-link">
            <Link to="/dishes/$dishId" params={{ dishId: fromDish }} search={{ lang }}>
              ← {copy.backToDish}
            </Link>
          </p>
        )}
        <p className="venue-eyebrow">
          {venue.area}
          {venue.distanceKm !== null && ` · ${copy.kmAway.replace("{km}", venue.distanceKm)}`}
        </p>
        <h2 className="venue-title">{venue.name}</h2>
        {venue.businessName !== null && venue.businessName !== venue.name && (
          <p className="venue-business">{venue.businessName}</p>
        )}
        <p className="venue-addr">{venue.address}</p>
        {genuine !== null && (
          <p className="venue-rating">
            <Star aria-hidden="true" />
            <span
              aria-label={`${genuine.average.toFixed(1)} out of 5 from ${genuine.total} reviews`}
            >
              {genuine.average.toFixed(1)} ({genuine.total})
            </span>
          </p>
        )}
      </header>
      {ordered.length === 0 ? (
        <RestaurantPhotoFallback
          name={venue.name}
          className="venue-photo"
          label={copy.venuePhotoFallback.replace("{name}", venue.name)}
        />
      ) : (
        <ul className="venue-gallery" aria-label={`Photos of ${venue.name}`}>
          {ordered.map((photo) => (
            <li key={photo.assetId}>
              <RestaurantPhoto photo={photo} className="venue-photo" />
            </li>
          ))}
        </ul>
      )}
      <VenueActionBar
        lang={lang}
        venueId={venue.id}
        directionsHref={directionsHref}
        onShowMenu={onShowMenu}
        onShowReviews={onShowReviews}
        menuLabel={copy.viewMenu}
        reviewsLabel={copy.reviewsAction}
        scanLabel={copy.scanMenuAction}
        directionsLabel={copy.directionsAction}
        returnVenue={venue.id}
        returnView="overview"
      />
      <MenuHighlights
        highlights={highlights}
        lang={lang}
        locale={locale}
        offerings={offerings}
        onOpenMenuItem={onOpenMenuItem}
        priceUnknown={copy.priceUnknown}
        rates={rates}
        venueId={venue.id}
        title={copy.highlightsTitle}
        emptyHeading={copy.highlightsEmpty}
        scanLabel={copy.scanMenuAction}
        returnVenue={venue.id}
      />
    </article>
  );
}
