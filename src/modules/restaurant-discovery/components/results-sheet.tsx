import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";

export type SheetSnap = 0 | 1 | 2;

/** Snap thresholds shared by drag release and tests: ratio is the dragged
 *  height as a fraction of the stage height. */
export function snapForRatio(ratio: number): SheetSnap {
  if (ratio < 0.27) {
    return 0;
  }

  if (ratio < 0.66) {
    return 1;
  }

  return 2;
}

/** Fixed snap heights: peek strip, half, near-full. The sheet never
 *  unmounts or rekeys the map; only its own height changes. */
export function sheetSnapHeight(snap: SheetSnap): string {
  if (snap === 0) {
    return "128px";
  }

  if (snap === 1) {
    return "45%";
  }

  return "88%";
}

/** Tap on the handle cycles forward through the three snaps. The button
 *  group was removed: one handle, no nested buttons, no gesture conflict. */
export function nextSheetSnap(snap: SheetSnap): SheetSnap {
  if (snap === 0) return 1;

  if (snap === 1) return 2;

  return 0;
}

/** Keyboard stepping for the handle: arrows move one snap, Home/End jump,
 *  Escape collapses to peek. Returns null when the key is unhandled. */
export function sheetSnapForKey(key: string, current: SheetSnap): SheetSnap | null {
  if (key === "ArrowUp" || key === "ArrowRight") {
    if (current === 0) return 1;

    return 2;
  }

  if (key === "ArrowDown" || key === "ArrowLeft") {
    if (current === 2) return 1;

    return 0;
  }

  if (key === "Home") return 0;

  if (key === "End") return 2;

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

/** Draggable bottom sheet with three snap positions. Dragging sets height
 *  directly (no transition); release snaps with a short transform-free
 *  height transition, disabled under reduced motion. The header is a single
 *  button (grip + verified-count summary + chevron): tap cycles snaps,
 *  arrows step, Home/End jump, Escape collapses. */
export function ResultsSheet({
  copy,
  snap,
  onSnapChange,
  title,
  summary,
  children,
}: {
  copy: RestaurantCopy;
  snap: SheetSnap;
  onSnapChange: (snap: SheetSnap) => void;
  title: string;
  summary: string;
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

  const snapHeight = (value: SheetSnap): string => sheetSnapHeight(value);

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
      Math.round(parent * 0.92),
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
    onSnapChange(snapForRatio(ratio));
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

          onSnapChange(nextSheetSnap(snap));
        }}
        onKeyDown={(event) => {
          const next = sheetSnapForKey(event.key, snapRef.current);

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
