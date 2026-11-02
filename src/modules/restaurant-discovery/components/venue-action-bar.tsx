import { Link } from "@tanstack/react-router";
import { Navigation, ScanLine, Star, UtensilsCrossed } from "lucide-react";

import type { Locale } from "@/shared/i18n";

/** Compact action bar for the venue overview: Menu, Reviews, Scan,
 *  Directions. Icon + visible text label on every action; no icon-only
 *  buttons. There is deliberately no global Select-restaurant button —
 *  Use-this-restaurant lives only inside the /scan picker context, which
 *  is out of scope here and therefore omitted. */
export function VenueActionBar({
  lang,
  venueId,
  directionsHref,
  onShowMenu,
  onShowReviews,
  menuLabel = "View menu",
  reviewsLabel = "Reviews",
  scanLabel = "Scan a menu",
  directionsLabel = "Get directions",
}: {
  readonly lang: Locale;
  readonly venueId: string;
  readonly directionsHref: string;
  readonly onShowMenu: () => void;
  readonly onShowReviews: () => void;
  readonly menuLabel?: string | undefined;
  readonly reviewsLabel?: string | undefined;
  readonly scanLabel?: string | undefined;
  readonly directionsLabel?: string | undefined;
}) {
  // Compact icon+text pills: 2-column grid on narrow sheet/drawer widths,
  // wrapping row on wider screens. Utilities overlay the component-layer
  // .venue-actionbar (flex) without touching the shared stylesheet.
  return (
    <nav className="venue-actionbar grid grid-cols-2 sm:flex" aria-label="Venue actions">
      <button type="button" className="venue-action px-3.5" onClick={onShowMenu}>
        <UtensilsCrossed aria-hidden="true" />
        {menuLabel}
      </button>
      <button type="button" className="venue-action px-3.5" onClick={onShowReviews}>
        <Star aria-hidden="true" />
        {reviewsLabel}
      </button>
      <Link className="venue-action px-3.5" to="/scan" search={{ lang, venueId }}>
        <ScanLine aria-hidden="true" />
        {scanLabel}
      </Link>
      <a className="venue-action px-3.5" href={directionsHref} target="_blank" rel="noreferrer">
        <Navigation aria-hidden="true" />
        {directionsLabel}
      </a>
    </nav>
  );
}
