import { Loader2, MapPin } from "lucide-react";

import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";

/**
 * Presentational empty/loading/error states for the restaurant results list.
 * No data fetching inside: the page resolves its `ResultsState` (see
 * `results-sheet.tsx`) and maps it to a `RestaurantEmptyKind`, then supplies
 * the callbacks. Suggested mapping:
 *
 * - `ResultsState` "no-area"      -> kind "no-venues"
 * - `ResultsState` "no-evidence"  -> kind "no-dish-evidence"
 * - `ResultsState` "no-match"     -> kind "filters-too-restrictive"
 * - `ResultsState` "no-scope"     -> kind "location-required"
 * - `ResultsState` "empty-catalog"-> kind "empty-catalog"
 * - `ResultsState` "loading"      -> kind "loading"
 * - list-level fetch failure      -> kind "error"
 * - basemap tile failure          -> kind "map-tiles-failure"
 *
 * Every kind renders at most one primary (orange) action plus one secondary
 * (outlined) action. The two missing-evidence kinds (`no-venues`,
 * `no-dish-evidence`) may add one tertiary research action when
 * `onResearch` is provided. No other kind offers research: tight filters,
 * loading, and errors never trigger a web-research pass. Display
 * options, price comparison, and sort controls must NOT render here: the
 * coordinator gates those in the page (only with eligible price data or a
 * meaningful choice).
 */
export type RestaurantEmptyKind =
  /** Region has no mapped places. */
  | "no-venues"
  /** Dish filter matches nothing with reviewed evidence. */
  | "no-dish-evidence"
  /** Non-dish filters are too restrictive. */
  | "filters-too-restrictive"
  /** No browsing region established yet. */
  | "location-required"
  /** Nothing recorded in the dataset at all. */
  | "empty-catalog"
  /** Compact loading line. Never fakes a zero count. */
  | "loading"
  /** List-level load failure. */
  | "error"
  /** Basemap tiles failed; the list stays fully usable. */
  | "map-tiles-failure";

export interface RestaurantEmptyStateProps {
  readonly copy: RestaurantCopy;
  readonly kind: RestaurantEmptyKind;
  /**
   * Validated canonical dish display name (from loader data, never free
   * text). Interpolated into the no-dish-evidence title only. Null or blank
   * falls back to the generic reviewed-evidence title so the `{dish}`
   * placeholder is never rendered raw.
   */
  readonly dishName?: string | null | undefined;
  /** Open the city/region chooser. Primary for no-venues, sole action for location-required. */
  readonly onChooseLocation?: (() => void) | undefined;
  /** Widen the search area, preserving the dish constraint. Secondary for no-venues, primary for no-dish-evidence. */
  readonly onSearchWider?: (() => void) | undefined;
  /**
   * Browse all nearby restaurants WITHOUT the dish constraint. Secondary for
   * no-dish-evidence. The body copy states listed places may not serve the
   * dish; the label itself never implies serving.
   */
  readonly onBrowseAll?: (() => void) | undefined;
  /** Open the filter sheet to loosen constraints. Primary for filters-too-restrictive. */
  readonly onAdjustFilters?: (() => void) | undefined;
  /** Reset every filter. Secondary for filters-too-restrictive. */
  readonly onResetFilters?: (() => void) | undefined;
  /** Retry the failed load. Sole action for error. */
  readonly onRetry?: (() => void) | undefined;
  /** Browsed city/area display name for the research hint (`{city}`).
   *  Null or blank falls back to the generic hint so the placeholder is
   *  never rendered raw. */
  readonly cityName?: string | null | undefined;
  /**
   * Start a Muse web-research pass. Offered ONLY for the missing-evidence
   * kinds (`no-venues`, `no-dish-evidence`); never for
   * `filters-too-restrictive`, `error`, or `loading`. Research is a
   * read-only evidence lookup: it never writes venue records.
   */
  readonly onResearch?: (() => void) | undefined;
  /** Research request in flight: the tertiary action shows a busy label and
   *  disables itself until the pass settles. */
  readonly researching?: boolean | undefined;
  /** Explore dishes. Primary for empty-catalog. */
  readonly onExploreDishes?: (() => void) | undefined;
  /** Scan a menu. Secondary for empty-catalog. */
  readonly onScanMenu?: (() => void) | undefined;
}

/** Safe dish interpolation: blank names fall back to the generic title. */
function dishTitleFor(copy: RestaurantCopy, dishName: string | null | undefined): string {
  const name = dishName?.trim() ?? "";

  if (name === "") return copy.noReviewedTitle;

  return copy.emptyNoDishTitle.replace("{dish}", name);
}

/** Safe research hint: city and dish interpolate only when non-blank,
 *  otherwise the generic line renders so no placeholder ever leaks raw. */
function researchHintFor(
  copy: RestaurantCopy,
  cityName: string | null | undefined,
  dishName: string | null | undefined,
): string {
  const city = cityName?.trim() ?? "";
  const dish = dishName?.trim() ?? "";

  if (city !== "" && dish !== "") {
    return copy.researchHintDish.replace("{dish}", dish).replace("{city}", city);
  }

  if (city !== "") {
    return copy.researchHint.replace("{city}", city);
  }

  return copy.researchHintGeneric;
}

