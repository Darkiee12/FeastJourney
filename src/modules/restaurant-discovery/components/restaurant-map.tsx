import { ChevronDown } from "lucide-react";
import * as maplibre from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef, useState } from "react";
import Map, { Marker, NavigationControl } from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";
import { z } from "zod";

import {
  isPinSelected,
  RestaurantPinButton,
} from "@/modules/restaurant-discovery/components/restaurant-pins";
import {
  prefersReducedMotion,
  type UserPosition,
} from "@/modules/restaurant-discovery/location-storage";
import {
  DEFAULT_MAP_CENTER,
  type MapCenter,
  normalizedMapBounds,
} from "@/modules/restaurant-discovery/map-bounds";
import type {
  DishRestaurantResult,
  RestaurantResult,
} from "@/modules/restaurant-discovery/server/index";
import type { Locale } from "@/shared/i18n";

/** Backward-compatible re-export: UserPosition is defined once in
 *  location-storage; the map only consumes it. */
export type { UserPosition };

export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Explicit camera framing requested by the parent (city apply, recenter).
 *  Consumed once per key; user gestures always win afterwards. */
export interface FrameRequest {
  readonly key: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly zoom: number;
}

export interface SelectionPadding {
  /** Pixels to keep clear on the left (floating drawer). */
  readonly leftPx?: number;
  /** Fraction of map height to keep clear at the bottom (sheet). */
  readonly bottomRatio?: number;
}

export interface ReportedCamera {
  readonly longitude: number;
  readonly latitude: number;
  readonly zoom: number;
}

const FALLBACK_COPY_EN = {
  missing:
    "Map tiles are not configured here (VITE_MAP_STYLE_URL is unset). The list, addresses, and directions still work.",
  failed: "The map could not load. The list and directions remain available.",
  empty: "No restaurant locations in view. Pan the map, or pick a city to start.",
  userLocation: "Your location",
  searchWider: "Search a wider area",
  widening: "Searching a wider area…",
};

/** Warm production basemap palette (decorative paint overrides only).
 *  Applied on top of VITE_MAP_STYLE_URL without replacing the provider
 *  style: cream land, soft-blue water, light-green parks, muted arterials.
 *  Only eligible app records get interactive pins; basemap labels are
 *  never converted into pins. Pins stay brand red, user dot stays blue. */
export const WARM_BASEMAP = {
  land: "#FAF6EC",
  water: "#BFDDF0",
  park: "#D8EACD",
  building: "#EFE7D8",
  roadMajor: "#EFCF96",
  roadMinor: "#FFFFFF",
  labelHalo: "#FFFFFF",
} as const;

/** One decorative paint override from the closed warm palette. Keys are the
 *  only paint properties this pass ever touches; values are plain style-spec
 *  JSON (colors, halo width), so no parsing or assertion is needed at the
 *  provider boundary. */
export interface WarmPaintEntry {
  readonly name:
    | "background-color"
    | "fill-color"
    | "line-color"
    | "text-halo-color"
    | "text-halo-width";
  readonly value: string | number;
}

/** Decorative paint for one style layer, matched by layer id pattern.
 *  Returns null when the layer keeps the provider default. Pure and
 *  unit-testable; the caller guards every setPaintProperty. */
export function warmLayerPaint(
  layerId: string,
  layerType: string,
): ReadonlyArray<WarmPaintEntry> | null {
  const id = layerId.toLowerCase();

  if (layerType === "background") {
    return [{ name: "background-color", value: WARM_BASEMAP.land }];
  }

  if (/water|ocean|river|lake|bay|harbour|harbor|canal/.test(id)) {
    return [{ name: "fill-color", value: WARM_BASEMAP.water }];
  }

  if (/park|green|forest|wood|grass|garden|pitch|playground|golf|nature/.test(id)) {
    return [{ name: "fill-color", value: WARM_BASEMAP.park }];
  }

  if (/building|built/.test(id)) {
    return [{ name: "fill-color", value: WARM_BASEMAP.building }];
  }

  if (/^land|landuse|landcover|earth/.test(id)) {
    return [{ name: "fill-color", value: WARM_BASEMAP.land }];
  }

  if (/motorway|trunk|primary|arterial/.test(id)) {
    if (layerType === "line") return [{ name: "line-color", value: WARM_BASEMAP.roadMajor }];

    return null;
  }

  if (/road|street|secondary|tertiary|minor|path|footway/.test(id)) {
    if (layerType === "line") return [{ name: "line-color", value: WARM_BASEMAP.roadMinor }];

    return null;
  }

  if (layerType === "symbol") {
    return [
      { name: "text-halo-color", value: WARM_BASEMAP.labelHalo },
      { name: "text-halo-width", value: 1 },
    ];
  }

  return null;
}

