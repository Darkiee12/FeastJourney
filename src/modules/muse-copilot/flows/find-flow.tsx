import { LoaderCircle, MapPin } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ResearchFallback } from "@/modules/muse-copilot/flows/conversation-feedback";
import {
  KNOWN_CITIES,
  nearestKnownCity,
  type WorkspacePanelApi,
} from "@/modules/muse-copilot/flows/task-panel";
import {
  requestUserPosition,
  writeStoredPlace,
} from "@/modules/restaurant-discovery/location-storage";
import { researchDishesFn } from "@/server/web-research/research-functions";

const fillCity = (template: string, city: string): string => template.replace("{city}", city);

/**
 * Find Nearby location entry (plan §14). Explicit user choice first:
 * curated city chips, the previously stored city, or a user-triggered
 * geolocation fix mapped client-side to the nearest curated city. Raw
 * coordinates never enter Muse context — only city/country names ride the
 * request. No silent defaults: without a city the panel asks, it never
 * invents one. Web research stays an explicit opt-in fallback.
 */
export function FindPanel({ context, copy, onUpdateContext }: WorkspacePanelApi): ReactNode {
  const city = context.city?.trim() === "" ? undefined : context.city;
  const [choosing, setChoosing] = useState(city === undefined);
  const [locating, setLocating] = useState(false);
  const [denied, setDenied] = useState(false);

  const choose = (nextCity: string, nextCountry: string, presetId: string | null): void => {
    onUpdateContext({ city: nextCity, country: nextCountry });
    setChoosing(false);
    setDenied(false);

    if (presetId !== null) {
      writeStoredPlace({ kind: "city", id: presetId });
    }
  };

  const useMyLocation = (): void => {
    setLocating(true);
    setDenied(false);

    void requestUserPosition()
      .then((position) => {
        const nearest = nearestKnownCity(position.longitude, position.latitude);

        choose(nearest.city, nearest.country, nearest.id);
      })
      .catch(() => {
        setDenied(true);
      })
      .finally(() => {
        setLocating(false);
      });
  };

  if (city !== undefined && !choosing) {
    return (
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
    );
  }

  const canResearch = city !== undefined && context.country !== undefined;

  return (
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

      {denied ? <p className="text-xs leading-relaxed text-muted">{copy.locationDenied}</p> : null}

      {canResearch ? (
        <ResearchFallback
          language={context.language}
          load={() =>
            researchDishesFn({
              data: {
                city: context.city ?? "",
                country: context.country ?? "",
                language: context.language,
              },
            })
          }
        />
      ) : null}
    </div>
  );
}

export default FindPanel;
