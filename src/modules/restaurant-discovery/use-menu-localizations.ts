import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import type { LocalizationTarget } from "@/modules/restaurant-discovery/menu-localization-targets";
import {
  machineLocalizationFromRow,
  type MenuMachineLocalization,
} from "@/modules/restaurant-discovery/menu-presentation";
import {
  ensureMenuLocalizationsFn,
  getMenuLocalizationsFn,
} from "@/modules/restaurant-discovery/restaurant-menu-localizations.functions";

/**
 * Panel integration for the machine localization tier (Agent J).
 *
 * The panel (coordinator-owned) keeps rendering the approved tier from its
 * existing getRestaurant read and overlays this hook's rows through
 * presentReviewedWithLocalizations. Machine rows never replace approved
 * translations and carry labeled provenance; while they load (or when
 * generation defers) the panel keeps showing the original menu text.
 *
 * Query key includes venue + language + source-revision fingerprint: any
 * source-text edit changes the fingerprint, busts the cache, and re-runs
 * the on-demand ensure for the new revision. Stored rows for unchanged text
 * are reused with zero provider calls.
 */

export const MENU_LOCALIZATIONS_QUERY_KEY = "menu-localizations";

/**
 * Stored machine/approved rows for one venue in one target language or
 * style, with a controlled on-demand ensure for cache misses. Reads are
 * guest-safe; generation is bounded server-side (batches, coalescing,
 * budgets) and deferred failures keep the original text on screen.
 *
 * Pass the fingerprint from menuSourceRevisionFingerprint (exported by
 * menu-source-hash) for precise revision-scoped keys; omitting it falls
 * back to a venue+language key (the ensure still runs once per key and
 * refreshes stale rows).
 */
export function useMenuLocalizations(
  venueId: string,
  language: LocalizationTarget,
  fingerprint?: string,
) {
  const queryClient = useQueryClient();

  const queryKey = useMemo(
    () =>
      fingerprint === undefined
        ? [MENU_LOCALIZATIONS_QUERY_KEY, venueId, language]
        : [MENU_LOCALIZATIONS_QUERY_KEY, venueId, language, fingerprint],
    [fingerprint, language, venueId],
  );

  const cached = useQuery({
    queryKey,
    queryFn: () => getMenuLocalizationsFn({ data: { venueId, target: language } }),
    staleTime: 60000,
    retry: false,
  });

  // One on-demand ensure per key: cache misses generate in the background
  // (simultaneous requests coalesce server-side); deferred or failed
  // generations leave the original text in place. Newly generated rows
  // invalidate this exact key so the overlay appears without a refetch loop.
  const keyString = JSON.stringify(queryKey);
  const ensuredFor = useRef<string | null>(null);

  useEffect(() => {
    if (!cached.isSuccess || ensuredFor.current === keyString) return;

    ensuredFor.current = keyString;

    void ensureMenuLocalizationsFn({ data: { venueId, target: language } }).then(
      (summary) => {
        if (summary.generated > 0) void queryClient.invalidateQueries({ queryKey });
      },
      () => {
        // Deferred: budget, rate limit, or unconfigured provider. The
        // original menu text stays; a later mount retries for a new key.
      },
    );
  }, [cached.isSuccess, keyString, language, queryClient, queryKey, venueId]);

  const localizations: ReadonlyArray<MenuMachineLocalization> = (cached.data ?? []).map(
    machineLocalizationFromRow,
  );

  return {
    localizations,
    isPending: cached.isPending,
    isError: cached.isError,
    refetch: cached.refetch,
  };
}