/** Best-effort warm pass over the loaded provider style. Decorative
 *  only: unsupported layers are skipped and a failed pass never breaks
 *  the map, attribution, or controls. Re-run after each style load. */
export function applyWarmBasemap(map: maplibre.Map): void {
  try {
    const layers = map.getStyle().layers;

    for (const layer of layers) {
      const paint = warmLayerPaint(layer.id, layer.type);

      if (paint === null) continue;

      for (const entry of paint) {
        try {
          map.setPaintProperty(layer.id, entry.name, entry.value);
        } catch {
          // Layer does not support this paint key; keep provider default.
        }
      }
    }
  } catch {
    // Decorative only: the provider style remains fully usable.
  }
}

/** Radius steps (meters) offered by the existing radius control in
 *  restaurant-filters-sheet.tsx (RADII). Mirrored here so the map-empty
 *  overlay and search-wider stepping use the same scale without owning
 *  the schema: every value stays inside restaurant.schema.ts
 *  (100..50000, default 5000). If the sheet list changes, update this
 *  tuple in the same pass — the coordinator owns the sheet. */
export const SUPPORTED_RADII = [1000, 5000, 10000, 25000, 50000] as const;

export type SupportedRadius = (typeof SUPPORTED_RADII)[number];

/** Next wider radius step for a point+radius search, or null when the
 *  current radius already covers the widest supported step. Pure and
 *  unit-testable; the caller preserves dish identity and keeps the map
 *  mounted while navigating. */
export function nextSupportedRadius(radiusMeters: number): SupportedRadius | null {
  if (!Number.isFinite(radiusMeters)) return SUPPORTED_RADII[0];

  for (const step of SUPPORTED_RADII) {
    if (step > radiusMeters) return step;
  }

  return null;
}

/** Bounds widening for viewport (bounds-constrained) searches: scales the
 *  span around its center by `factor` (default doubles it). Antimeridian
 *  crossings unwrap before scaling; latitude clamps to [-90, 90] and
 *  longitudes normalize via normalizedMapBounds. Pure and unit-testable. */
export function expandedMapBounds(bounds: MapBounds, factor = 2): MapBounds {
  const safeFactor = Number.isFinite(factor) && factor > 1 ? factor : 2;
  const crosses = bounds.east < bounds.west;
  const east = crosses ? bounds.east + 360 : bounds.east;
  const centerLng = (bounds.west + east) / 2;
  const centerLat = (bounds.south + bounds.north) / 2;
  const halfLng = ((east - bounds.west) / 2) * safeFactor;
  const halfLat = ((bounds.north - bounds.south) / 2) * safeFactor;

  if (halfLng * 2 >= 360) {
    return {
      west: -180,
      south: Math.max(-90, centerLat - halfLat),
      east: 180,
      north: Math.min(90, centerLat + halfLat),
    };
  }

  return normalizedMapBounds(
    centerLng - halfLng,
    centerLat - halfLat,
    centerLng + halfLng,
    centerLat + halfLat,
  );
}

function fallbackCopy(lang: Locale) {
  if (lang === "vi") {
    return {
      missing:
        "Chưa cấu hình ô bản đồ ở đây (VITE_MAP_STYLE_URL trống). Danh sách, địa chỉ và chỉ đường vẫn dùng được.",
      failed: "Không tải được bản đồ. Danh sách và chỉ đường vẫn dùng được.",
      empty: "Chưa có vị trí nhà hàng trong tầm nhìn. Kéo bản đồ, hoặc chọn thành phố để bắt đầu.",
      userLocation: "Vị trí của bạn",
      searchWider: "Tìm khu vực rộng hơn",
      widening: "Đang tìm khu vực rộng hơn…",
    };
  }

  return FALLBACK_COPY_EN;
}

function selectionPaddingPx(
  map: maplibre.Map,
  padding: SelectionPadding | undefined,
): maplibre.PaddingOptions {
  const height = map.getContainer().clientHeight || 0;

  return {
    top: 16,
    left: padding?.leftPx ?? 16,
    bottom: Math.round(height * (padding?.bottomRatio ?? 0)) + 16,
    right: 16,
  };
}

