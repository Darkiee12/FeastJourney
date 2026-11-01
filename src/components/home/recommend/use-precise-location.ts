import { useCallback, useState, useSyncExternalStore } from "react";

import {
  formatAccuracyM,
  type PreciseFix,
  type RegionChoice,
} from "@/components/home/recommend/quiz-model";

export type PreciseStatus =
  | "idle"
  | "locating"
  | "success"
  | "denied"
  | "timeout"
  | "unavailable"
  | "unsupported"
  | "insecure";

export interface LocatorSnapshot {
  readonly status: PreciseStatus;
  readonly fix: PreciseFix | null;
}

/** Single geolocation attempt budget; failures never retry on their own. */
export const GEO_TIMEOUT_MS = 10_000;

/** Cached fixes older than this are treated as stale at request time. */
export const GEO_MAXIMUM_AGE_MS = 60_000;

/** Accuracy worse than this counts as poor: warn, keep searching wider. */
export const POOR_ACCURACY_M = 1_000;

const COORD_PRECISION = 10_000;

const roundCoord = (value: number): number => Math.round(value * COORD_PRECISION) / COORD_PRECISION;

export interface LocatorPosition {
  readonly coords: {
    readonly latitude: number;
    readonly longitude: number;
    readonly accuracy: number | null;
  };
}

export interface LocatorGeolocation {
  getCurrentPosition(
    success: (position: LocatorPosition) => void,
    error?: ((reason: { readonly code: number }) => void) | null,
    options?: {
      readonly enableHighAccuracy?: boolean;
      readonly timeout?: number;
      readonly maximumAge?: number;
    },
  ): void;
}

export interface LocatorEnvironment {
  readonly geolocation: LocatorGeolocation | null;
  readonly secureContext: boolean;
}

/** Real environment, read lazily so server rendering never touches navigator. */
export const readLocatorEnvironment = (): LocatorEnvironment => {
  const candidate =
    typeof navigator === "undefined" || !("geolocation" in navigator)
      ? null
      : navigator.geolocation;

  return {
    geolocation: candidate,
    secureContext: typeof window === "undefined" ? true : window.isSecureContext,
  };
};

/** Map a GeolocationPositionError code to locator status without throwing. */
export const classifyGeoError = (code: number): PreciseStatus => {
  if (code === 1) {
    return "denied";
  }

  if (code === 2) {
    return "unavailable";
  }

  return "timeout";
};

export const isPoorAccuracy = (fix: PreciseFix): boolean =>
  fix.accuracy !== null && fix.accuracy > POOR_ACCURACY_M;

export const accuracyLabelFor = (fix: PreciseFix): string | null =>
  fix.accuracy === null ? null : formatAccuracyM(fix.accuracy);

export interface FallbackOption {
  readonly choice: RegionChoice;
  /** Manual retry stays available unless it would fail identically. */
  readonly retryPrecise: boolean;
}

/**
 * Inline alternatives shown when precise location fails: the approximate
 * home region (when trusted detection exists), the destination catalog, and
 * worldwide. Retry is offered for transient failures only — unsupported or
 * insecure contexts would fail the same way again.
 */
export const fallbackOptionsFor = (
  status: PreciseStatus,
  detected: string | null,
): ReadonlyArray<FallbackOption> => {
  const retryPrecise = status === "denied" || status === "timeout" || status === "unavailable";
  const options: Array<FallbackOption> = [];

  if (retryPrecise) {
    options.push({ choice: "precise", retryPrecise: true });
  }

  if (detected !== null) {
    options.push({ choice: "home", retryPrecise: false });
  }

  options.push({ choice: "destination", retryPrecise: false });
  options.push({ choice: "worldwide", retryPrecise: false });

  return options;
};

export const initialLocatorSnapshot: LocatorSnapshot = { status: "idle", fix: null };

/**
 * Framework-free precise-location state machine shared by the quiz and the
 * homepage carousel. Explicit `request()` calls are the ONLY path to
 * getCurrentPosition — construction, subscription, and rendering never prompt,
 * so removing mount-time effects is enough to guarantee no page-load prompt.
 * Concurrent requests are ignored; only the latest attempt can settle.
 */
export class PreciseLocator {
  private snapshot: LocatorSnapshot = initialLocatorSnapshot;
  private readonly listeners = new Set<() => void>();
  private requestId = 0;
  private completedRequests = 0;
  /**
   * Watchdog for the in-flight attempt. Cleared on every settle and on
   * reset; a stale fire is additionally disarmed by the requestId guard.
   */
  private attemptTimer: number | null = null;

