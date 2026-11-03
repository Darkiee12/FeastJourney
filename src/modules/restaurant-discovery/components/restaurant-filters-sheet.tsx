import { MapPin, UtensilsCrossed, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { SharedSelectField } from "@/components/ui/select";
import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import { SearchableCurrencyPicker } from "@/modules/restaurant-discovery/components/searchable-currency-picker";
import type { restaurantFacetsFn } from "@/modules/restaurant-discovery/restaurant.functions";
import type { RestaurantSearch } from "@/modules/restaurant-discovery/restaurant.schema";

const RADII = [1000, 5000, 10000, 25000, 50000] as const;

/** Sentinel for the explicit "All cuisines" option: Radix treats an empty
 *  string value as "no selection" (placeholder), so the all-entry needs a
 *  non-empty key that maps back to "". */
const CUISINE_ALL = "__all";

function humanizePortion(key: string): string {
  return key
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/^\p{L}/u, (first) => first.toLocaleUpperCase());
}

function clearDishPatch(search: RestaurantSearch): Partial<RestaurantSearch> {
  return {
    dish: undefined,
    portion: undefined,
    budget: undefined,
    currency: undefined,
    sort: search.sort === "price_low" || search.sort === "price_high" ? "recommended" : search.sort,
  };
}

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
  /** Compact dish-chip label. Coordinator wiring: pass the verified dish
   *  name; until then the chip falls back to the remove-filter copy. */
  readonly dishName?: string | null | undefined;
  /** Coordinator wiring: pass the page-level clearDish when available so
   *  the chip clears through the same path as the results sheet. */
  readonly onClearDish?: (() => void) | undefined;
  /** Eligible price currencies (comparable ranges) for common-first order. */
  readonly priceCurrencies?: ReadonlyArray<string> | undefined;
  /** Currently displayed currency, pinned first when supported. */
  readonly displayCurrency?: string | undefined;
  /** BCP-47 locale for currency names. Defaults to the runtime locale. */
  readonly locale?: string | undefined;
}