export default function RestaurantMap({
  points,
  selected,
  onSelect,
  onBounds,
  onCamera,
  lang,
  center,
  emptyNote,
  emptyTitle,
  frame,
  selectionPadding,
  userPosition,
  fitKey,
  suppressInitialFit,
  onSearchWider,
  searchWiderLabel,
  searchWiderBusy,
  radiusLabel,
  onOpenRadius,
}: {
  points: ReadonlyArray<RestaurantResult | DishRestaurantResult>;
  selected: string | null;
  onSelect: (id: string) => void;
  onBounds?: (bounds: MapBounds) => void;
  onCamera?: (camera: ReportedCamera) => void;
  lang: Locale;
  center?: MapCenter;
  emptyNote?: string;
  emptyTitle?: string;
  frame?: FrameRequest | null;
  selectionPadding?: SelectionPadding;
  userPosition?: UserPosition | null;
  fitKey?: string;
  suppressInitialFit?: boolean;
  /** Empty-overlay "search wider" action. Rendered only when the handler
   *  is provided (and only while no pins are shown). The parent owns the
   *  navigation: it must preserve dish identity, step radius via
   *  nextSupportedRadius for point+radius searches or widen bounds via
   *  expandedMapBounds for viewport searches, and keep this map mounted. */
  onSearchWider?: () => void;
  /** Accessible label for the widen action; falls back to honest map copy. */
  searchWiderLabel?: string;
  /** Truthful busy state while the wider search navigates; the map stays
   *  mounted and interactive underneath. */
  searchWiderBusy?: boolean;
  /** Radius chip label (e.g. "Within 5 km"). Rendered only together with
   *  onOpenRadius, with a ⌄ affordance — never a disposable X. */
  radiusLabel?: string;
  /** Opens the existing radius options (the filters sheet). The parent
   *  wires this to the same control that edits radius/bounds. */
  onOpenRadius?: () => void;
}) {
  const ref = useRef<MapRef>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const userMoved = useRef(false);
  const reducedMotion = useRef(false);
  const style = z.url().safeParse(import.meta.env.VITE_MAP_STYLE_URL);
  const copy = fallbackCopy(lang);
  const chosen = points.find((point) => point.id === selected);
  const fittedKey = useRef<string>("");
  const framedKey = useRef<string>("");
  const first = points[0];

  useEffect(() => {
    reducedMotion.current = prefersReducedMotion();
  }, []);

  /** Explicit caller center wins; otherwise frame the first point;
   *  with no points and no center, use the labeled default region. */
  const initialCenter: MapCenter =
    center ??
    (first === undefined
      ? DEFAULT_MAP_CENTER
      : { longitude: first.longitude, latitude: first.latitude, zoom: 13 });

  const moveCamera = (
    map: maplibre.Map,
    target: { longitude: number; latitude: number },
    zoom: number,
  ) => {
    // SAFETY: center is always a validated [longitude, latitude] pair from
    // map state, URL search params, or curated city presets.
    const options = {
      center: [target.longitude, target.latitude] as [number, number],
      zoom,
      padding: selectionPaddingPx(map, selectionPadding),
    };

    if (reducedMotion.current) {
      map.jumpTo(options);
    } else {
      map.easeTo({ ...options, duration: 300 });
    }
  };

  useEffect(() => {
    if (chosen !== undefined && ref.current !== null) {
      const map = ref.current.getMap();
      const zoom = Math.min(Math.max(map.getZoom(), 15), 17);

      moveCamera(map, chosen, zoom);
    }
    // Selection padding is read at focus time; the padding key re-runs the
    // effect when the sheet/drawer geometry changes so the selected marker
    // is never left hidden behind the sheet or drawer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen, selectionPadding?.leftPx, selectionPadding?.bottomRatio]);

  useEffect(() => {
    if (frame === null || frame === undefined || ref.current === null || !ready) return;

    if (frame.key === framedKey.current) return;

    framedKey.current = frame.key;

    userMoved.current = false;
    moveCamera(ref.current.getMap(), frame, frame.zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, ready]);

  useEffect(() => {
    if (points.length === 0 || ref.current === null || selected !== null) return;

    if (!ready || userMoved.current) return;

    const key = `${fitKey ?? ""}|${points.map((point) => point.id).join("|")}`;

    if (key === fittedKey.current) return;

    if (suppressInitialFit === true && fittedKey.current === "") {
      fittedKey.current = key;

      return;
    }

    fittedKey.current = key;
    const map = ref.current.getMap();

    if (points.length === 1) {
      const only = points[0];

      if (only !== undefined) moveCamera(map, only, 13);

      return;
    }

    const bounds = new maplibre.LngLatBounds();

    for (const point of points) bounds.extend([point.longitude, point.latitude]);

    if (reducedMotion.current) {
      map.fitBounds(bounds, {
        padding: selectionPaddingPx(map, selectionPadding),
        maxZoom: 13,
        duration: 0,
      });
    } else {
      map.fitBounds(bounds, {
        padding: selectionPaddingPx(map, selectionPadding),
        maxZoom: 13,
        duration: 300,
      });
    }
    // Fit follows the result set, not the camera: a new fitKey means a new
    // search worth framing; user gestures always win afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, selected, ready, fitKey]);

  if (!style.success) {
    return (
      <div className="discovery-map-fallback" aria-live="polite">
        {copy.missing}
      </div>
    );
  }

  if (failed) {
    return (
      <div className="discovery-map-fallback" aria-live="polite">
        {copy.failed}
      </div>
    );
  }

  return (
    <div className="discovery-map" aria-label="Restaurant locations">
      <Map
        ref={ref}
        mapLib={maplibre}
        workerUrl={workerUrl}
        mapStyle={style.data}
        initialViewState={{
          longitude: initialCenter.longitude,
          latitude: initialCenter.latitude,
          zoom: initialCenter.zoom,
        }}
        // Fullscreen map owns the viewport (shell pins 100dvh, no document
        // scroll): one-finger pan stays enabled so touch users can drag the
        // map. cooperativeGestures would force two-finger pan plus a
        // "use ctrl + scroll to zoom" overlay, which only makes sense for an
        // inline map embedded in a scrolling page. Desktop trackpad scroll
        // zooms directly; the list, addresses, and directions remain usable
        // when tiles fail.
        attributionControl={{ compact: true }}
        onLoad={() => {
          // Warm the provider style without replacing it; attribution,
          // pan/zoom, and list/sheet interactions are untouched. The map
          // instance comes from the component ref, so no event assertion.
          const map = ref.current?.getMap();

          if (map !== undefined) {
            applyWarmBasemap(map);
          }

          setReady(true);
        }}
        onError={() => setFailed(true)}
        onMoveEnd={(event) => {
          const target = event.target;

          if (onCamera !== undefined) {
            const view = target.getCenter();

            onCamera({
              longitude: view.lng,
              latitude: view.lat,
              zoom: target.getZoom(),
            });
          }

          if (event.originalEvent === undefined) return;

          userMoved.current = true;

          if (onBounds === undefined) return;
          const bounds = target.getBounds();

          onBounds(
            normalizedMapBounds(
              bounds.getWest(),
              bounds.getSouth(),
              bounds.getEast(),
              bounds.getNorth(),
            ),
          );
        }}
      >
        <NavigationControl position="top-right" />
        {userPosition !== null && userPosition !== undefined && (
          <Marker longitude={userPosition.longitude} latitude={userPosition.latitude}>
            <svg
              className="user-dot-svg"
              viewBox="0 0 20 20"
              width="20"
              height="20"
              aria-hidden="true"
              focusable="false"
            >
              <circle cx="10" cy="10" r="6" fill="currentColor" stroke="white" strokeWidth="3" />
            </svg>
            <span className="sr-only">
              {userPosition.accuracyMeters === null
                ? copy.userLocation
                : `${copy.userLocation} (±${userPosition.accuracyMeters} m)`}
            </span>
          </Marker>
        )}
        {points.map((point) => (
          <Marker
            key={point.id}
            longitude={point.longitude}
            latitude={point.latitude}
            anchor="bottom"
          >
            <RestaurantPinButton
              name={point.name}
              selected={isPinSelected(point.id, selected)}
              onSelect={() => onSelect(point.id)}
            />
          </Marker>
        ))}
      </Map>
      {points.length === 0 && (
        <div className="discovery-map-empty" aria-live="polite">
          {emptyTitle !== undefined && emptyTitle !== "" ? (
            <strong className="discovery-map-empty-title">{emptyTitle}</strong>
          ) : null}
          <p>{emptyNote ?? copy.empty}</p>
          {onSearchWider !== undefined || onOpenRadius !== undefined ? (
            <div className="discovery-map-empty-actions">
              {onSearchWider !== undefined ? (
                <button
                  type="button"
                  className="mapapp-primary-btn"
                  onClick={onSearchWider}
                  disabled={searchWiderBusy === true}
                  aria-busy={searchWiderBusy === true}
                >
                  {searchWiderBusy === true
                    ? copy.widening
                    : (searchWiderLabel ?? copy.searchWider)}
                </button>
              ) : null}
              {radiusLabel !== undefined && onOpenRadius !== undefined ? (
                <button
                  type="button"
                  className="mapapp-chip-btn"
                  onClick={onOpenRadius}
                  aria-haspopup="dialog"
                >
                  <span className="mapapp-chip-label">{radiusLabel}</span>
                  <ChevronDown aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
