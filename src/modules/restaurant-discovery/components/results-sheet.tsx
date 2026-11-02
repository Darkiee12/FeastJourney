import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";

export type SheetSnap = 0 | 1 | 2;

/** Distinct result conditions. Loading, no-scope (no city/region yet),
 *  no-evidence (dish filter matches nothing reviewed), no-area (region
 *  has no mapped places), empty-catalog, and no-match (filters too
 *  tight) are never conflated. Null means results are present. */
export type ResultsState =
  | "loading"
  | "no-scope"
  | "no-evidence"
  | "no-area"
  | "empty-catalog"
  | "no-match";

/** Pure state resolver shared by the search page (sheet, drawer, and
 *  map overlay stay consistent). Precedence: results beat everything;
 *  loading beats emptiness; an empty catalog beats the dish filter. */
export function resolveResultsState(args: {
  readonly rows: number;
  readonly isDishMode: boolean;
  readonly datasetEmpty: boolean;
  readonly hasScope: boolean;
  readonly hasArea: boolean;
  readonly isLoading: boolean;
}): ResultsState | null {
  if (args.rows > 0) return null;

  if (args.isLoading) return "loading";

  if (args.datasetEmpty) return "empty-catalog";

  if (args.isDishMode) return "no-evidence";

  if (!args.hasScope) return "no-scope";

  if (!args.hasArea) return "no-area";

  return "no-match";
}

/** Snap profile contract for the coordinator-owned page. The containers
 *  stay controlled (the page owns `snap`); the profile only caps what the
 *  gesture/keyboard/tap affordances can reach:
 *  - `results`: Peek / Half / Full (map-focused summary, scrollable list,
 *    full-height content).
 *  - `empty`: compact zero-state. Peek plus one compact expanded stop;
 *    Full is unreachable so a zero-record sheet can never auto-occupy ~88%
 *    of the viewport with a blank area.
 *  - `detail`: restaurant detail/menu/review panels. Unrestricted, exactly
 *    like `results` — empty-state caps never apply here.
 *  Agent B owns the empty-state content; this profile only sizes the shell. */
export type SheetProfile = "results" | "empty" | "detail";

/** Highest snap reachable while the result set is empty. Full (2) is
 *  deliberately unreachable on a zero-record sheet. */
export const EMPTY_SNAP_MAX: SheetSnap = 1;

/** Pure profile resolver for the page: detail panels always win (they stay
 *  fully expandable); otherwise the presence of rows decides. Loading counts
 *  as empty — the skeleton is short, so the compact cap avoids a tall blank
 *  sheet that would then snap violently when rows arrive. */
export function resolveSheetProfile(args: {
  readonly hasResults: boolean;
  readonly isDetail: boolean;
}): SheetProfile {
  if (args.isDetail) return "detail";

  if (args.hasResults) return "results";

  return "empty";
}

/** Clamp a page-held snap when the profile flips toward empty (e.g. a
 *  refetch lands zero rows while the user sat at Full). Flips toward
 *  results/detail leave the snap untouched: the container never
 *  auto-expands, so arriving rows do not yank the sheet under the user. */
export function coerceSnapForProfile(snap: SheetSnap, profile: SheetProfile): SheetSnap {
  if (profile === "empty" && snap === 2) return EMPTY_SNAP_MAX;

  return snap;
}

/** Drag ceiling as a fraction of the stage height. Empty sheets cap near
 *  the compact stop so dragging toward Full reveals no huge blank area. */
export function sheetMaxRatio(profile: SheetProfile = "results"): number {
  if (profile === "empty") return 0.42;

  return 0.92;
}

/** Snap thresholds shared by drag release and tests: ratio is the dragged
 *  height as a fraction of the stage height. On the empty profile the Full
 *  stop is unreachable by construction. */
export function snapForRatio(ratio: number, profile: SheetProfile = "results"): SheetSnap {
  if (ratio < 0.27) {
    return 0;
  }

  if (profile === "empty") {
    return 1;
  }

  if (ratio < 0.66) {
    return 1;
  }

  return 2;
}

