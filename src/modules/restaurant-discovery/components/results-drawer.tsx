import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useEffect, useRef } from "react";

import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";

/** Floating collapsible left drawer (desktop). Collapsing uses transform
 *  only; the map underneath never resizes or remounts. */
export function ResultsDrawer({
  copy,
  open,
  onToggle,
  title,
  children,
}: {
  copy: RestaurantCopy;
  open: boolean;
  onToggle: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef(open);
  const prevOpenRef = useRef(open);

  useEffect(() => {
    openRef.current = open;

    if (open) {
      const heading = panelRef.current?.querySelector("h2");

      if (heading instanceof HTMLElement) heading.focus({ preventScroll: true });
    } else if (prevOpenRef.current) {
      // Collapse returns focus to the expand control so keyboard users
      // are never stranded on the inert panel.
      toggleRef.current?.focus({ preventScroll: true });
    }

    prevOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && openRef.current) onToggle();
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [onToggle]);

  return (
    <>
      <section
        ref={panelRef}
        aria-label={title}
        aria-hidden={!open}
        inert={!open}
        className="mapapp-drawer"
        data-open={open}
      >
        <div className="mapapp-drawer-head">
          <h2 tabIndex={-1} className="mapapp-drawer-title">
            {title}
          </h2>
          <button
            type="button"
            className="mapapp-iconbtn"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={copy.collapseDrawer}
          >
            <PanelLeftClose aria-hidden="true" />
          </button>
        </div>
        <div className="mapapp-drawer-body">{children}</div>
      </section>
      {!open && (
        <button
          ref={toggleRef}
          type="button"
          className="mapapp-drawer-fab"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={copy.expandDrawer}
        >
          <PanelLeftOpen aria-hidden="true" />
        </button>
      )}
    </>
  );
}
