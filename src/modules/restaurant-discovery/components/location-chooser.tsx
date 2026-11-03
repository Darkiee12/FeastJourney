import { Loader2, MapPin, Navigation, X } from "lucide-react";

import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import { CITY_PRESETS } from "@/modules/restaurant-discovery/map-bounds";

/** Compact location chooser. Shown when no browsing region is established;
 *  reopenable anytime via the search location button. */
export function LocationChooser({
  copy,
  locating,
  dismissible,
  onPickCity,
  onUseLocation,
  onDismiss,
}: {
  copy: RestaurantCopy;
  locating: boolean;
  dismissible: boolean;
  onPickCity: (id: string) => void;
  onUseLocation: () => void;
  onDismiss: () => void;
}) {
  const cityLabel = (id: string): string => {
    if (id === "hcmc") return copy.browseCityHcmc;

    if (id === "hanoi") return copy.browseCityHanoi;

    if (id === "bangalore") return "Bengaluru (Bangalore)";

    return id;
  };

  return (
    <section aria-labelledby="mapapp-chooser-title" className="mapapp-chooser">
      <div className="mapapp-chooser-head">
        <h2 id="mapapp-chooser-title">{copy.chooserTitle}</h2>
        {dismissible && (
          <button
            type="button"
            className="mapapp-iconbtn"
            onClick={onDismiss}
            aria-label={copy.chooserDismiss}
          >
            <X aria-hidden="true" />
          </button>
        )}
      </div>
      <p>{copy.chooserBody}</p>
      <div className="mapapp-chooser-actions">
        {CITY_PRESETS.map((city) => (
          <button
            key={city.id}
            type="button"
            className="mapapp-chip-btn"
            onClick={() => onPickCity(city.id)}
          >
            <MapPin aria-hidden="true" />
            {cityLabel(city.id)}
          </button>
        ))}
        <button
          type="button"
          className="mapapp-primary-btn"
          onClick={onUseLocation}
          disabled={locating}
        >
          {locating ? (
            <Loader2 aria-hidden="true" className="mapapp-spin" />
          ) : (
            <Navigation aria-hidden="true" />
          )}
          {locating ? copy.locating : copy.useMyLocation}
        </button>
      </div>
    </section>
  );
}
