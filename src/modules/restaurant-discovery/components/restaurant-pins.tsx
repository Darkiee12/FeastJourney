import type { ReactElement } from "react";

/** Restaurant pin visual contract: red teardrop, white stroke + cutout.
 *  Never render numeric rank badges inside pins. */
export const RESTAURANT_PIN_FILL = "#E53935";

export const RESTAURANT_PIN_CUTOUT = "#FFFFFF";

/** Glyph box edge in px; the button keeps a 44px pointer target around it. */
export const RESTAURANT_PIN_GLYPH_PX = 38;

/** Unselected glyph renders at ~30px inside the shared 38px box; the
 *  selected glyph fills it (~38px). Sizing animates via CSS transform. */
export const RESTAURANT_PIN_SELECTED_PX = 38;

export const RESTAURANT_PIN_REST_PX = 30;

export function isPinSelected(pointId: string, selectedId: string | null): boolean {
  return selectedId !== null && pointId === selectedId;
}

export function restaurantPinClassName(selected: boolean): string {
  return selected ? "restaurant-pin is-selected" : "restaurant-pin";
}

/** Accessible name shared by the map pin and its list card target. */
export function restaurantPinLabel(name: string): string {
  return `Show ${name}`;
}

export function RestaurantPinGlyph(): ReactElement {
  return (
    <svg
      viewBox="0 0 32 44"
      width={RESTAURANT_PIN_GLYPH_PX}
      height={RESTAURANT_PIN_GLYPH_PX}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M16 2 C8.8 2 3 7.8 3 15 C3 24.5 16 42 16 42 C16 42 29 24.5 29 15 C29 7.8 23.2 2 16 2 Z"
        fill={RESTAURANT_PIN_FILL}
        stroke={RESTAURANT_PIN_CUTOUT}
        strokeWidth={2}
      />
      <circle cx="16" cy="15" r="5.5" fill={RESTAURANT_PIN_CUTOUT} />
    </svg>
  );
}

export function RestaurantPinButton({
  name,
  selected,
  onSelect,
}: {
  name: string;
  selected: boolean;
  onSelect: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className={restaurantPinClassName(selected)}
      aria-pressed={selected}
      aria-label={restaurantPinLabel(name)}
      onClick={onSelect}
    >
      <RestaurantPinGlyph />
      {/* Visual name flag for the selected/hovered pin; positioned outside
          the button box so the marker's bottom anchor never shifts. The
          accessible name stays on aria-label. */}
      <span className="restaurant-pin-flag" aria-hidden="true">
        {name}
      </span>
    </button>
  );
}
