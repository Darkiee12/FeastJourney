import { BigDecimal } from "effect";

import type { MenuScanDocument } from "@/modules/restaurant-discovery/menu-scan.schema";
import { amountSchema } from "@/modules/restaurant-discovery/restaurant.schema";
import { isCurrency } from "@/shared/money";

type ScanPrice = NonNullable<MenuScanDocument["items"][number]["variants"][number]["price"]>;

/** Recover clear numeric notation without inventing a currency or item association. */
export function interpretPrintedPrice(
  price: ScanPrice,
  menuCountry: string | null = null,
): ScanPrice {
  const [notation = "", ...qualifiers] = price.rawText.trim().split("/");
  const printedCurrencies = new Set((notation.match(/\b[A-Z]{3}\b/g) ?? []).filter(isCurrency));

  const symbols: ReadonlyMap<string, string> = new Map([
    ["đ", "VND"],
    ["₫", "VND"],
    ["€", "EUR"],
    ["₹", "INR"],
  ]);

  for (const [symbol, code] of symbols) {
    if (notation.includes(symbol)) printedCurrencies.add(code);
  }

  const [printedCurrency] = printedCurrencies;
  const explicitVnd = printedCurrencies.size === 1 && printedCurrency === "VND";

  const numberText = notation
    .replace(/\b[A-Z]{3}\b/g, (token) => (isCurrency(token) ? "" : token))
    .replace(/[đ₫€£₹₩$¥￥]/gu, "")
    .trim();

  let amount = price.amount;
  const shorthand = /^(\d+)(?:\.(\d{1,2}))?\s*[kK]$/.exec(numberText);

  if (amount === null && shorthand !== null) {
    const integer = shorthand[1];

    if (integer !== undefined) {
      const value = BigDecimal.multiply(
        BigDecimal.fromStringUnsafe(`${integer}.${shorthand[2] ?? "0"}`),
        BigDecimal.fromBigInt(1000n),
      );

      amount = BigDecimal.scale(value, 0).value.toString();
    }
  } else if (
    amount === null &&
    ((explicitVnd && /^\d{1,3}(?:\.\d{3})+$/.test(numberText)) ||
      (printedCurrency !== undefined &&
        /^(?:\d{1,3}(?:,\d{3}){2,}|\d{1,3}(?:\.\d{3}){2,})$/.test(numberText)) ||
      (printedCurrency !== undefined &&
        ["USD", "GBP", "VND", "KRW", "INR"].includes(printedCurrency) &&
        /^\d{1,3}(?:,\d{3})+$/.test(numberText)))
  ) {
    amount = numberText.replaceAll(/[.,]/g, "");
  } else if (amount === null && /^\d+(?:\.\d{1,2})?$/.test(numberText)) {
    amount = numberText;
  } else if (amount === null && /^\d+,\d{1,2}$/.test(numberText)) {
    amount = numberText.replace(",", ".");
  }

  if (amount !== null && !amountSchema.safeParse(amount).success) amount = null;
  let currency = price.currency;
  let currencyProvenance = price.currencyProvenance;

  if (printedCurrencies.size > 1) {
    currency = null;
    currencyProvenance = "unknown";
  } else if (
    currency === null &&
    printedCurrency !== undefined &&
    /^[\d.,\s]+[kK]?$/.test(numberText)
  ) {
    currency = printedCurrency;
    currencyProvenance = "printed";
  } else if (
    currency === null &&
    menuCountry === "VN" &&
    shorthand !== null &&
    !/[$¥￥]/u.test(notation)
  ) {
    currency = "VND";
    currencyProvenance = "inferred";
  }

  return {
    ...price,
    amount,
    currency,
    currencyProvenance,
    unit: price.unit ?? (qualifiers.length === 1 ? (qualifiers[0]?.trim() ?? null) : null),
  };
}
