import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";

import { SURPRISE_DISH_EVENT, type FoodLocation } from "@/components/home/globe/food-locations";
import {
  FACING_COSINE_THRESHOLD,
  GLOBE_REVOLUTION_SECONDS,
  SPIN_DIRECTION,
  facingCosine,
  type GlobeLayout,
  type GlobeOverlayBridge,
  type ViewportSize,
} from "@/components/home/globe/geo-utils";
import {
  MAX_CONCURRENT_POPUPS,
  type GlobeHoverState,
  type GlobePopupNodes,
} from "@/components/home/globe/use-globe-dishes";

/**
 * Dish rhythm: a new set every 6.5s with a 6s show + 0.38s exit for
 * near-seamless handoffs, and a 20s cooldown so recently shown dishes rest —
 * a comfortable reading pace for one or two labels at a time. Brief pauses
 * still occur over ocean sectors with no curated dishes in view
 * (e.g. the Pacific transit). While a pin is hovered/focused the set freezes
 * so the auto-cycle never fights the pinned popup; the rhythm resumes fresh
 * once the pin clears.
 */
const DISH_INTERVAL_SECONDS = 6.5;
const DISH_COOLDOWN_SECONDS = 20;

/** Viewport width below which at most one popup shows at a time. */
const NARROW_VIEWPORT_PX = 640;

type AnchorReading = {
  cosine: number;
  x: number;
  y: number;
  inZone: boolean;
};

type AnimatorTemps = {
  world: THREE.Vector3;
  projected: THREE.Vector3;
  center: THREE.Vector3;
};

type ScoredDish = {
  dish: FoodLocation;
  cosine: number;
  x: number;
  y: number;
};

/**
 * Clearance box between popup anchors in CSS pixels. Cards are wide pills
 * that sit above their anchor, so overlap is a box test (one card width
 * plus a gap horizontally, one card height plus a gap vertically), not a
 * radius: a radial check lets side-by-side cards overlap.
 */
const POPUP_CLEAR_WIDTH_PX = 300;
const POPUP_CLEAR_HEIGHT_PX = 120;

function readAnchor(
  anchor: THREE.Object3D,
  camera: THREE.Camera,
  size: ViewportSize,
  layout: GlobeLayout,
  temps: AnimatorTemps,
): AnchorReading {
  anchor.getWorldPosition(temps.world);
  temps.center.set(layout.centerX, layout.centerY, 0);

  const cosine = facingCosine(temps.world, temps.center, camera.position);
  temps.projected.copy(temps.world).project(camera);

  const x = (temps.projected.x * 0.5 + 0.5) * size.width;
  const y = (-temps.projected.y * 0.5 + 0.5) * size.height;

  // Eligible cards live on the visible globe below the hero copy: clear of
  // the Ask Muse pill, and inside the lower globe band with room for the
  // card to fit without covering the headline or primary CTAs.
  // On narrow phones the hero copy stacks full-width above the globe, so the
  // zone additionally clears the copy block plus one card height — the card
  // extends upward from its anchor and must never cover a CTA. Both desktop
  // and mobile heroes mark the copy block with `data-hero-copy`. When the
  // remaining band is too thin, no dish is eligible: fewer labels beat
  // colliding ones.
  const narrow = size.width < 640;

  let copyClear = 0;

  if (typeof document !== "undefined") {
    const copyBottom =
      document.querySelector("[data-hero-copy]")?.getBoundingClientRect().bottom ??
      size.height * 0.5;

    // Desktop only needs a gap: the rect is viewport-relative, so it already
    // carries the header's height on top of the canvas coordinates.
    copyClear = copyBottom + (narrow ? 96 : 32);
  }

  const zoneTop = Math.max(
    size.height * 0.5,
    size.height - layout.capPx + layout.diameterPx * 0.1,
    copyClear,
  );

  // The floating "Show another dish" action sits bottom-right on phones:
  // keep anchors out from behind it so labels never cover it. The button is
  // ~44px tall at the safe-area bottom edge, so only that strip is excluded.
  const inActionCorner = narrow && x > size.width - 230 && y > size.height - 64;

  const inZone =
    x > size.width * 0.06 &&
    x < size.width * 0.94 &&
    y > zoneTop &&
    y < size.height - 8 &&
    !inActionCorner;

  return { cosine, x, y, inZone };
}

function countryKey(dish: FoodLocation): string {
  return dish.country.get("en") ?? dish.id;
}

/**
 * Imperative overlay write: the animator owns per-frame DOM positioning so
 * React state never updates at 60fps. Transform/visibility only, so the
 * hero layout never shifts.
 */