/** Fixed snap heights: peek strip, half, near-full. The sheet never
 *  unmounts or rekeys the map; only its own height changes. The empty
 *  profile reuses the same peek and caps every expanded stop at one
 *  compact height (handle + heading + filters + message + 1-2 actions). */
export function sheetSnapHeight(snap: SheetSnap, profile: SheetProfile = "results"): string {
  if (profile === "empty") {
    if (snap === 0) {
      return "128px";
    }

    return "34%";
  }

  if (snap === 0) {
    return "128px";
  }

  if (snap === 1) {
    return "45%";
  }

  return "88%";
}

/** Tap on the handle cycles forward through the reachable snaps. The button
 *  group was removed: one handle, no nested buttons, no gesture conflict.
 *  Empty cycles Peek <-> compact only. */
export function nextSheetSnap(snap: SheetSnap, profile: SheetProfile = "results"): SheetSnap {
  if (profile === "empty") {
    if (snap === 0) return 1;

    return 0;
  }

  if (snap === 0) return 1;

  if (snap === 1) return 2;

  return 0;
}

/** Keyboard stepping for the handle: arrows move one snap, Home/End jump,
 *  Escape collapses to peek. Returns null when the key is unhandled.
 *  End (and ArrowUp from Half) stops at the compact stop on empty. */
export function sheetSnapForKey(
  key: string,
  current: SheetSnap,
  profile: SheetProfile = "results",
): SheetSnap | null {
  if (key === "ArrowUp" || key === "ArrowRight") {
    if (current === 0) return 1;

    if (profile === "empty") return 1;

    return 2;
  }

  if (key === "ArrowDown" || key === "ArrowLeft") {
    if (current === 2) return 1;

    return 0;
  }

  if (key === "Home") return 0;

  if (key === "End") {
    if (profile === "empty") return 1;

    return 2;
  }

  if (key === "Escape") return 0;

  return null;
}

/** Peek summary honesty: render the verified count label verbatim, plus the
 *  capped note when the server limited the list. Never invents numbers. */
export function formatSheetSummary(countLabel: string, cappedNote: string | null): string {
  if (cappedNote === null || cappedNote === "") return countLabel;

  return `${countLabel} · ${cappedNote}`;
}

/** Tap-vs-drag disambiguation for the handle: a pointer release that moved
 *  more than the threshold is a drag (the snap comes from snapForRatio);
 *  anything smaller is a tap. Swallowing the click after a drag is what
 *  keeps a drag from activating the handle. */
export function shouldSuppressSheetTap(startY: number, endY: number, thresholdPx = 8): boolean {
  return Math.abs(endY - startY) > thresholdPx;
}

/** Action label for the handle's accessible name, reusing existing copy.
 *  Peek offers expansion, half offers the full list, full collapses. */
export function sheetHandleAction(snap: SheetSnap, copy: RestaurantCopy): string {
  if (snap === 0) return copy.sheetExpand;

  if (snap === 1) return copy.sheetFullList;

  return copy.sheetCollapse;
}

/** Draggable bottom sheet with content-aware snap profiles. Dragging sets
 *  height directly (no transition); release snaps with a short
 *  transform-free height transition, disabled under reduced motion.
 *  The header is a single button (grip + summary + chevron): tap cycles
 *  the reachable snaps, arrows step, Home/End jump, Escape collapses.
 *  `profile` caps the gesture: `empty` never reaches Full, `detail`
 *  (venue detail/menu/review panels) stays fully expandable. */
