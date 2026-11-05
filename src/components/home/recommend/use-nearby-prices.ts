import { useEffect, useRef, useState } from "react";

import {
  lookupNearbyDishPricesBridgeFn,
  type NearbyDishPrice,
} from "@/modules/food-discovery/server/operations/nearby-price-lookup";

/**
 * Post-ranking nearby-price enrichment for precise ("Near me") quiz runs.
 *
 * Active ONLY when the caller passes a non-null request: quiz location kind
 * is precise with usable coordinates (gated upstream via
 * `preciseLookupOriginFor`), and ranking already completed (the caller only
 * builds the request from a ready outcome). Null means idle — no fetch, no
 * state, no placeholders. Coordinates travel only to the bridge server
 * function; they never enter a query key, storage, log, or the Muse path.
 */

export interface NearbyPriceRequest {
  /** Quiz-run identity (the canonical recommendation cache key). */
  readonly runId: string;
  readonly dishIds: ReadonlyArray<string>;
  readonly latitude: number;
  readonly longitude: number;
}

export type NearbyPricesStatus = "idle" | "loading" | "ready" | "failed";

export interface NearbyPricesSnapshot {
  readonly status: NearbyPricesStatus;
  readonly prices: ReadonlyMap<string, NearbyDishPrice>;
}

const EMPTY_PRICES: ReadonlyMap<string, NearbyDishPrice> = new Map();

/**
 * Index bridge rows by dish id, keeping priced rows only. One bad row never
 * poisons the rest: unpriced outcomes are skipped as a domain filter and the
 * first priced row wins per dish, so reordered or duplicated payloads cannot
 * reorder recommendations.
 */
export const indexNearbyPrices = (
  rows: ReadonlyArray<NearbyDishPrice>,
): ReadonlyMap<string, NearbyDishPrice> => {
  const indexed = new Map<string, NearbyDishPrice>();

  for (const row of rows) {
    if (row.outcome !== "priced") {
      continue;
    }

    if (!indexed.has(row.dishId)) {
      indexed.set(row.dishId, row);
    }
  }

  return indexed;
};

const isUsableCoordinate = (value: number, min: number, max: number): boolean =>
  Number.isFinite(value) && value >= min && value <= max;

export function useNearbyPrices(request: NearbyPriceRequest | null): NearbyPricesSnapshot {
  const [snapshot, setSnapshot] = useState<NearbyPricesSnapshot>({
    status: "idle",
    prices: EMPTY_PRICES,
  });

  const [snapshotRunId, setSnapshotRunId] = useState<string | null>(null);
  const generationRef = useRef(0);

  const runId = request?.runId ?? null;
  const dishKey = request === null ? null : [...request.dishIds].slice(0, 12).join(",");
  const latitude = request?.latitude ?? null;
  const longitude = request?.longitude ?? null;

  // Render-adjust reset (the same endorsed pattern as the quiz carousel
  // index): a new, cleared, or invalid run discards the previous run's
  // prices during render, so stale runs can never bleed through navigation
  // or retry — no set-state-in-effect needed for the reset.
  if (snapshotRunId !== runId) {
    setSnapshotRunId(runId);
    setSnapshot({ status: "idle", prices: EMPTY_PRICES });
  }

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    let cancelled = false;

    if (
      runId !== null &&
      dishKey !== null &&
      dishKey !== "" &&
      latitude !== null &&
      longitude !== null &&
      isUsableCoordinate(latitude, -90, 90) &&
      isUsableCoordinate(longitude, -180, 180)
    ) {
      lookupNearbyDishPricesBridgeFn({
        data: {
          dishIds: dishKey.split(","),
          latitude,
          longitude,
          channel: "dine_in",
        },
      })
        .then((rows) => {
          if (cancelled || generationRef.current !== generation) {
            return;
          }

          setSnapshot({ status: "ready", prices: indexNearbyPrices(rows) });
        })
        .catch(() => {
          if (cancelled || generationRef.current !== generation) {
            return;
          }

          // Failure keeps recommendations usable: no prices, no
          // placeholders, the existing Find-restaurants action stays intact.
          setSnapshot({ status: "failed", prices: EMPTY_PRICES });
        });
    }

    return () => {
      cancelled = true;
    };
  }, [runId, dishKey, latitude, longitude]);

  return snapshot;
}
