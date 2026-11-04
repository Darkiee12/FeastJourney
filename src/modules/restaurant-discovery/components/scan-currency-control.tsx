import { useId, useState, type ReactNode } from "react";

import {
  useExchangeRates,
  usePreferredCurrency,
} from "@/modules/restaurant-discovery/components/currency-tools";
import { scanCurrencyCopy } from "@/modules/restaurant-discovery/components/menu-copy";
import { SearchableCurrencyPicker } from "@/modules/restaurant-discovery/components/searchable-currency-picker";
import { isCurrency } from "@/shared/money";
import type { ExchangeRate } from "@/shared/money";

/**
 * Menu-wide currency conversion state for one scanned menu. Reuses the
 * existing preference + FX infrastructure verbatim:
 *
 * - preference: `usePreferredCurrency()` — member account preference via
 *   `currencyPreferenceFn`/`saveCurrencyPreferenceFn`, guest via the
 *   `feastjourney.currency` localStorage key. No new key, no new table.
 * - rates: `useExchangeRates()` — one shared cached request for the deduped
 *   source currencies, never one request per dish, never a direct FX call.
 *
 * Presentation-only visibility: unchecking the box hides conversions without
 * clearing the saved global preference. A scanner-only checkbox must never
 * erase an account choice, and a guest choice never overwrites a member
 * preference on sign-in (both guaranteed by the reused hook).
 */
export interface ScanCurrencyState {
  readonly target: string;
  readonly codes: ReadonlyArray<string>;
  readonly catalogUnavailable: boolean;
  readonly enabled: boolean;
  readonly loading: boolean;
  readonly unavailable: boolean;
  readonly rates: ReadonlyMap<string, ExchangeRate>;
  readonly rateDates: ReadonlyArray<string>;
  readonly allSameCurrency: boolean;
  readonly setEnabled: (enabled: boolean) => void;
  readonly choose: (code: string) => void;
}

export function useScanCurrency(sources?: ReadonlyArray<string | null>): ScanCurrencyState {
  const preference = usePreferredCurrency();
  // Unchecked = hidden conversions only. The saved preference (member
  // account or guest localStorage) is never cleared by this toggle.
  const [suspended, setSuspended] = useState(false);
  const target = preference.currency;
  const enabled = target !== "" && !suspended;

  const bases = (sources ?? [])
    .filter((code): code is string => code !== null && isCurrency(code) && code !== target)
    .filter((code, index, all) => all.indexOf(code) === index)
    .toSorted();

  const { rates, unavailable, loading } = useExchangeRates(bases, enabled ? target : "");

  const rateDates: Array<string> = [];

  for (const rate of rates.values()) {
    if (!rateDates.includes(rate.effectiveDate)) rateDates.push(rate.effectiveDate);
  }

  rateDates.sort();

  const distinctSources = [...new Set(sources ?? [])].filter(
    (code): code is string => code !== null && isCurrency(code),
  );

  const allSameCurrency =
    enabled && distinctSources.length > 0 && distinctSources.every((code) => code === target);

  return {
    target,
    codes: preference.codes,
    catalogUnavailable: preference.unavailable,
    enabled,
    loading: enabled && loading,
    unavailable: enabled && unavailable,
    rates: enabled ? rates : new Map(),
    rateDates,
    allSameCurrency,
    setEnabled: (next: boolean) => setSuspended(!next),
    choose: (code: string) => {
      if (!isCurrency(code)) return;

      setSuspended(false);
      preference.change(code);
    },
  };
}

const controlStateId = (id: string): string => `${id}-currency-control`;

/**
 * One menu-wide currency control for the scan results header. Checkbox +
 * the reused `SearchableCurrencyPicker` (never a native select): the picker
 * appears when the box is checked without a saved preference, or when the
 * traveler edits the currency.
 *
 * Props are all optional — the control reads preference/FX through the
 * existing hooks and works mounted bare inside the scan-results header.
 * `sources` (distinct source currencies on the menu) only drives the
 * already-in-target note; conversion rendering reads rates per price.
 *
 * Exactly one polite live region announces conversion status per update —
 * rows and dishes never add their own conversion announcements.
 */
export function ScanCurrencyControl({
  sources,
  locale,
  state,
}: {
  readonly sources?: ReadonlyArray<string | null>;
  readonly locale?: string;
  readonly state?: ScanCurrencyState;
}): ReactNode {
  const resolved = locale ?? "en";
  const copy = scanCurrencyCopy(resolved);
  const fallback = useScanCurrency(sources);
  const currency = state ?? fallback;
  const checkboxId = useId();
  const [pickerOpen, setPickerOpen] = useState(false);

  // Checking the box with no saved preference reveals the picker first;
  // the box reads checked while the traveler is choosing.
  const checked = currency.enabled || pickerOpen;

  const toggle = (next: boolean): void => {
    if (next && currency.target === "") {
      setPickerOpen(true);

      return;
    }

    setPickerOpen(false);
    currency.setEnabled(next);
  };

  return (
    <div className="scan-currency" id={controlStateId(checkboxId)}>
      <label htmlFor={checkboxId} className="scan-currency-check">
        <input
          id={checkboxId}
          type="checkbox"
          checked={checked}
          onChange={(event) => toggle(event.target.checked)}
        />
        {copy.showInMyCurrency}
      </label>
      {currency.enabled && currency.target !== "" && !pickerOpen ? (
        <button
          type="button"
          className="scan-currency-change"
          onClick={() => setPickerOpen(true)}
          aria-label={`${copy.changeCurrency}: ${currency.target}`}
        >
          {currency.target}
        </button>
      ) : null}
      {pickerOpen ? (
        <SearchableCurrencyPicker
          value={currency.target}
          codes={currency.codes}
          locale={resolved}
          label={copy.pickCurrency}
          placeholder={copy.pickCurrency}
          unavailableNote={currency.catalogUnavailable ? copy.ratesUnavailable : undefined}
          onChange={(code) => {
            currency.choose(code);
            setPickerOpen(false);
          }}
        />
      ) : null}
      <p aria-live="polite" className="scan-currency-status">
        {currency.enabled && currency.allSameCurrency
          ? copy.alreadyDisplayedIn.replace("{currency}", currency.target)
          : null}
        {currency.enabled && !currency.allSameCurrency && currency.loading
          ? copy.ratesLoading
          : null}
        {currency.enabled && !currency.allSameCurrency && currency.unavailable
          ? copy.ratesUnavailable
          : null}
      </p>
    </div>
  );
}
