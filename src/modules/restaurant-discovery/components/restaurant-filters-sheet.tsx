import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import type { restaurantFacetsFn } from "@/modules/restaurant-discovery/restaurant.functions";
import type { RestaurantSearch } from "@/modules/restaurant-discovery/restaurant.schema";

const RADII = [1000, 5000, 10000, 25000, 50000] as const;

interface FiltersSheetProps {
  readonly copy: RestaurantCopy;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly search: RestaurantSearch;
  readonly cuisines: Awaited<ReturnType<typeof restaurantFacetsFn>>;
  readonly portions: ReadonlyArray<{ comparison_key: string | null }>;
  readonly currencyCodes: ReadonlyArray<string>;
  readonly dishActive: boolean;
  readonly canSortNearest: boolean;
  readonly onApply: (values: Partial<RestaurantSearch>) => void;
  readonly onClear: () => void;
}

/** Advanced search options behind one button. Price comparison only
 *  appears when a dish is selected; otherwise it explains itself. */
export function RestaurantFiltersSheet({
  copy,
  open,
  onOpenChange,
  search,
  cuisines,
  portions,
  currencyCodes,
  dishActive,
  canSortNearest,
  onApply,
  onClear,
}: FiltersSheetProps) {
  const [cuisine, setCuisine] = useState(search.cuisine);
  const [channel, setChannel] = useState(search.channel);
  const [sort, setSort] = useState(search.sort);
  const [radius, setRadius] = useState(search.radius);
  const [portion, setPortion] = useState(search.portion ?? "");
  const [budget, setBudget] = useState(search.budget ?? "");
  const [currency, setCurrency] = useState(search.currency ?? "");
  const openerRef = useRef<Element | null>(null);

  // Radix does not reliably return focus to the trigger in this tree
  // (the admin dialog keeps the same manual restore), so remember the
  // opener while the sheet is up and restore it on close.
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    openerRef.current = document.activeElement;

    return () => {
      const opener = openerRef.current;

      openerRef.current = null;

      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [open]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onOpenChange(false);
    onApply({
      cuisine,
      channel,
      sort,
      radius,
      portion: portion === "" ? undefined : portion,
      budget: budget === "" ? undefined : budget,
      currency: currency === "" ? undefined : currency,
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal>
      <Dialog.Portal>
        <Dialog.Overlay className="res-sheet-overlay" />
        <Dialog.Content className="res-sheet">
          <div className="res-sheet-head">
            <Dialog.Title className="res-sheet-title">{copy.filtersTitle}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label={copy.filtersClose} className="res-icon-btn">
                <X aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          <form onSubmit={submit} className="res-sheet-body">
            {dishActive && (
              <div className="res-field">
                <p className="res-hint">{copy.dishEvidence}</p>
                <button
                  type="button"
                  className="res-ghost"
                  onClick={() => {
                    setPortion("");
                    setBudget("");
                    setCurrency("");
                    onOpenChange(false);
                    onApply({
                      dish: undefined,
                      portion: undefined,
                      budget: undefined,
                      currency: undefined,
                      sort:
                        search.sort === "price_low" || search.sort === "price_high"
                          ? "recommended"
                          : search.sort,
                    });
                  }}
                >
                  {copy.clearDish}
                </button>
              </div>
            )}
            <div className="res-field">
              <label htmlFor="sheet-cuisine">{copy.cuisine}</label>
              <select
                id="sheet-cuisine"
                value={cuisine}
                onChange={(event) => setCuisine(event.target.value)}
              >
                <option value="">{copy.cuisineAll}</option>
                {cuisines.map((entry) => (
                  <option key={entry.slug} value={entry.slug}>
                    {entry.displayName ?? entry.slug}
                  </option>
                ))}
              </select>
            </div>
            <fieldset className="res-field">
              <legend>{copy.diningOptions}</legend>
              <div className="res-seg" role="radiogroup" aria-label={copy.diningOptions}>
                {(
                  [
                    ["dine_in", copy.dineIn],
                    ["takeaway", copy.takeaway],
                    ["delivery", copy.delivery],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} data-checked={channel === value}>
                    <input
                      type="radio"
                      name="channel"
                      value={value}
                      checked={channel === value}
                      onChange={() => setChannel(value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="res-field">
              <label htmlFor="sheet-radius">{copy.distance}</label>
              <select
                id="sheet-radius"
                value={radius}
                onChange={(event) => setRadius(Number(event.target.value))}
              >
                {RADII.map((value) => (
                  <option key={value} value={value}>
                    {value >= 1000 ? `${value / 1000} km` : `${value} m`}
                  </option>
                ))}
              </select>
            </div>
            <fieldset className="res-field">
              <legend>{copy.sortLabel}</legend>
              <div className="res-seg res-seg-col" role="radiogroup" aria-label={copy.sortLabel}>
                {(
                  [
                    ["recommended", copy.sortRecommended, false],
                    ["nearest", copy.sortNearest, !canSortNearest],
                    ["price_low", copy.sortPriceLow, !dishActive],
                    ["price_high", copy.sortPriceHigh, !dishActive],
                  ] as const
                ).map(([value, label, disabled]) => (
                  <label key={value} data-checked={sort === value} data-disabled={disabled}>
                    <input
                      type="radio"
                      name="sort"
                      value={value}
                      checked={sort === value}
                      disabled={disabled}
                      onChange={() => setSort(value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            {dishActive ? (
              <fieldset className="res-field">
                <legend>{copy.servingSize}</legend>
                <p className="res-hint">{copy.servingSizeHint}</p>
                <label htmlFor="sheet-portion" className="sr-only">
                  {copy.servingSize}
                </label>
                <select
                  id="sheet-portion"
                  value={portion}
                  onChange={(event) => setPortion(event.target.value)}
                >
                  <option value="">{copy.servingSize}</option>
                  {portions.map((entry) => (
                    <option key={entry.comparison_key ?? ""} value={entry.comparison_key ?? ""}>
                      {(entry.comparison_key ?? "").replaceAll("-", " ")}
                    </option>
                  ))}
                </select>
                <div className="res-price-row">
                  <div>
                    <label htmlFor="sheet-budget">{copy.maxPrice}</label>
                    <input
                      id="sheet-budget"
                      inputMode="decimal"
                      pattern="[0-9]+([.][0-9]+)?"
                      value={budget}
                      onChange={(event) => setBudget(event.target.value)}
                    />
                  </div>
                  <div>
                    <label htmlFor="sheet-currency">{copy.yourCurrency}</label>
                    <select
                      id="sheet-currency"
                      value={currency}
                      onChange={(event) => setCurrency(event.target.value)}
                    >
                      <option value="">—</option>
                      {currencyCodes.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <p className="res-hint">{copy.priceNote}</p>
              </fieldset>
            ) : (
              <p className="res-hint">{copy.selectDishFirst}</p>
            )}
            <div className="res-sheet-foot">
              <button type="button" className="res-ghost" onClick={onClear}>
                {copy.clearFilters}
              </button>
              <button type="submit" className="res-primary">
                {copy.applyFilters}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