export function ResultsSheet({
  copy,
  snap,
  onSnapChange,
  title,
  summary,
  state,
  profile = "results",
  children,
}: {
  copy: RestaurantCopy;
  snap: SheetSnap;
  onSnapChange: (snap: SheetSnap) => void;
  title: string;
  summary: string;
  state?: ResultsState | null | undefined;
  profile?: SheetProfile | undefined;
  children: React.ReactNode;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const drag = useRef<{ startY: number; startH: number } | null>(null);
  const suppressTap = useRef(false);
  const [dragH, setDragH] = useState<number | null>(null);
  const snapRef = useRef(snap);
  const handleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && snapRef.current !== 0) onSnapChange(0);
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [onSnapChange]);

  // Collapsing to peek hides the body (hidden removes it from Tab order
  // and assistive tech). If focus was inside, move it to the handle so
  // keyboard users are never stranded on hidden content.
  useEffect(() => {
    if (snap !== 0) return;
    const body = rootRef.current?.querySelector(".mapapp-sheet-body");

    if (body !== null && body !== undefined && body.contains(document.activeElement)) {
      handleRef.current?.focus({ preventScroll: true });
    }
  }, [snap]);

  const snapHeight = (value: SheetSnap): string => sheetSnapHeight(value, profile);

  const beginDrag = (clientY: number) => {
    const root = rootRef.current;

    if (root === null) return;
    drag.current = { startY: clientY, startH: root.getBoundingClientRect().height };
    setDragH(drag.current.startH);
  };

  const moveDrag = (clientY: number) => {
    const current = drag.current;
    const root = rootRef.current;

    if (current === null || root === null) {
      setDragH(null);

      return;
    }

    const parent = root.parentElement?.getBoundingClientRect().height ?? window.innerHeight;

    const next = Math.min(
      Math.max(current.startH + (current.startY - clientY), 96),
      Math.round(parent * sheetMaxRatio(profile)),
    );

    setDragH(next);
  };

  const endDrag = (clientY: number) => {
    const current = drag.current;
    const root = rootRef.current;

    drag.current = null;

    if (current === null || root === null) {
      setDragH(null);

      return;
    }

    // A tap barely moves: let the click handler cycle the snap instead of
    // re-deriving it from the resting height.
    if (!shouldSuppressSheetTap(current.startY, clientY)) {
      setDragH(null);

      return;
    }

    suppressTap.current = true;
    const parent = root.parentElement?.getBoundingClientRect().height ?? window.innerHeight;
    const ratio = (current.startH + (current.startY - clientY)) / parent;

    setDragH(null);
    onSnapChange(snapForRatio(ratio, profile));
  };

  // Peek shows the handle plus the grounded count label only; the
  // result list (filter chips, cards, options) stays hidden until half/full.
  const peek = snap === 0 && dragH === null;

  return (
    <section
      ref={rootRef}
      aria-label={title}
      className="mapapp-sheet"
      data-snap={snap}
      data-state={state ?? undefined}
      data-profile={profile}
      style={dragH === null ? { height: snapHeight(snap) } : { height: `${dragH}px` }}
      data-dragging={dragH !== null}
    >
      <button
        ref={handleRef}
        type="button"
        className="mapapp-sheet-handle"
        style={{ touchAction: "none" }}
        aria-expanded={snap !== 0}
        aria-controls="mapapp-sheet-body"
        aria-label={`${title} — ${summary} — ${sheetHandleAction(snap, copy)}`}
        onClick={(event) => {
          if (suppressTap.current) {
            suppressTap.current = false;
            event.preventDefault();

            return;
          }

          onSnapChange(nextSheetSnap(snap, profile));
        }}
        onKeyDown={(event) => {
          const next = sheetSnapForKey(event.key, snapRef.current, profile);

          if (next === null || next === snapRef.current) return;
          event.preventDefault();
          onSnapChange(next);
        }}
        onPointerDown={(event) => {
          if (!event.isPrimary) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          beginDrag(event.clientY);
        }}
        onPointerMove={(event) => {
          if (drag.current !== null) moveDrag(event.clientY);
        }}
        onPointerUp={(event) => endDrag(event.clientY)}
        onPointerCancel={() => {
          drag.current = null;
          setDragH(null);
        }}
      >
        <span aria-hidden="true" className="mapapp-sheet-grip" />
        <span className="mapapp-sheet-summary">
          <strong>{title}</strong>
          <span>{summary}</span>
        </span>
        <ChevronDown aria-hidden="true" className="mapapp-sheet-chevron" data-open={snap !== 0} />
      </button>
      <div id="mapapp-sheet-body" className="mapapp-sheet-body" hidden={peek}>
        {children}
      </div>
    </section>
  );
}