export function RestaurantEmptyState({
  copy,
  kind,
  dishName,
  cityName,
  onResearch,
  researching,
  onChooseLocation,
  onSearchWider,
  onBrowseAll,
  onAdjustFilters,
  onResetFilters,
  onRetry,
  onExploreDishes,
  onScanMenu,
}: RestaurantEmptyStateProps) {
  if (kind === "loading") {
    return (
      <output className="mapapp-note">
        <Loader2 aria-hidden="true" className="mapapp-spin size-4" />
        {copy.emptySearching}
      </output>
    );
  }

  if (kind === "map-tiles-failure") {
    return <output className="mapapp-note">{copy.mapLoadFailed}</output>;
  }

  if (kind === "error") {
    return (
      <div className="mapapp-status" role="alert">
        <h3>{copy.emptyErrorTitle}</h3>
        <p>{copy.emptyErrorBody}</p>
        {onRetry === undefined ? null : (
          <div className="mapapp-status-actions">
            <button type="button" className="mapapp-primary-btn" onClick={onRetry}>
              {copy.retryAction}
            </button>
          </div>
        )}
      </div>
    );
  }

  if (kind === "location-required") {
    return (
      <div className="mapapp-status" aria-live="polite">
        <h3>{copy.chooserTitle}</h3>
        <p>{copy.chooserBody}</p>
        {onChooseLocation === undefined ? null : (
          <div className="mapapp-status-actions">
            <button type="button" className="mapapp-primary-btn" onClick={onChooseLocation}>
              <MapPin aria-hidden="true" />
              {copy.regionChoose}
            </button>
          </div>
        )}
      </div>
    );
  }

  if (kind === "no-venues") {
    return (
      <div className="mapapp-status" aria-live="polite">
        <h3>{copy.emptyNoVenuesTitle}</h3>
        <p>{copy.emptyNoVenuesBody}</p>
        {onResearch === undefined ? null : <p>{researchHintFor(copy, cityName, dishName)}</p>}
        <div className="mapapp-status-actions">
          {onChooseLocation === undefined ? null : (
            <button type="button" className="mapapp-primary-btn" onClick={onChooseLocation}>
              <MapPin aria-hidden="true" />
              {copy.emptyChooseLocation}
            </button>
          )}
          {onSearchWider === undefined ? null : (
            <button type="button" className="mapapp-ghost-btn" onClick={onSearchWider}>
              {copy.emptyExploreWider}
            </button>
          )}
          {onResearch === undefined ? null : (
            <button
              type="button"
              className="mapapp-ghost-btn"
              onClick={onResearch}
              disabled={researching === true}
            >
              {researching === true ? copy.researchBusy : copy.researchAction}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (kind === "no-dish-evidence") {
    return (
      <div className="mapapp-status" aria-live="polite">
        <h3>{dishTitleFor(copy, dishName)}</h3>
        <p>{copy.emptyNoDishBody}</p>
        {onResearch === undefined ? null : <p>{researchHintFor(copy, cityName, dishName)}</p>}
        <div className="mapapp-status-actions">
          {onSearchWider === undefined ? null : (
            <button type="button" className="mapapp-primary-btn" onClick={onSearchWider}>
              {copy.emptySearchWider}
            </button>
          )}
          {onBrowseAll === undefined ? null : (
            <button type="button" className="mapapp-ghost-btn" onClick={onBrowseAll}>
              {copy.emptyBrowseAll}
            </button>
          )}
          {onResearch === undefined ? null : (
            <button
              type="button"
              className="mapapp-ghost-btn"
              onClick={onResearch}
              disabled={researching === true}
            >
              {researching === true ? copy.researchBusy : copy.researchAction}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (kind === "filters-too-restrictive") {
    return (
      <div className="mapapp-status" aria-live="polite">
        <h3>{copy.noMatchTitle}</h3>
        <p>{copy.noMatchBody}</p>
        <div className="mapapp-status-actions">
          {onAdjustFilters === undefined ? null : (
            <button type="button" className="mapapp-primary-btn" onClick={onAdjustFilters}>
              {copy.emptyAdjustFilters}
            </button>
          )}
          {onResetFilters === undefined ? null : (
            <button type="button" className="mapapp-ghost-btn" onClick={onResetFilters}>
              {copy.emptyResetFilters}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mapapp-status" aria-live="polite">
      <h3>{copy.emptyDatasetTitle}</h3>
      <p>{copy.emptyDatasetBody}</p>
      <div className="mapapp-status-actions">
        {onExploreDishes === undefined ? null : (
          <button type="button" className="mapapp-primary-btn" onClick={onExploreDishes}>
            {copy.emptyExplore}
          </button>
        )}
        {onScanMenu === undefined ? null : (
          <button type="button" className="mapapp-ghost-btn" onClick={onScanMenu}>
            {copy.emptyScan}
          </button>
        )}
      </div>
    </div>
  );
}
