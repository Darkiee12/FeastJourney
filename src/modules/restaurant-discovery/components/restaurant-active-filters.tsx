import { ArrowLeft, ChevronDown, X } from "lucide-react";

import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";

/**
 * Compact presentational filter strip for the restaurant results list. No
 * data fetching inside: the page derives every label from its validated
 * search state and supplies the callbacks.
 *
 * - Dish chip (`dishName` + X): the X removes the dish filter ONLY (the page
 *   also clears dependent portion/budget/currency/sort state). Back
 *   navigation is a separate standalone control, never part of the chip.
 * - Radius chip (`radiusLabel` + chevron): a button that OPENS the existing
 *   radius options (the filter sheet). It is never a disposable X.
 * - `extraChips`: minimal other single-removal chips (cuisine, channel, ...).
 *   Keep this list short; advanced options live in the filter sheet.
 *
 * The strip renders no headings, area labels, or result counts: the page
 * owns those, so dish/area/count must not repeat in adjacent headers.
 * Renders null when nothing is active.
 */
export interface RestaurantExtraChip {
  readonly key: string;
  readonly label: string;
  readonly onRemove: () => void;
  /** Accessible name for the remove button. Defaults to "{clearFilters}: {label}". */
  readonly removeLabel?: string | undefined;
}

export interface RestaurantActiveFiltersProps {
  readonly copy: RestaurantCopy;
  /**
   * Validated canonical dish display name. Null hides the dish chip and the
   * Back control.
   */
  readonly dishName: string | null;
  /**
   * Radius button label, e.g. "5 km". Null hides the radius chip. The page
   * formats the number; this component renders it verbatim.
   */
  readonly radiusLabel: string | null;
  /** Minimal extra single-removal chips. Empty or omitted hides the group. */
  readonly extraChips?: ReadonlyArray<RestaurantExtraChip> | undefined;
  /**
   * Back to the canonical dish/journey. Rendered as a standalone control
   * next to (never inside) the dish chip. Omitted hides the control.
   */
  readonly onBack?: (() => void) | undefined;
  /** Remove ONLY the dish filter. Omitted renders the dish chip without an X. */
  readonly onRemoveDish?: (() => void) | undefined;
  /** Open the existing radius options (filter sheet). Omitted renders the radius chip without an opener. */
  readonly onRadiusOpen?: (() => void) | undefined;
}

export function RestaurantActiveFilters({
  copy,
  dishName,
  radiusLabel,
  extraChips,
  onBack,
  onRemoveDish,
  onRadiusOpen,
}: RestaurantActiveFiltersProps) {
  const extras = extraChips ?? [];

  if (dishName === null && radiusLabel === null && extras.length === 0) return null;

  const showBack = dishName !== null && onBack !== undefined;

  return (
    <fieldset className="mapapp-chips">
      <legend className="sr-only">{copy.filters}</legend>
      {showBack && (
        <button type="button" className="mapapp-chip-link" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {copy.backToDish}
        </button>
      )}
      {dishName !== null && (
        <span className="mapapp-chip-dish">
          <span className="mapapp-chip-label">
            <span aria-hidden="true">🍽 </span>
            {dishName}
          </span>
          {onRemoveDish === undefined ? null : (
            <button
              type="button"
              className="mapapp-chip-x"
              onClick={onRemoveDish}
              aria-label={copy.clearDish}
            >
              <X aria-hidden="true" />
            </button>
          )}
        </span>
      )}
      {radiusLabel !== null &&
        (onRadiusOpen === undefined ? (
          <span className="mapapp-chip">
            <span className="mapapp-chip-label">
              <span aria-hidden="true">📍 </span>
              {radiusLabel}
            </span>
          </span>
        ) : (
          <button
            type="button"
            className="mapapp-chip"
            onClick={onRadiusOpen}
            aria-label={`${copy.radiusChange}: ${radiusLabel}`}
          >
            <span aria-hidden="true">📍 </span>
            <span className="mapapp-chip-label">{radiusLabel}</span>
            <ChevronDown aria-hidden="true" className="size-4 flex-none" />
          </button>
        ))}
      {extras.map((chip) => (
        <span key={chip.key} className="mapapp-chip">
          <span className="mapapp-chip-label">{chip.label}</span>
          <button
            type="button"
            className="mapapp-chip-x"
            onClick={chip.onRemove}
            aria-label={chip.removeLabel ?? `${copy.clearFilters}: ${chip.label}`}
          >
            <X aria-hidden="true" />
          </button>
        </span>
      ))}
    </fieldset>
  );
}
