import { useEffect, useState } from "react";

import type { MenuSelection } from "@/modules/restaurant-discovery/menu-presentation";

export interface MenuSelectionSnapshot {
  readonly activeVariants: ReadonlyMap<string, string>;
  readonly selections: ReadonlyArray<MenuSelection>;
  readonly reviewed: ReadonlySet<string>;
}

/**
 * Shared order-selection controller for the canonical restaurant
 * experience. Overview, menu, and reviews panels unmount on every switch;
 * this module-level store keeps quantities, variants, instructions, and
 * review acknowledgements for the same venue + channel while the page
 * lives. Memory-only: nothing is persisted across reloads, accounts, or
 * localStorage, so private ordering instructions never leak.
 */
const selectionStore = new Map<string, MenuSelectionSnapshot>();

export const selectionKeyFor = (venueId: string, channel: string): string =>
  `${venueId}:${channel}`;

export function readMenuSelection(venueId: string, channel: string): MenuSelectionSnapshot | null {
  return selectionStore.get(selectionKeyFor(venueId, channel)) ?? null;
}

export function writeMenuSelection(
  venueId: string,
  channel: string,
  snapshot: MenuSelectionSnapshot,
): void {
  selectionStore.set(selectionKeyFor(venueId, channel), snapshot);
}

/** Owner contract for the shared order-selection controller. */
export interface MenuSelectionController {
  readonly activeVariants: ReadonlyMap<string, string>;
  readonly selections: ReadonlyArray<MenuSelection>;
  readonly reviewed: ReadonlySet<string>;
  readonly setActiveVariants: (
    next:
      | ReadonlyMap<string, string>
      | ((previous: ReadonlyMap<string, string>) => ReadonlyMap<string, string>),
  ) => void;
  readonly setSelections: (
    next:
      | ReadonlyArray<MenuSelection>
      | ((previous: ReadonlyArray<MenuSelection>) => ReadonlyArray<MenuSelection>),
  ) => void;
  readonly setReviewed: (
    next: ReadonlySet<string> | ((previous: ReadonlySet<string>) => ReadonlySet<string>),
  ) => void;
}

/** React binding for the shared controller. State initializes from the
 *  store (preserving selections across panel switches) and writes back on
 *  every change. Identity filtering against currently available variants
 *  stays with the caller, mirroring the previous per-panel semantics. */
export function useMenuSelection(venueId: string, channel: string): MenuSelectionController {
  const [activeVariants, setActiveVariantsState] = useState<ReadonlyMap<string, string>>(
    () => readMenuSelection(venueId, channel)?.activeVariants ?? new Map(),
  );

  const [selections, setSelectionsState] = useState<ReadonlyArray<MenuSelection>>(
    () => readMenuSelection(venueId, channel)?.selections ?? [],
  );

  const [reviewed, setReviewedState] = useState<ReadonlySet<string>>(
    () => readMenuSelection(venueId, channel)?.reviewed ?? new Set(),
  );

  useEffect(() => {
    writeMenuSelection(venueId, channel, { activeVariants, selections, reviewed });
  }, [venueId, channel, activeVariants, selections, reviewed]);

  return {
    activeVariants,
    selections,
    reviewed,
    setActiveVariants: setActiveVariantsState,
    setSelections: setSelectionsState,
    setReviewed: setReviewedState,
  };
}
