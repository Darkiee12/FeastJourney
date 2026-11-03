/** MapLibre can report wrapped world coordinates; HTTP bounds use normalized longitudes. */
export function normalizedMapBounds(west: number, south: number, east: number, north: number) {
  if (east - west >= 360)
    return { west: -180, south: Math.max(-90, south), east: 180, north: Math.min(90, north) };

  return {
    west: ((((west + 180) % 360) + 360) % 360) - 180,
    south: Math.max(-90, south),
    east: ((((east + 180) % 360) + 360) % 360) - 180,
    north: Math.min(90, north),
  };
}

export interface MapCenter {
  readonly longitude: number;
  readonly latitude: number;
  readonly zoom: number;
}

/** Labeled default browsing region (Vietnam). Used only when the caller
 *  supplies no explicit center and there are no points to frame. Never 0,0. */
export const DEFAULT_MAP_CENTER: MapCenter = {
  longitude: 108.2772,
  latitude: 14.0583,
  zoom: 5,
};

export interface CityPreset {
  readonly id: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly zoom: number;
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/** Curated city browsing regions. Centers and viewports only — never
 *  restaurant data. Bounds drive PostGIS viewport search. */
export const CITY_PRESETS: ReadonlyArray<CityPreset> = [
  {
    id: "hcmc",
    longitude: 106.7009,
    latitude: 10.7769,
    zoom: 12,
    west: 106.4,
    south: 10.4,
    east: 107.0,
    north: 11.1,
  },
  {
    id: "hanoi",
    longitude: 105.8342,
    latitude: 21.0278,
    zoom: 12,
    west: 105.5,
    south: 20.8,
    east: 106.1,
    north: 21.3,
  },
  {
    id: "bangalore",
    longitude: 77.5946,
    latitude: 12.9716,
    zoom: 12,
    west: 77.45,
    south: 12.82,
    east: 77.78,
    north: 13.15,
  },
];
