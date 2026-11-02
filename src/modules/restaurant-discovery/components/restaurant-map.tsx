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
};

function fallbackCopy(lang: Locale) {
  if (lang === "vi") {
    return {
      missing:
        "Chưa cấu hình ô bản đồ ở đây (VITE_MAP_STYLE_URL trống). Danh sách, địa chỉ và chỉ đường vẫn dùng được.",
      failed: "Không tải được bản đồ. Danh sách và chỉ đường vẫn dùng được.",
      empty: "Chưa có vị trí nhà hàng trong tầm nhìn. Kéo bản đồ, hoặc chọn thành phố để bắt đầu.",
      userLocation: "Vị trí của bạn",
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
  frame,
  selectionPadding,
  userPosition,
  fitKey,
  suppressInitialFit,
}: {
  points: ReadonlyArray<RestaurantResult | DishRestaurantResult>;
  selected: string | null;
  onSelect: (id: string) => void;
  onBounds?: (bounds: MapBounds) => void;
  onCamera?: (camera: ReportedCamera) => void;
  lang: Locale;
  center?: MapCenter;
  emptyNote?: string;
  frame?: FrameRequest | null;
  selectionPadding?: SelectionPadding;
  userPosition?: UserPosition | null;
  fitKey?: string;
  suppressInitialFit?: boolean;
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
        onLoad={() => setReady(true)}
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
        <p className="discovery-map-empty" aria-live="polite">
          {emptyNote ?? copy.empty}
        </p>
      )}
    </div>
  );
}
