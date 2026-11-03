import { LoaderCircle, MapPin } from "lucide-react";
import { useState, type ReactNode } from "react";

import { coverageCityFor } from "@/modules/muse-copilot/flows/find-location";
import { FindVenueResults as FindVenueResultsSection } from "@/modules/muse-copilot/flows/find-venue-results";
import { KNOWN_CITIES, type WorkspacePanelApi } from "@/modules/muse-copilot/flows/task-panel";
import {
  requestUserPosition,
  writeStoredPlace,
} from "@/modules/restaurant-discovery/location-storage";

const fillCity = (template: string, city: string): string => template.replace("{city}", city);

const localCopy = {
  en: {
    outsideCoverage:
      "That location looks far from our covered cities — choose one below to browse.",
  },
  vi: {
    outsideCoverage:
      "Vị trí này nằm ngoài các thành phố hiện hỗ trợ — hãy chọn một thành phố bên dưới.",
  },
} as const;

/**
 * Find Nearby location entry plus first-party venue search (plan §32).
 * Explicit user choice first: curated city chips, the previously stored
 * city, or a user-triggered geolocation fix gated by coverage — a fix far
 * from every covered city explains itself instead of adopting a wrong one.
 * Raw coordinates never enter Muse context: only city/country names ride
 * the request, and geolocation never fires without the visitor tapping it.
 * Once a city is known the panel runs a canonical dish + geography venue
 * search below (never skipped on dish match); web research stays an
 * explicit opt-in inside the results section.
 */
export function FindPanel({
  context,
  copy,
  onUpdateContext,
  selectTask,
}: WorkspacePanelApi): ReactNode {
  const strings = context.language === "vi" ? localCopy.vi : localCopy.en;
  const city = context.city?.trim() === "" ? undefined : context.city;
  const country = context.country?.trim() === "" ? undefined : context.country;
  const [choosing, setChoosing] = useState(city === undefined);
  const [locating, setLocating] = useState(false);
  const [denied, setDenied] = useState(false);
  const [outside, setOutside] = useState(false);

  const choose = (nextCity: string, nextCountry: string, presetId: string | null): void => {
    onUpdateContext({ city: nextCity, country: nextCountry });
    setChoosing(false);
    setDenied(false);
    setOutside(false);

    if (presetId !== null) {
      writeStoredPlace({ kind: "city", id: presetId });
    }
  };

  const useMyLocation = (): void => {
    setLocating(true);
    setDenied(false);
    setOutside(false);

    void requestUserPosition()
      .then((position) => {
        const covered = coverageCityFor(position.longitude, position.latitude);

        if (covered === null) {
          setOutside(true);

          return;
        }

        choose(covered.city, covered.country, covered.id);
      })
      .catch(() => {
        setDenied(true);
      })
      .finally(() => {
        setLocating(false);
      });
  };

  return (
    <div className="flex flex-col gap-3">
      {city !== undefined && !choosing ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border-soft bg-white px-3.5 text-xs font-bold text-ink shadow-[0_4px_12px_rgba(3,10,30,0.08)]">
            <MapPin aria-hidden="true" className="size-3.5 text-food-orange-strong" />
            {fillCity(copy.locationExplore, city)}
          </p>

          <button
            type="button"
            onClick={() => {
              setChoosing(true);
            }}
            className="inline-flex min-h-9 cursor-pointer items-center rounded-full border border-border-soft bg-white px-3.5 text-xs font-bold text-muted transition hover:border-food-orange-strong hover:text-ink"
          >
            {copy.changeCity}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-2xl border border-border-soft bg-white px-4 py-3 shadow-[0_8px_20px_rgba(3,10,30,0.08)]">
          <p className="text-sm font-semibold text-ink">{copy.locationPrompt}</p>

          <ul className="flex flex-wrap gap-2" aria-label={copy.locationChoose}>
            {KNOWN_CITIES.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => {
                    choose(entry.city, entry.country, entry.id);
                  }}
                  className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border border-border-soft bg-white px-3.5 text-xs font-bold text-ink transition hover:border-food-orange-strong"
                >
                  <MapPin aria-hidden="true" className="size-3.5 text-food-orange-strong" />
                  {entry.city}
                </button>
              </li>
            ))}

            <li>
              <button
                type="button"
                onClick={useMyLocation}
                disabled={locating}
                className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border border-border-soft bg-white px-3.5 text-xs font-bold text-ink transition hover:border-food-orange-strong disabled:cursor-not-allowed disabled:opacity-50"
              >
                {locating ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                  />
                ) : (
                  <MapPin aria-hidden="true" className="size-3.5 text-food-orange-strong" />
                )}
                {locating ? copy.locationLocating : copy.locationUseMine}
              </button>
            </li>
          </ul>

          {denied ? (
            <p className="text-xs leading-relaxed text-muted">{copy.locationDenied}</p>
          ) : null}

          {outside ? (
            <output className="block text-xs leading-relaxed text-muted">
              {strings.outsideCoverage}
            </output>
          ) : null}
        </div>
      )}

      {city !== undefined && country !== undefined ? (
        <div className="rounded-2xl border border-border-soft bg-white px-4 py-3 shadow-[0_8px_20px_rgba(3,10,30,0.08)]">
          <FindVenueResultsSection
            key={`${city}|${country}|${context.dishId ?? ""}`}
            city={city}
            country={country}
            dishId={context.dishId}
            language={context.language}
            exploreLabel={fillCity(copy.locationExplore, city)}
            onUpdateContext={onUpdateContext}
            onChooseLocation={() => {
              setChoosing(true);
            }}
            onAskInstead={() => {
              selectTask("ask");
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

export default FindPanel;
