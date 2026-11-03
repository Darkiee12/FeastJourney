import { useState } from "react";

/**
 * Multipage browser for approved menu pages (photographs/scans of printed
 * menus). Runs inside the existing menu experience as a secondary tab: it
 * never replaces InteractiveMenuView and never derives ingredients, prices,
 * or dietary claims from page images — a photographed menu stays viewable
 * even when extraction fails or never runs.
 *
 * Client-safe: this file owns the consumed view shape (a subset of the
 * server MenuPagePublicView contract; field names match so panel data is
 * structurally assignable without importing server code).
 */

export interface MenuPageView {
  readonly id: string;
  readonly venueId: string;
  readonly pageOrder: number;
  readonly width: number;
  readonly height: number;
  readonly attribution: string;
  readonly sourceName: string | null;
  readonly sourceUrl: string | null;
  readonly license: string;
  readonly deliveryUrl: string;
}

const ZOOM_STEPS = [1, 1.5, 2] as const;

const defaultPageLabel = (index: number, total: number): string => `Page ${index} of ${total}`;

/** Pager over published menu pages: order, mobile readability, zoom/full-size. */
export function MenuPagesViewer({
  pages,
  previousLabel = "Previous page",
  nextLabel = "Next page",
  pageLabel = defaultPageLabel,
  zoomInLabel = "Zoom in",
  zoomOutLabel = "Zoom out",
  fullSizeLabel = "Open full size",
  emptyLabel = "No menu pages have been published for this venue yet.",
}: {
  readonly pages: ReadonlyArray<MenuPageView>;
  readonly previousLabel?: string | undefined;
  readonly nextLabel?: string | undefined;
  readonly pageLabel?: ((index: number, total: number) => string) | undefined;
  readonly zoomInLabel?: string | undefined;
  readonly zoomOutLabel?: string | undefined;
  readonly fullSizeLabel?: string | undefined;
  readonly emptyLabel?: string | undefined;
}) {
  const [index, setIndex] = useState(0);
  const [zoomStep, setZoomStep] = useState(0);

  if (pages.length === 0) {
    return (
      <div className="menu-pages-empty" aria-live="polite">
        {emptyLabel}
      </div>
    );
  }

  const bounded = Math.min(Math.max(index, 0), pages.length - 1);
  const current = pages[bounded];

  if (current === undefined) {
    return (
      <div className="menu-pages-empty" aria-live="polite">
        {emptyLabel}
      </div>
    );
  }

  const zoom = ZOOM_STEPS[Math.min(zoomStep, ZOOM_STEPS.length - 1)] ?? 1;

  const goTo = (next: number): void => {
    setIndex((next + pages.length) % pages.length);
    setZoomStep(0);
  };

  return (
    <section className="menu-pages-viewer" aria-label="Published menu pages">
      <nav className="menu-pages-toolbar" aria-label="Menu pages">
        <button
          type="button"
          className="menu-pages-nav"
          onClick={() => goTo(bounded - 1)}
          disabled={pages.length < 2}
          aria-label={previousLabel}
        >
          {"‹"}
        </button>
        <span className="menu-pages-counter" aria-live="polite">
          {pageLabel(bounded + 1, pages.length)}
        </span>
        <button
          type="button"
          className="menu-pages-nav"
          onClick={() => goTo(bounded + 1)}
          disabled={pages.length < 2}
          aria-label={nextLabel}
        >
          {"›"}
        </button>
        <span className="menu-pages-zoom-group">
          <button
            type="button"
            className="menu-pages-zoom"
            onClick={() => setZoomStep((step) => Math.max(step - 1, 0))}
            disabled={zoomStep === 0}
            aria-label={zoomOutLabel}
          >
            {"−"}
          </button>
          <button
            type="button"
            className="menu-pages-zoom"
            onClick={() => setZoomStep((step) => Math.min(step + 1, ZOOM_STEPS.length - 1))}
            disabled={zoomStep >= ZOOM_STEPS.length - 1}
            aria-label={zoomInLabel}
          >
            {"+"}
          </button>
        </span>
        <a
          className="menu-pages-fullsize"
          href={current.deliveryUrl}
          target="_blank"
          rel="noreferrer"
        >
          {fullSizeLabel}
        </a>
      </nav>
      <div className="menu-pages-stage">
        <img
          key={current.id}
          className="menu-pages-image"
          src={current.deliveryUrl}
          alt={current.attribution}
          width={current.width}
          height={current.height}
          style={{
            aspectRatio: `${current.width} / ${current.height}`,
            transform: `scale(${zoom})`,
          }}
          loading="lazy"
        />
      </div>
      <p className="menu-pages-attribution">
        {current.sourceName !== null && current.sourceName.length > 0 ? (
          <>
            {"Source: "}
            {current.sourceUrl !== null ? (
              <a href={current.sourceUrl} target="_blank" rel="noreferrer">
                {current.sourceName}
              </a>
            ) : (
              current.sourceName
            )}
            {" · "}
          </>
        ) : null}
        {current.attribution}
        {" · License: "}
        {current.license}
      </p>
      {pages.length > 1 ? (
        <ol className="menu-pages-thumbs" aria-label="All pages">
          {pages.map((page, position) => (
            <li key={page.id}>
              <button
                type="button"
                className={position === bounded ? "menu-pages-thumb is-active" : "menu-pages-thumb"}
                onClick={() => goTo(position)}
                aria-label={`Go to page ${position + 1}`}
                aria-current={position === bounded ? "true" : undefined}
              >
                {position + 1}
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
