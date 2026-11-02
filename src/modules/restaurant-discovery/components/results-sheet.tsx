import { useEffect, useRef, useState } from "react";

import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";

export type SheetSnap = 0 | 1 | 2;

const SNAP_LABELS = (copy: RestaurantCopy): Record<SheetSnap, string> => ({
  0: copy.sheetPeek,
  1: copy.sheetHalf,
  2: copy.sheetFull,
});

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

/** Draggable bottom sheet with three snap positions. Dragging sets height
 *  directly (no transition); release snaps with a short transform-free
 *  height transition, disabled under reduced motion. */
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
  const [dragH, setDragH] = useState<number | null>(null);
  const snapRef = useRef(snap);
  const peekSnapRef = useRef<HTMLButtonElement>(null);

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
  // and assistive tech). If focus was inside, move it to the peek snap
  // button so keyboard users are never stranded on hidden content.
  useEffect(() => {
    if (snap !== 0) return;
    const body = rootRef.current?.querySelector(".mapapp-sheet-body");

    if (body !== null && body !== undefined && body.contains(document.activeElement)) {
      peekSnapRef.current?.focus({ preventScroll: true });
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

    const parent = root.parentElement?.getBoundingClientRect().height ?? window.innerHeight;
    const ratio = (current.startH + (current.startY - clientY)) / parent;

    setDragH(null);
    onSnapChange(snapForRatio(ratio));
  };

  const labels = SNAP_LABELS(copy);
  // Peek shows the drag handle plus the grounded count label only; the
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
      <div
        className="mapapp-sheet-handle"
        style={{ touchAction: "none" }}
        onPointerDown={(event) => {
          // Buttons inside the handle stay clickable: only grip/background
          // drags capture the pointer. Capturing a button tap would retarget
          // its mouseup and break the click.
          if (event.target instanceof Element && event.target.closest("button") !== null) return;

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
        <fieldset className="mapapp-sheet-snaps">
          <legend className="sr-only">{title}</legend>
          {([0, 1, 2] as const).map((value) => (
            <button
              key={value}
              ref={value === 0 ? peekSnapRef : undefined}
              type="button"
              className="mapapp-sheet-snapbtn"
              aria-pressed={snap === value}
              onClick={(event) => {
                event.stopPropagation();
                onSnapChange(value);
              }}
            >
              {labels[value]}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="mapapp-sheet-body" hidden={peek}>
        {children}
      </div>
    </section>
  );
}
