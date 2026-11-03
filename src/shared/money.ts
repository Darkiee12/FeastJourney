import * as BigDecimal from "effect/BigDecimal";

import { currencyMinorUnits } from "@/shared/currencies";

export const isCurrency = (code: string): boolean => currencyMinorUnits.has(code);

export interface ExchangeRate {
  readonly base: string;
  readonly quote: string;
  readonly rate: string;
  readonly effectiveDate: string;
  readonly provider: string;
}

export const currencyDigits = (currency: string): number => {
  if (!isCurrency(currency)) throw new RangeError("Unsupported ISO currency");

  const digits = currencyMinorUnits.get(currency);

  if (digits === undefined) throw new RangeError("Currency minor units are unavailable");

  return digits;
};

/** Decimal tokens only; no exponent or non-finite input can enter money arithmetic. */
export const isAmount = (value: string): boolean =>
  value.length <= 200 && /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(value);

export function convertAmount(
  amount: string,
  base: string,
  quote: string,
  rate: ExchangeRate,
): string {
  if (!isAmount(amount) || rate.base !== base || rate.quote !== quote) {
    throw new RangeError("Invalid amount or exchange-rate direction");
  }

  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(rate.rate) || rate.rate.length > 100) {
    throw new RangeError("Invalid exchange rate");
  }

  const decimalRate = BigDecimal.fromStringUnsafe(rate.rate);

  if (!BigDecimal.isPositive(decimalRate)) throw new RangeError("Exchange rate must be positive");

  const rounded = BigDecimal.round(
    BigDecimal.multiply(BigDecimal.fromStringUnsafe(amount), decimalRate),
    { scale: currencyDigits(quote), mode: "half-from-zero" },
  );

  // format() may choose exponent notation. Explicit coefficient/scale keeps transport plain decimal.
  const fixed = BigDecimal.scale(rounded, currencyDigits(quote));
  const digits = fixed.value.toString().padStart(fixed.scale + 1, "0");

  if (fixed.scale === 0) return digits;

  return `${digits.slice(0, -fixed.scale)}.${digits.slice(-fixed.scale)}`;
}

/** Intl handles currency placement, grouping and numbering systems; amounts never become Number. */
export function formatMoney(amount: string, currency: string, locale: string): string {
  if (!isAmount(amount)) throw new RangeError("Invalid monetary amount");
  const [integer = "0", fraction = ""] = amount.split(".");
  // Preserve every observed decimal, even when the source uses nonstandard currency precision.
  const precision = Math.max(fraction.length, currencyDigits(currency));

  const parts = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).formatToParts(BigInt(integer));

  const localizedFraction = new Intl.NumberFormat(locale, {
    useGrouping: false,
    minimumIntegerDigits: Math.max(1, precision),
  }).format(BigInt(fraction.padEnd(precision, "0") || "0"));

  return parts.map((part) => (part.type === "fraction" ? localizedFraction : part.value)).join("");
}
