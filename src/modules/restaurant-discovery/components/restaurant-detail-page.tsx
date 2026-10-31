import { Link, getRouteApi, useRouter } from "@tanstack/react-router";

import {
  CurrencySelector,
  useExchangeRates,
  usePreferredCurrency,
} from "@/modules/restaurant-discovery/components/currency-tools";
import { InteractiveMenuView } from "@/modules/restaurant-discovery/components/interactive-menu";
import { RestaurantMapPanel } from "@/modules/restaurant-discovery/components/restaurant-map-panel";
import { photoLoaderSchema } from "@/modules/restaurant-discovery/components/restaurant-photos";
import { RestaurantPhotoGallery } from "@/modules/restaurant-discovery/components/restaurant-photos-gallery";
import { presentReviewed } from "@/modules/restaurant-discovery/menu-presentation";
import { channelSchema } from "@/modules/restaurant-discovery/restaurant.schema";
import type { Locale } from "@/shared/i18n";

const route = getRouteApi("/restaurants/$venueId");

/** Back prefers router history so the map page restores its exact camera;
 *  only a direct load falls back to a fresh results search. */
function BackToResults({ lang }: { readonly lang: Locale }) {
  const router = useRouter();
  const navigate = route.useNavigate();

  const goBack = (): void => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.history.back();

      return;
    }

    void navigate({ to: "/restaurants", search: { lang } });
  };

  return (
    <button type="button" onClick={goBack} className="discovery-back">
      ← Back to results
    </button>
  );
}

export function RestaurantDetailPage() {
  const { venue, offerings } = route.useLoaderData();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const preference = usePreferredCurrency();

  const conversion = useExchangeRates(
    offerings.flatMap((offering) => (offering.currency === null ? [] : [offering.currency])),
    preference.currency,
  );

  // Forward-compat: the detail loader gains a typed `photos` field when
  // photo delivery wires in (see phase report). Until then the payload
  // parses without photos and the gallery renders its branded empty state.
  const parsedVenue = photoLoaderSchema.safeParse(venue);
  const photos = parsedVenue.success ? (parsedVenue.data.photos ?? []) : [];

  return (
    <article className="discovery-page">
      <nav aria-label="Discover">
        <BackToResults lang={search.lang} />
        {search.fromDish !== undefined && (
          <Link
            to="/dishes/$dishId"
            params={{ dishId: search.fromDish }}
            search={{ lang: search.lang }}
          >
            ← Back to dish
          </Link>
        )}
        <Link to="/restaurants" search={{ lang: search.lang }}>
          Find restaurants
        </Link>
        <Link to="/dishes" search={{ lang: search.lang }}>
          Explore dishes
        </Link>
        <Link to="/scan" search={{ lang: search.lang, venueId: venue.id }}>
          Scan this menu
        </Link>
      </nav>
      <header>
        <p className="discovery-eyebrow">
          {venue.business_name} · {venue.area}
        </p>
        <h1>{venue.name}</h1>
        <p>{venue.address}</p>
        <a
          className="discovery-action"
          href={`https://www.google.com/maps/dir/?api=1&destination=${venue.latitude},${venue.longitude}`}
          target="_blank"
          rel="noreferrer"
        >
          Get directions ↗
        </a>
      </header>
      <section aria-labelledby="venue-photos-heading">
        <h2 id="venue-photos-heading">Photos</h2>
        <RestaurantPhotoGallery photos={photos} venueName={venue.name} />
      </section>
      <CurrencySelector preference={preference} />
      <div className="restaurant-detail-layout">
        <section aria-labelledby="menu-heading">
          <h2 id="menu-heading">Explore the menu</h2>
          <div className="my-4">
            <label htmlFor="menu-channel">Sales channel</label>
            <select
              id="menu-channel"
              value={search.channel}
              onChange={(event) => {
                const channel = channelSchema.parse(event.target.value);
                void navigate({ search: { ...search, channel } });
              }}
            >
              <option value="dine_in">Dine-in</option>
              <option value="takeaway">Takeaway</option>
              <option value="delivery">Delivery</option>
            </select>
          </div>
          <p className="mb-4 text-sm text-muted">
            These are reviewed observations, not live availability. Confirm current prices, taxes,
            service charges and dietary requirements with the venue.
          </p>
          {conversion.unavailable && (
            <p aria-live="polite">
              Approximate conversion is unavailable. Original menu prices remain available.
            </p>
          )}
          {offerings.length === 0 ? (
            <div className="discovery-empty" aria-live="polite">
              No curated menu offerings have been recorded for this branch yet.
            </div>
          ) : (
            <InteractiveMenuView
              key={`order:${venue.id}:${search.channel}`}
              menu={presentReviewed(offerings, venue.name, search.lang)}
              locale={search.lang}
              rates={conversion.rates}
              initialVariant={search.variant}
            />
          )}
        </section>
        <aside>
          <h2>Find this branch</h2>
          <RestaurantMapPanel
            points={[{ ...venue, distance_meters: null }]}
            selected={venue.id}
            onSelect={() => {}}
            lang={search.lang}
            center={{ longitude: venue.longitude, latitude: venue.latitude, zoom: 14 }}
          />
          <p className="mt-3 text-sm">{venue.address}</p>
        </aside>
      </div>
    </article>
  );
}
