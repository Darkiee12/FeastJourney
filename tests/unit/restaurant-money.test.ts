import { describe, expect, test } from "bun:test";

import {
  menuImportSchema,
  restaurantSearchSchema,
} from "@/modules/restaurant-discovery/restaurant.schema";
import { convertAmount, currencyDigits, formatMoney, isAmount, isCurrency } from "@/shared/money";
import type { ExchangeRate } from "@/shared/money";

// Synthetic rates exercise arithmetic only. They are not market quotes.
const rate = (base: string, quote: string, value: string): ExchangeRate => ({
  base,
  quote,
  rate: value,
  effectiveDate: "2026-10-28",
  provider: "test-fixture",
});

describe("exact food-price arithmetic and presentation", () => {
  test.each([
    ["55000", "VND", "USD", "0.00004", "2.20"],
    ["2.20", "USD", "VND", "25000", "55000"],
    ["1200", "JPY", "VND", "175", "210000"],
    ["1.05", "EUR", "USD", "1.1", "1.16"],
    ["0.1", "USD", "EUR", "0.2", "0.02"],
    ["0", "USD", "JPY", "123.45", "0"],
    ["9007199254740993.01", "USD", "EUR", "1", "9007199254740993.01"],
  ])("converts %s %s to %s exactly", (amount, base, quote, value, expected) => {
    expect(convertAmount(amount, base, quote, rate(base, quote, value))).toBe(expected);
  });
  test("rejects wrong direction, invalid/nonpositive rates and amounts", () => {
    for (const value of ["0", "-1", "NaN", "Infinity", "1e-5"]) {
      expect(() => convertAmount("1", "VND", "USD", rate("VND", "USD", value))).toThrow();
    }

    expect(() => convertAmount("1", "VND", "USD", rate("USD", "VND", "1"))).toThrow();
    expect(() => convertAmount("-1", "USD", "EUR", rate("USD", "EUR", "1"))).toThrow();
  });
  test("uses currency minor digits, including zero and three decimals", () => {
    expect(currencyDigits("VND")).toBe(0);
    expect(currencyDigits("JPY")).toBe(0);
    expect(currencyDigits("USD")).toBe(2);
    expect(currencyDigits("KWD")).toBe(3);
    expect(convertAmount("1.2345", "USD", "KWD", rate("USD", "KWD", "1"))).toBe("1.235");
  });
  test("formats large integer and original fractional precision without Number conversion", () => {
    expect(formatMoney("9007199254740993.01", "USD", "en-US")).toBe("$9,007,199,254,740,993.01");
    expect(formatMoney("1.234", "USD", "en-US")).toBe("$1.234");
    expect(formatMoney("55000", "VND", "vi-VN")).toContain("55.000");
    expect(formatMoney("0.01", "USD", "de-DE")).toContain("0,01");
    expect(formatMoney("1.01", "USD", "ar-EG")).toContain("١٫٠١");
  });
  test("recognizes ISO currencies and rejects invalid values", () => {
    for (const code of ["VND", "USD", "EUR", "GBP", "JPY"]) expect(isCurrency(code)).toBe(true);

    for (const code of ["BTC", "XYZ", "usd", "", "US"]) expect(isCurrency(code)).toBe(false);

    for (const value of ["-1", "NaN", "1e3", " 1", "1,000", "01", "0x10"])
      expect(isAmount(value)).toBe(false);
    expect(isAmount("0")).toBe(true);
  });
});

describe("restaurant HTTP input", () => {
  test("an import cannot claim restaurant verification", () => {
    const result = menuImportSchema.safeParse({
      venueId: crypto.randomUUID(),
      menuName: "Unverified customer photo",
      source: {
        category: "official_menu",
        url: "https://example.com/menu",
        deduplicationKey: "claim",
        restaurantVerified: true,
        observedAt: "2026-01-01T00:00:00Z",
        validUntil: "2027-01-01T00:00:00Z",
      },
      items: [{ name: "Printed dish", variants: [{ name: "As listed" }] }],
    });

    expect(result.success).toBe(false);
  });
  test("browsing needs no user location or AI questionnaire", () => {
    expect(restaurantSearchSchema.safeParse({}).success).toBe(true);
  });
  test("strict comparisons require dish, portion and currency", () => {
    expect(restaurantSearchSchema.safeParse({ budget: "5", currency: "USD" }).success).toBe(false);
    expect(
      restaurantSearchSchema.safeParse({
        dish: "1",
        portion: "regular-bowl",
        budget: "5",
        currency: "USD",
      }).success,
    ).toBe(true);
  });
  test("rejects partial/out-of-range origins and map bounds", () => {
    for (const input of [
      { longitude: 1 },
      { longitude: 190, latitude: 0 },
      { west: 1 },
      { west: 1, east: 2, north: 1, south: 2 },
      { sort: "nearest" },
    ]) {
      expect(restaurantSearchSchema.safeParse(input).success).toBe(false);
    }

    expect(
      restaurantSearchSchema.safeParse({ west: 170, east: -170, south: -10, north: 10 }).success,
    ).toBe(true);
  });
  test("rejects duplicate source food lines and receipt public URLs", () => {
    const variant = {
      name: "Regular",
      price: {
        amount: "0",
        currency: "VND",
        kind: "listed",
        channel: "dine_in",
        taxTreatment: "unknown",
        sourceLineKey: "line-1",
      },
    };

    const input = {
      venueId: crypto.randomUUID(),
      menuName: "Fixture menu",
      source: {
        category: "official_menu",
        url: "https://example.com/menu",
        deduplicationKey: "fixture",
        observedAt: "2026-01-01T00:00:00Z",
        validUntil: "2027-01-01T00:00:00Z",
      },
      items: [{ name: "Fixture food", variants: [variant, variant] }],
    };

    expect(menuImportSchema.safeParse(input).success).toBe(false);
    expect(
      menuImportSchema.safeParse({ ...input, source: { ...input.source, category: "receipt" } })
        .success,
    ).toBe(false);
  });
});
