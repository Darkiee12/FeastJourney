import { X } from "lucide-react";

import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import type { RestaurantSearch } from "@/modules/restaurant-discovery/restaurant.schema";

export interface FilterChipsProps {
  readonly copy: RestaurantCopy;
  readonly search: RestaurantSearch;
  readonly dishName: string | null;
  readonly cuisineLabel: string | null;
  readonly onPatch: (patch: Partial<RestaurantSearch>) => void;
}

/** Compact active-filter chips, browse view only. The selected dish renders
 *  as one compact removable chip (`DishName ×`); the return to the Food
 *  Journey dish lives in the overview breadcrumb and the toolbar, never here. */
export function FilterChips({ copy, search, dishName, cuisineLabel, onPatch }: FilterChipsProps) {
  const chips: Array<{
    readonly key: string;
    readonly label: string;
    readonly remove: () => void;
  }> = [];

  if (search.dish !== undefined && dishName !== null) {
    chips.push({
      key: "dish",
      label: dishName,
      remove: () =>
        onPatch({
          dish: undefined,
          portion: undefined,
          budget: undefined,
          currency: undefined,
          sort:
            search.sort === "price_low" || search.sort === "price_high"
              ? "recommended"
              : search.sort,
        }),
    });
  }

  if (search.q !== "") {
    chips.push({ key: "q", label: `“${search.q}”`, remove: () => onPatch({ q: "" }) });
  }

  if (search.cuisine !== "") {
    chips.push({
      key: "cuisine",
      label: copy.cuisineChip.replace("{cuisine}", cuisineLabel ?? search.cuisine),
      remove: () => onPatch({ cuisine: "" }),
    });
  }

  if (search.area !== "") {
    chips.push({
      key: "area",
      label: copy.areaChip.replace("{area}", search.area),
      remove: () => onPatch({ area: "" }),
    });
  }

  if (search.longitude !== undefined) {
    chips.push({
      key: "origin",
      label: copy.withinChip.replace("{radius}", `${search.radius / 1000} km`),
      remove: () =>
        onPatch({
          longitude: undefined,
          latitude: undefined,
          sort: search.sort === "nearest" ? "recommended" : search.sort,
        }),
    });
  }

  if (search.channel !== "dine_in") {
    const channelLabel = search.channel === "takeaway" ? copy.takeaway : copy.delivery;

    chips.push({
      key: "channel",
      label: copy.channelChip.replace("{channel}", channelLabel),
      remove: () => onPatch({ channel: "dine_in" }),
    });
  }

  if (search.portion !== undefined) {
    chips.push({
      key: "portion",
      label: copy.portionChip.replace("{portion}", search.portion.replaceAll("-", " ")),
      remove: () => onPatch({ portion: undefined, budget: undefined }),
    });
  }

  if (search.budget !== undefined && search.currency !== undefined) {
    chips.push({
      key: "budget",
      label: copy.budgetChip
        .replace("{budget}", search.budget)
        .replace("{currency}", search.currency),
      remove: () => onPatch({ budget: undefined, currency: undefined }),
    });
  }

  if (search.sort !== "recommended") {
    let sortLabel = copy.sortPriceHigh;

    if (search.sort === "nearest") {
      sortLabel = copy.sortNearest;
    } else if (search.sort === "price_low") {
      sortLabel = copy.sortPriceLow;
    }

    chips.push({
      key: "sort",
      label: copy.sortChip.replace("{sort}", sortLabel),
      remove: () => onPatch({ sort: "recommended" }),
    });
  }

  if (chips.length === 0) return null;

  return (
    <fieldset className="mapapp-chips">
      <legend className="sr-only">{copy.filters}</legend>
      {chips.map((chip) => (
        <span key={chip.key} className="mapapp-chip">
          <span className="mapapp-chip-label">{chip.label}</span>
          <button
            type="button"
            className="mapapp-chip-x"
            onClick={chip.remove}
            aria-label={
              chip.key === "dish" ? copy.clearDish : `${copy.clearFilters}: ${chip.label}`
            }
          >
            <X aria-hidden="true" />
          </button>
        </span>
      ))}
    </fieldset>
  );
}
