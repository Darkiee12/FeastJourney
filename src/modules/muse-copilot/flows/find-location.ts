import { KNOWN_CITIES, type KnownCity } from "@/modules/muse-copilot/flows/task-panel";
import { CITY_PRESETS } from "@/modules/restaurant-discovery/map-bounds";

/**
 * First-party geography for the Find panel (plan §32). A trusted city
 * resolves to curated map bounds when it matches a known preset; any other
 * city falls back to the server's `area` text filter so the panel never
 * invents coordinates and never defaults to an arbitrary city. Raw
 * geolocation coordinates never leave this module — only city/country names
 * ride a request.
 */
export interface FindGeography {
  readonly west: number | undefined;
  readonly south: number | undefined;
  readonly east: number | undefined;
  readonly north: number | undefined;
  /** Server area filter used when no curated bounds match. */
  readonly area: string;
  readonly presetId: string | null;
}

export function geographyFor(city: string, country: string): FindGeography {
  const known = KNOWN_CITIES.find((entry) => entry.city === city && entry.country === country);

  const preset =
    known === undefined ? undefined : CITY_PRESETS.find((entry) => entry.id === known.id);

  if (preset === undefined) {
    return {
      west: undefined,
      south: undefined,
      east: undefined,
      north: undefined,
      area: city,
      presetId: null,
    };
  }

  return {
    west: preset.west,
    south: preset.south,
    east: preset.east,
    north: preset.north,
    area: "",
    presetId: preset.id,
  };
}

const toRad = (degrees: number): number => (degrees * Math.PI) / 180;

/** Coverage radius (km) inside which a geolocation fix adopts a city. */
const COVERAGE_KM = 100;

const distanceKm = (lon1: number, lat1: number, lon2: number, lat2: number): number => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  return 2 * 6371 * Math.asin(Math.sqrt(a));
};

/**
 * Coverage-gated city for a user-triggered geolocation fix. Returns the
 * matching known city only when the fix falls inside curated bounds or
 * within coverage radius — never the nearest of three presets for a visitor
 * thousands of kilometers away. Null means outside coverage: the caller
 * must ask for an explicit city instead of assigning a wrong one.
 */
export function coverageCityFor(longitude: number, latitude: number): KnownCity | null {
  for (const preset of CITY_PRESETS) {
    if (
      longitude >= preset.west &&
      longitude <= preset.east &&
      latitude >= preset.south &&
      latitude <= preset.north
    ) {
      const known = KNOWN_CITIES.find((entry) => entry.id === preset.id);

      if (known !== undefined) {
        return known;
      }
    }
  }

  let best: KnownCity | null = null;
  let bestKm = COVERAGE_KM;

  for (const preset of CITY_PRESETS) {
    const distance = distanceKm(longitude, latitude, preset.longitude, preset.latitude);

    if (distance < bestKm) {
      const known = KNOWN_CITIES.find((entry) => entry.id === preset.id);

      if (known !== undefined) {
        best = known;
        bestKm = distance;
      }
    }
  }

  return best;
}