  constructor(private readonly env: LocatorEnvironment) {}

  getSnapshot = (): LocatorSnapshot => this.snapshot;

  /**
   * Successful fixes so far. The carousel keys its precise query on this
   * counter instead of coordinates, so re-locating refetches without ever
   * persisting visitor coordinates in a cache key.
   */
  get successCount(): number {
    return this.completedRequests;
  }

  subscribe = (notify: () => void): (() => void) => {
    this.listeners.add(notify);

    return () => {
      this.listeners.delete(notify);
    };
  };

  private setSnapshot(next: LocatorSnapshot): void {
    this.snapshot = next;

    for (const notify of this.listeners) {
      notify();
    }
  }

  private clearAttemptTimer(): void {
    if (this.attemptTimer !== null) {
      clearTimeout(this.attemptTimer);
      this.attemptTimer = null;
    }
  }

  request(): void {
    if (this.snapshot.status === "locating") {
      return;
    }

    if (this.env.geolocation === null) {
      this.setSnapshot({ status: "unsupported", fix: null });

      return;
    }

    if (!this.env.secureContext) {
      this.setSnapshot({ status: "insecure", fix: null });

      return;
    }

    const attempt = this.requestId + 1;
    this.requestId = attempt;
    this.setSnapshot({ status: "locating", fix: null });

    // Watchdog for implementations that never settle (e.g. an ignored
    // permission prompt leaves the lane on "locating" forever): without
    // it the timeout alternatives — and the auto-retry below — can never
    // engage. Fires past the browser's own timeout so genuine browser
    // errors still win the race. Skipped outside a browser (SSR/tests)
    // where no timer exists; a stale fire is disarmed by the requestId
    // guard as well as the explicit clear on settle and reset.
    if (typeof window !== "undefined") {
      this.clearAttemptTimer();
      this.attemptTimer = window.setTimeout(() => {
        if (attempt !== this.requestId) {
          return;
        }

        this.attemptTimer = null;
        this.setSnapshot({ status: "timeout", fix: null });
      }, GEO_TIMEOUT_MS + 1000);
    }

    this.env.geolocation.getCurrentPosition(
      (position) => {
        if (attempt !== this.requestId) {
          return;
        }

        this.clearAttemptTimer();
        const { latitude, longitude, accuracy } = position.coords;

        if (
          !Number.isFinite(latitude) ||
          latitude < -90 ||
          latitude > 90 ||
          !Number.isFinite(longitude) ||
          longitude < -180 ||
          longitude > 180
        ) {
          this.setSnapshot({ status: "unavailable", fix: null });

          return;
        }

        this.completedRequests += 1;
        this.setSnapshot({
          status: "success",
          fix: {
            latitude: roundCoord(latitude),
            longitude: roundCoord(longitude),
            accuracy:
              accuracy === null || !Number.isFinite(accuracy) || accuracy < 0 ? null : accuracy,
          },
        });
      },
      (reason) => {
        if (attempt !== this.requestId) {
          return;
        }

        this.clearAttemptTimer();
        this.setSnapshot({ status: classifyGeoError(reason.code), fix: null });
      },
      {
        enableHighAccuracy: true,
        maximumAge: GEO_MAXIMUM_AGE_MS,
        timeout: GEO_TIMEOUT_MS,
      },
    );
  }

  reset(): void {
    this.requestId += 1;
    this.clearAttemptTimer();
    this.setSnapshot(initialLocatorSnapshot);
  }
}

/** React binding for the shared locator. */
export interface PreciseLocationBinding {
  readonly status: PreciseStatus;
  readonly fix: PreciseFix | null;
  readonly request: () => void;
  readonly reset: () => void;
  readonly successCount: number;
}

/**
 * React binding for the shared locator. Creates one locator per mount and
 * subscribes to it; it never requests on mount — the returned `request`
 * must come from an explicit user action.
 */
export function usePreciseLocation(): PreciseLocationBinding {
  const [locator] = useState(() => new PreciseLocator(readLocatorEnvironment()));

  const snapshot = useSyncExternalStore(
    useCallback((notify: () => void) => locator.subscribe(notify), [locator]),
    locator.getSnapshot,
    () => initialLocatorSnapshot,
  );

  const request = useCallback(() => {
    locator.request();
  }, [locator]);

  const reset = useCallback(() => {
    locator.reset();
  }, [locator]);

  return {
    status: snapshot.status,
    fix: snapshot.fix,
    request,
    reset,
    successCount: locator.successCount,
  };
}