function writePopupPosition(node: HTMLElement, x: number, y: number, visible: boolean): void {
  if (visible) {
    node.style.visibility = "visible";
    node.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  } else {
    node.style.visibility = "hidden";
  }
}

/**
 * Spins the globe, schedules the visible dish set, and positions the DOM
 * overlay nodes every frame. Runs inside the Canvas; pauses with
 * frameloop="never".
 */
export function GlobeAnimator({
  spinRef,
  anchorsRef,
  bridgeRef,
  popupsRef,
  hoverRef,
  visibleDishes,
  onActiveDishes,
  layout,
}: {
  spinRef: RefObject<THREE.Group | null>;
  anchorsRef: RefObject<Map<string, THREE.Object3D | null>>;
  bridgeRef: RefObject<GlobeOverlayBridge>;
  popupsRef: RefObject<GlobePopupNodes>;
  hoverRef: RefObject<GlobeHoverState>;
  visibleDishes: Array<FoodLocation>;
  onActiveDishes: (ids: Array<string>) => void;
  layout: GlobeLayout;
}) {
  const temps = useMemo<AnimatorTemps>(
    () => ({
      world: new THREE.Vector3(),
      projected: new THREE.Vector3(),
      center: new THREE.Vector3(),
    }),
    [],
  );

  const lastTick = useRef(DISH_INTERVAL_SECONDS * -1 + 1);
  const lastShown = useRef(new Map<string, number>());
  const lastSent = useRef("");
  const lastPositioned = useRef(new Map<string, { x: number; y: number; visible: boolean }>());
  const wasHovered = useRef(false);
  const forceRandom = useRef(false);

  useEffect(() => {
    const surprise = () => {
      forceRandom.current = true;
      lastTick.current = -1000;
    };

    window.addEventListener(SURPRISE_DISH_EVENT, surprise);

    return () => {
      window.removeEventListener(SURPRISE_DISH_EVENT, surprise);
    };
  }, []);

  const pickDishes = (camera: THREE.Camera, size: ViewportSize, now: number): Array<string> => {
    const narrow = size.width < NARROW_VIEWPORT_PX;

    // Visibility policy on narrow phones: an expanded bottom sheet covers
    // the globe, so auto popups stand down instead of fighting the open
    // sheet — labels only auto-cycle over the collapsed peek. The mobile
    // sheet marks its mode on `data-mobile-sheet`; desktop has no such
    // node and is unaffected. Hover/focus pins still work; this gates
    // only the automatic set.
    if (narrow && typeof document !== "undefined") {
      const sheetMode = document
        .querySelector("[data-mobile-sheet]")
        ?.getAttribute("data-mobile-sheet");

      if (sheetMode !== null && sheetMode !== undefined && sheetMode !== "collapsed") {
        return [];
      }
    }

    const eligible: Array<ScoredDish> = [];

    // Only the currently visible pin subset is eligible: popups never pick
    // a dish whose pin is not on the globe.
    for (const dish of visibleDishes) {
      const anchor = anchorsRef.current.get(dish.id);

      if (!anchor) {
        continue;
      }

      const reading = readAnchor(anchor, camera, size, layout, temps);

      if (reading.cosine <= FACING_COSINE_THRESHOLD || !reading.inZone) {
        continue;
      }

      const last = lastShown.current.get(dish.id) ?? DISH_COOLDOWN_SECONDS * -2;

      if (now - last < DISH_COOLDOWN_SECONDS) {
        continue;
      }

      eligible.push({ dish, cosine: reading.cosine, x: reading.x, y: reading.y });
    }

    if (eligible.length === 0) {
      return [];
    }

    if (forceRandom.current) {
      for (let index = eligible.length - 1; index > 0; index -= 1) {
        const other = Math.floor(Math.random() * (index + 1));
        const current = eligible[index];
        const candidate = eligible[other];

        if (current === undefined || candidate === undefined) {
          continue;
        }

        eligible[index] = candidate;
        eligible[other] = current;
      }
    } else {
      eligible.sort((a, b) => b.cosine - a.cosine);
    }

    // Spread the set across countries and the screen: the first pass takes
    // at most one popup per country, the second allows a second dish per
    // country for nearby-cuisine depth. Every pass enforces a minimum
    // on-screen separation so concurrent cards never stack on top of each
    // other — there is no separation-free fallback pass: when space runs
    // out, fewer labels render instead of colliding ones. Narrow phones
    // show at most one label at a time.
    const picked: Array<ScoredDish> = [];
    const pickedIds = new Set<string>();
    const perCountry = new Map<string, number>();
    const maxPopups = size.width < NARROW_VIEWPORT_PX ? 1 : MAX_CONCURRENT_POPUPS;

    // Outgoing cards never share the screen with incoming ones (the swap-in
    // animation waits for the exit), so only the new set is checked.
    const isClear = (candidate: ScoredDish): boolean =>
      !picked.some(
        (taken) =>
          Math.abs(taken.x - candidate.x) < POPUP_CLEAR_WIDTH_PX &&
          Math.abs(taken.y - candidate.y) < POPUP_CLEAR_HEIGHT_PX,
      );

    const take = (maxPerCountry: number) => {
      for (const candidate of eligible) {
        if (picked.length >= maxPopups) {
          break;
        }

        if (pickedIds.has(candidate.dish.id)) {
          continue;
        }

        const key = countryKey(candidate.dish);

        if ((perCountry.get(key) ?? 0) >= maxPerCountry) {
          continue;
        }

        if (!isClear(candidate)) {
          continue;
        }

        perCountry.set(key, (perCountry.get(key) ?? 0) + 1);
        pickedIds.add(candidate.dish.id);
        picked.push(candidate);
      }
    };

    take(1);
    take(2);

    return picked.map((item) => item.dish.id);
  };

  useFrame((state, delta) => {
    const spin = spinRef.current;

    if (!spin) {
      return;
    }

    spin.rotation.y +=
      (SPIN_DIRECTION * Math.min(delta, 0.1) * Math.PI * 2) / GLOBE_REVOLUTION_SECONDS;

    const bridge = bridgeRef.current;
    const now = state.clock.elapsedTime;
    const hoveredId = hoverRef.current.hoveredId;

    if (wasHovered.current && hoveredId === null) {
      lastTick.current = now;
    }

    wasHovered.current = hoveredId !== null;

    if (
      hoveredId === null &&
      now - lastTick.current >= DISH_INTERVAL_SECONDS &&
      !document.hidden &&
      !bridge.paused
    ) {
      lastTick.current = now;

      const next = pickDishes(state.camera, state.size, now);
      forceRandom.current = false;

      for (const id of next) {
        lastShown.current.set(id, now);
      }

      if (lastShown.current.size > visibleDishes.length + 64) {
        for (const [id, at] of lastShown.current) {
          if (now - at >= DISH_COOLDOWN_SECONDS) {
            lastShown.current.delete(id);
          }
        }
      }

      const key = next.join(",");

      if (key !== lastSent.current) {
        lastSent.current = key;
        onActiveDishes(next);
      }
    }

    const popups = popupsRef.current;

    for (const [id, node] of popups) {
      if (!node) {
        continue;
      }

      const anchor = anchorsRef.current.get(id);

      if (!anchor) {
        continue;
      }

      const reading = readAnchor(anchor, state.camera, state.size, layout, temps);
      const visible = reading.cosine > FACING_COSINE_THRESHOLD && reading.inZone;
      const cache = lastPositioned.current.get(id);
      const roundedX = Math.round(reading.x * 10) / 10;
      const roundedY = Math.round((reading.y - 12) * 10) / 10;

      if (cache && cache.visible === visible && cache.x === roundedX && cache.y === roundedY) {
        continue;
      }

      lastPositioned.current.set(id, { x: roundedX, y: roundedY, visible });

      // Never show backside or out-of-zone popups: hide in place with
      // visibility so hero content never shifts.
      writePopupPosition(node, roundedX, roundedY, visible);
    }

    const node = bridge.node;
    const anchor = bridge.activeId ? anchorsRef.current.get(bridge.activeId) : undefined;

    if (!node || !anchor) {
      return;
    }

    // Narrow phones present the preview as a fixed bottom sheet (CSS owns
    // its placement), so per-frame anchor positioning stays desktop-only.
    if (state.size.width < NARROW_VIEWPORT_PX) {
      return;
    }

    const reading = readAnchor(anchor, state.camera, state.size, layout, temps);

    if (reading.cosine > FACING_COSINE_THRESHOLD && reading.inZone) {
      bridge.x = reading.x;
      bridge.y = reading.y;
      bridge.anchored = true;
      node.style.transform = `translate3d(${reading.x.toFixed(1)}px, ${(reading.y - 12).toFixed(1)}px, 0)`;
    } else {
      bridge.anchored = false;

      if (!bridge.paused && bridge.activeId) {
        bridge.activeId = null;
        onActiveDishes([]);
      }
    }
  });

  return null;
}
