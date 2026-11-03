import { z } from "zod";

import { CITY_PRESETS } from "@/modules/restaurant-discovery/map-bounds";

const STORAGE_KEY = "fj.browsing-place.v1";
const CAMERA_KEY = "fj.map-camera.v1";

const storedPlaceSchema = z.object({
  kind: z.literal("city"),
  id: z.string().refine((id) => CITY_PRESETS.some((city) => city.id === id), "Unknown city"),
});

export type StoredPlace = z.infer<typeof storedPlaceSchema>;

/** Durable browsing place chosen explicitly by the user. Never inferred. */
export function readStoredPlace(): StoredPlace | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    if (raw === null) return null;

    const parsed = storedPlaceSchema.safeParse(JSON.parse(raw));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeStoredPlace(place: StoredPlace): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(place));
  } catch {
    // Private mode or disabled storage: browsing still works for the session.
  }
}

const savedCameraSchema = z.object({
  searchKey: z.string().min(1),
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
  zoom: z.number().min(0).max(22),
});

export type SavedCamera = z.infer<typeof savedCameraSchema>;

export function readSavedCamera(searchKey: string): SavedCamera | null {
  try {
    const raw = window.sessionStorage.getItem(CAMERA_KEY);

    if (raw === null) return null;

    const parsed = savedCameraSchema.safeParse(JSON.parse(raw));

    if (!parsed.success || parsed.data.searchKey !== searchKey) return null;

    return parsed.data;
  } catch {
    return null;
  }
}

export function writeSavedCamera(camera: SavedCamera): void {
  try {
    window.sessionStorage.setItem(CAMERA_KEY, JSON.stringify(camera));
  } catch {
    // Session-only continuity is best-effort.
  }
}

export type GeolocationPermission = "granted" | "prompt" | "denied" | "unknown";

/** Permission state only — never triggers a browser prompt. */
export async function queryGeolocationPermission(): Promise<GeolocationPermission> {
  try {
    if (typeof navigator === "undefined" || !("permissions" in navigator)) {
      return "unknown";
    }

    const status = await navigator.permissions.query({ name: "geolocation" });
    const state: string = status.state;

    if (state === "granted" || state === "denied" || state === "prompt") {
      return state;
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

export interface UserPosition {
  readonly longitude: number;
  readonly latitude: number;
  readonly accuracyMeters: number | null;
}

/** Resolves only from an explicit user action (button click). */
export function requestUserPosition(timeoutMs = 10000): Promise<UserPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      reject(new Error("unavailable"));

      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          longitude: position.coords.longitude,
          latitude: position.coords.latitude,
          accuracyMeters:
            Number.isFinite(position.coords.accuracy) && position.coords.accuracy > 0
              ? Math.round(position.coords.accuracy)
              : null,
        });
      },
      () => {
        reject(new Error("denied"));
      },
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 60000 },
    );
  });
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
