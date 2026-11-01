import { useEffect, useRef, useState, type RefObject } from "react";

import {
  FOOD_LOCATIONS,
  SURPRISE_DISH_EVENT,
  type FoodLocation,
} from "@/components/home/globe/food-locations";
import type { GlobeOverlayBridge } from "@/components/home/globe/geo-utils";
import type { ActiveDish } from "@/components/home/globe/globe-food-overlay";
import type { Messages } from "@/shared/i18n";

/** Maximum concurrent food popups on the hero globe: two on desktop, one on
 * narrow phones (the animator caps to one below 640px). Previously ten
 * overlapping cards; sparse labels stay readable and never cover the CTAs. */
export const MAX_CONCURRENT_POPUPS = 2;

const DISH_SHOW_MS = 6000;
const DISH_EXIT_MS = 380;

/** DOM nodes for the live popups, positioned imperatively by the animator. */
export type GlobePopupNodes = Map<string, HTMLElement | null>;

/** Shared hover/focus pin state between the canvas and the popup scheduler. */
export type GlobeHoverState = {
  hoveredId: string | null;
};

export type GlobeDishes = {
  actives: Array<ActiveDish>;
  preview: FoodLocation | null;
  announcement: string;
  hoverRef: RefObject<GlobeHoverState>;
  handleActiveDishes: (ids: Array<string>) => void;
  handleHoverDish: (id: string | null) => void;
  handleOpenPreview: (dish: FoodLocation) => void;
  handleClosePreview: () => void;
  handleShowAnother: () => void;
};

function findDish(id: string): FoodLocation | undefined {
  return FOOD_LOCATIONS.find((candidate) => candidate.id === id);
}

/**
 * Dish scheduling UI state for the hero globe: the timed popup lifecycle for
 * up to MAX_CONCURRENT_POPUPS cards, the preview dialog, hover/focus pinning,
 * and screen-reader announcements. Pure behavior — the scene component only
 * renders what this returns.
 *
 * Auto-cycle rules: the animator supplies fresh id sets on its tick; dishes
 * that drop out exit-animate before unmounting. A hovered/focused dish is
 * pinned (never auto-removed while pinned) and resumes the normal show timer
 * once the pointer/focus leaves.
 */
