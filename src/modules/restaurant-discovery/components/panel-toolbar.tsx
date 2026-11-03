import { ArrowLeft } from "lucide-react";

export type PanelToolbarView = "browse" | "overview" | "menu" | "reviews";

/**
 * Single route-aware toolbar for the in-map restaurant panels. Exactly one
 * primary Back exists per view; venue panels render no own back buttons —
 * navigation rides the URL (`venue`/`view`) through `onBack` callbacks owned
 * by the search page, so browser Back, deep links, and refreshes keep working.
 *
 * - browse: `Restaurants · N places` (+ compact dish/radius context beneath
 *   ONLY when relevant). Back appears only when a previous Food Journey
 *   context exists (a dish filter carried `fromDish`); otherwise plain browse.
 * - overview: `← Restaurants | Venue Name` (venue name, no count/toggle).
 * - menu: `← Venue Name` — toolbar carries venue identity only; the menu
 *   language selector stays in the panel header and is never duplicated here.
 * - reviews: `← Venue Name | Reviews`.
 */
export function PanelToolbar({
  view,
  title,
  countLabel,
  contextLine,
  sectionLabel,
  backText,
  backLabel,
  onBack,
}: {
  readonly view: PanelToolbarView;
  readonly title: string;
  readonly countLabel?: string | null | undefined;
  readonly contextLine?: string | null | undefined;
  readonly sectionLabel?: string | null | undefined;
  /** Visible back text; null/undefined renders no Back (plain browse). */
  readonly backText?: string | null | undefined;
  readonly backLabel?: string | undefined;
  readonly onBack?: (() => void) | null | undefined;
}) {
  const showBack =
    onBack !== undefined && onBack !== null && backText !== null && backText !== undefined;

  const backAction = onBack ?? undefined;

  const backName = backLabel ?? backText ?? undefined;

  if (view === "browse") {
    return (
      <div className="mapapp-panel-toolbar" data-view="browse">
        {showBack && (
          <button
            type="button"
            className="mapapp-toolbar-back"
            onClick={backAction}
            aria-label={backName}
          >
            <ArrowLeft aria-hidden="true" />
            {backText}
          </button>
        )}
        <h2 className="mapapp-toolbar-title">
          {countLabel !== null && countLabel !== undefined && countLabel !== ""
            ? `${title} · ${countLabel}`
            : title}
        </h2>
        {contextLine !== null && contextLine !== undefined && contextLine !== "" && (
          <p className="mapapp-toolbar-context">{contextLine}</p>
        )}
      </div>
    );
  }

  return (
    <nav className="mapapp-panel-toolbar" data-view={view} aria-label={title}>
      {showBack && (
        <button
          type="button"
          className="mapapp-toolbar-back"
          onClick={backAction}
          aria-label={backName}
        >
          <ArrowLeft aria-hidden="true" />
          {backText}
        </button>
      )}
      {view === "overview" && <h2 className="mapapp-toolbar-title">{title}</h2>}
      {view === "reviews" && sectionLabel !== null && sectionLabel !== undefined && (
        <h2 className="mapapp-toolbar-title">{sectionLabel}</h2>
      )}
    </nav>
  );
}