/** Compact left-reference filter sheet. Order: cuisine → dining options →
 *  distance → sort → serving size → max price + currency. Price comparison
 *  only appears when a canonical dish is selected and comparable servings
 *  exist; the backend restriction is untouched. Show results acts as
 *  Done/close — the single onApply navigation is the only request. */
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
  dishName,
  onClearDish,
  priceCurrencies,
  displayCurrency,
  locale,
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

  // A radius only means something with a geographic center. Bounds searches
  // follow the map area instead — never show a fake radius there.
  const hasCenter = search.longitude !== undefined && search.latitude !== undefined;
  const hasBounds = search.west !== undefined;

  const portionOptions = portions.filter((entry) => entry.comparison_key !== null);

  // Price comparison is meaningful only for a canonical dish with comparable
  // servings; price sorts additionally need a chosen portion + currency.
  const priceMeaningful = dishActive && portionOptions.length > 0;
  const canPriceSort = priceMeaningful && portion !== "" && currency !== "";

  const sortInvalid =
    (sort === "nearest" && !canSortNearest) ||
    ((sort === "price_low" || sort === "price_high") && !canPriceSort);

  const effectiveSort = sortInvalid ? "recommended" : sort;

  const clearDish = () => {
    if (onClearDish !== undefined) {
      onOpenChange(false);
      onClearDish();

      return;
    }

    setPortion("");
    setBudget("");
    setCurrency("");

    if (sort === "price_low" || sort === "price_high") setSort("recommended");

    onOpenChange(false);
    onApply(clearDishPatch(search));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onOpenChange(false);
    onApply({
      cuisine,
      channel,
      sort: effectiveSort,
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
        <Dialog.Content
          className="res-sheet rf-sheet"
          onEscapeKeyDown={(event) => {
            // The currency picker's own list closes itself on Escape (and
            // restores trigger focus); veto the sheet dismissal while it is
            // open. Radix listens in the capture phase, so target-level
            // stopPropagation in the picker can never win — this veto is the
            // supported mechanism.
            if (document.querySelector(".rf-currency-panel") !== null) event.preventDefault();
          }}
        >
          <div className="rf-head">
            <Dialog.Title className="rf-title">{copy.filtersTitle}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label={copy.filtersClose} className="rf-icon-btn">
                <X aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          <form onSubmit={submit} className="rf-form">
            <div className="rf-scroll">
              {dishActive ? (
                <button
                  type="button"
                  className="rf-chip"
                  onClick={clearDish}
                  aria-label={copy.clearDish}
                >
                  <span aria-hidden="true">🍜</span>
                  <span className="rf-chip-label">{dishName ?? copy.clearDish}</span>
                  <X aria-hidden="true" className="rf-chip-x" />
                </button>
              ) : null}
              <fieldset className="rf-field">
                <SharedSelectField
                  id="sheet-cuisine"
                  label={copy.cuisine}
                  value={cuisine === "" ? CUISINE_ALL : cuisine}
                  onValueChange={(next) => setCuisine(next === CUISINE_ALL ? "" : next)}
                  options={[
                    { value: CUISINE_ALL, label: copy.cuisineAll },
                    ...cuisines.map((entry) => ({
                      value: entry.slug,
                      label: entry.displayName ?? entry.slug,
                    })),
                  ]}
                  size="regular"
                  contentClassName="z-[60]"
                  leadingIcon={<UtensilsCrossed aria-hidden="true" className="rf-leading" />}
                />
              </fieldset>
              <fieldset className="rf-field">
                <legend className="rf-label">{copy.diningOptions}</legend>
                <div className="rf-seg">
                  {(
                    [
                      ["dine_in", copy.dineIn],
                      ["takeaway", copy.takeaway],
                      ["delivery", copy.delivery],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={channel === value}
                      className="rf-seg-btn"
                      onClick={() => setChannel(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </fieldset>
              {hasCenter ? (
                <fieldset className="rf-field">
                  <SharedSelectField
                    id="sheet-radius"
                    label={copy.distance}
                    value={String(radius)}
                    onValueChange={(next) => setRadius(Number(next))}
                    options={RADII.map((value) => ({
                      value: String(value),
                      label: value >= 1000 ? `${value / 1000} km` : `${value} m`,
                    }))}
                    size="regular"
                    contentClassName="z-[60]"
                    leadingIcon={<MapPin aria-hidden="true" className="rf-leading" />}
                  />
                </fieldset>
              ) : null}
              {!hasCenter && hasBounds ? (
                <div className="rf-field">
                  <span className="rf-label">{copy.distance}</span>
                  <p className="rf-hint">{copy.mapRegionBounds}</p>
                </div>
              ) : null}
              <fieldset className="rf-field">
                <legend className="rf-label">{copy.sortLabel}</legend>
                <div className="rf-seg rf-seg-grid" role="radiogroup" aria-label={copy.sortLabel}>
                  {(
                    [
                      ["recommended", copy.sortRecommended, false],
                      ["nearest", copy.sortNearest, !canSortNearest],
                      ["price_low", copy.sortPriceLow, !canPriceSort],
                      ["price_high", copy.sortPriceHigh, !canPriceSort],
                    ] as const
                  ).map(([value, label, disabled]) => (
                    <label
                      key={value}
                      data-checked={effectiveSort === value}
                      data-disabled={disabled}
                      className="rf-radio"
                    >
                      <input
                        type="radio"
                        name="sort"
                        value={value}
                        checked={effectiveSort === value}
                        disabled={disabled}
                        onChange={() => setSort(value)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              {priceMeaningful ? (
                <fieldset className="rf-field">
                  <SharedSelectField
                    id="sheet-portion"
                    label={copy.servingSize}
                    description={copy.servingSizeHint}
                    value={portion === "" ? undefined : portion}
                    onValueChange={setPortion}
                    options={portionOptions.map((entry) => ({
                      value: entry.comparison_key ?? "",
                      label: humanizePortion(entry.comparison_key ?? ""),
                    }))}
                    placeholder={copy.servingSize}
                    size="regular"
                    contentClassName="z-[60]"
                  />
                </fieldset>
              ) : null}
              {priceMeaningful ? (
                <div className="rf-field">
                  <div className="rf-price-row">
                    <div className="rf-subfield">
                      <label htmlFor="sheet-budget" className="rf-label">
                        {copy.maxPrice}
                      </label>
                      <input
                        id="sheet-budget"
                        className="rf-input"
                        inputMode="decimal"
                        pattern="[0-9]+([.][0-9]+)?"
                        value={budget}
                        onChange={(event) => setBudget(event.target.value)}
                      />
                    </div>
                    <div className="rf-subfield">
                      <span className="rf-label">{copy.yourCurrency}</span>
                      <SearchableCurrencyPicker
                        value={currency}
                        codes={currencyCodes}
                        common={[
                          ...(displayCurrency === undefined ? [] : [displayCurrency]),
                          ...(search.currency === undefined ? [] : [search.currency]),
                          ...(priceCurrencies ?? []),
                        ]}
                        locale={locale}
                        label={copy.yourCurrency}
                        placeholder="—"
                        onChange={setCurrency}
                      />
                    </div>
                  </div>
                  <p className="rf-hint">{copy.priceNote}</p>
                </div>
              ) : (
                <p className="rf-hint">{dishActive ? copy.priceNote : copy.selectDishFirst}</p>
              )}
            </div>
            <div className="rf-foot">
              <button type="button" className="res-ghost rf-btn" onClick={onClear}>
                {copy.clearFilters}
              </button>
              <button type="submit" className="res-primary rf-btn">
                {copy.applyFilters}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