export function useGlobeDishes(
  bridgeRef: RefObject<GlobeOverlayBridge>,
  copy: Messages,
): GlobeDishes {
  const [actives, setActives] = useState<Array<ActiveDish>>([]);
  const [preview, setPreview] = useState<FoodLocation | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const activesRef = useRef<Array<ActiveDish>>([]);
  const timers = useRef(new Map<string, number>());
  const hoverRef = useRef<GlobeHoverState>({ hoveredId: null });

  useEffect(() => {
    const pending = timers.current;

    return () => {
      for (const timer of pending.values()) {
        window.clearTimeout(timer);
      }

      pending.clear();
    };
  }, []);

  useEffect(() => {
    bridgeRef.current.paused = preview !== null;
  }, [preview, bridgeRef]);

  const clearTimer = (id: string) => {
    const timer = timers.current.get(id);

    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  };

  const removeDish = (id: string) => {
    if (hoverRef.current.hoveredId !== null) {
      timers.current.set(
        id,
        window.setTimeout(() => {
          removeDish(id);
        }, DISH_EXIT_MS),
      );

      return;
    }

    timers.current.delete(id);
    activesRef.current = activesRef.current.filter((item) => item.dish.id !== id);
    setActives(activesRef.current);
  };

  const exitDish = (id: string) => {
    timers.current.delete(id);

    const found = activesRef.current.some((item) => item.dish.id === id && !item.exiting);

    if (!found) {
      return;
    }

    activesRef.current = activesRef.current.map((item) =>
      item.dish.id === id ? { dish: item.dish, exiting: true } : item,
    );
    setActives(activesRef.current);

    timers.current.set(
      id,
      window.setTimeout(() => {
        removeDish(id);
      }, DISH_EXIT_MS),
    );
  };

  const armShowTimer = (id: string) => {
    clearTimer(id);

    timers.current.set(
      id,
      window.setTimeout(() => {
        // While a pin is hovered/focused the whole auto-cycle pauses: no
        // popup exits until the pointer/focus clears and rhythm resumes.
        if (hoverRef.current.hoveredId !== null) {
          armShowTimer(id);

          return;
        }

        exitDish(id);
      }, DISH_SHOW_MS),
    );
  };

  const handleActiveDishes = (ids: Array<string>) => {
    const hovered = hoverRef.current.hoveredId;
    const ordered = hovered === null ? ids : [hovered, ...ids];
    const seen = new Set<string>();
    const wanted: Array<string> = [];

    for (const id of ordered) {
      if (!seen.has(id)) {
        seen.add(id);
        wanted.push(id);

        if (wanted.length >= MAX_CONCURRENT_POPUPS) {
          break;
        }
      }
    }

    const wantedSet = new Set(wanted);
    const next: Array<ActiveDish> = [];

    for (const id of wanted) {
      const existing = activesRef.current.find((item) => item.dish.id === id);

      if (existing) {
        next.push(existing);
        continue;
      }

      const dish = findDish(id);

      if (dish) {
        next.push({ dish, exiting: false });
        armShowTimer(id);
      }
    }

    for (const item of activesRef.current) {
      if (wantedSet.has(item.dish.id)) {
        continue;
      }

      if (item.exiting) {
        next.push(item);
        continue;
      }

      next.push({ dish: item.dish, exiting: true });
      clearTimer(item.dish.id);

      const exitingId = item.dish.id;

      timers.current.set(
        exitingId,
        window.setTimeout(() => {
          removeDish(exitingId);
        }, DISH_EXIT_MS),
      );
    }

    activesRef.current = next;
    setActives(next);
  };

  const handleHoverDish = (id: string | null) => {
    if (hoverRef.current.hoveredId === id) {
      return;
    }

    const previous = hoverRef.current.hoveredId;
    hoverRef.current.hoveredId = id;

    if (id === null) {
      if (previous !== null) {
        const stillVisible = activesRef.current.some(
          (item) => item.dish.id === previous && !item.exiting,
        );

        if (stillVisible) {
          armShowTimer(previous);
        }
      }

      return;
    }

    const dish = findDish(id);

    if (!dish) {
      return;
    }

    const exists = activesRef.current.some((item) => item.dish.id === id);

    if (!exists) {
      const settled = activesRef.current.filter((item) => !item.exiting);

      if (settled.length >= MAX_CONCURRENT_POPUPS) {
        const oldest = settled[0];

        if (oldest && oldest.dish.id !== id) {
          exitDish(oldest.dish.id);
        }
      }

      activesRef.current = [...activesRef.current, { dish, exiting: false }];
      setActives(activesRef.current);
    }

    armShowTimer(id);
  };

  const handleOpenPreview = (dish: FoodLocation) => {
    for (const timer of timers.current.values()) {
      window.clearTimeout(timer);
    }

    timers.current.clear();
    activesRef.current = [];
    setActives([]);
    hoverRef.current.hoveredId = null;
    bridgeRef.current.activeId = dish.id;
    setPreview(dish);
    setAnnouncement(copy.previewOpened);
  };

  const handleClosePreview = () => {
    setPreview(null);
    bridgeRef.current.activeId = null;
    setAnnouncement(copy.previewClosed);
    document.getElementById("surprise-dish-button")?.focus({ preventScroll: true });
  };

  const handleShowAnother = () => {
    setPreview(null);
    bridgeRef.current.activeId = null;
    document.getElementById("surprise-dish-button")?.focus({ preventScroll: true });
    window.dispatchEvent(new CustomEvent(SURPRISE_DISH_EVENT));
  };

  return {
    actives,
    preview,
    announcement,
    hoverRef,
    handleActiveDishes,
    handleHoverDish,
    handleOpenPreview,
    handleClosePreview,
    handleShowAnother,
  };
}
