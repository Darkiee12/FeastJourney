import { describe, expect, test } from "bun:test";

import { selectMenuHighlights } from "@/modules/restaurant-discovery/menu-presentation";
import type { MenuOffering } from "@/modules/restaurant-discovery/server/operations/discovery";

const itemUnlinkedHigh = "99999999-9999-4999-8999-999999999999";
const itemUnlinkedLow = "11111111-1111-4111-8111-111111111111";
const itemLinkedHigh = "88888888-8888-4888-8888-888888888888";
const itemLinkedLow = "22222222-2222-4222-8222-222222222222";
const variantA = "33333333-3333-4333-8333-333333333333";
const variantB = "77777777-7777-4777-8777-777777777777";

const offering = (overrides: Partial<MenuOffering>): MenuOffering => ({
  menu_id: "44444444-4444-4444-8444-444444444444",
  menu_name: "Main",
  source_language: "vi",
  translation_language: "en",
  translated_name: "Beef noodle soup",
  translated_description: null,
  explanatory_summary: null,
  item_id: itemUnlinkedLow,
  item_name: "Phở bò",
  description: "",
  variant_id: variantA,
  variant_name: "Regular",
  variant_translation_language: "en",
  variant_translated_label: "Regular bowl",
  comparison_key: "regular",
  observation_id: "55555555-5555-4555-8555-555555555555",
  amount: "65000",
  raw_price_text: "65.000đ",
  currency: "VND",
  price_kind: "listed",
  sales_channel: "dine_in",
  tax_treatment: "included",
  observed_at: "2026-10-01T00:00:00.000Z",
  current_enough: true,
  source_category: "menu_photo",
  source_url: null,
  dish_id: null,
  match_kind: null,
  ...overrides,
});

describe("selectMenuHighlights", () => {
  test("empty menu yields empty highlights", () => {
    expect(selectMenuHighlights([])).toEqual([]);
  });

  test("non-positive limits yield empty highlights", () => {
    const rows = [offering({})];

    expect(selectMenuHighlights(rows, 0)).toEqual([]);
    expect(selectMenuHighlights(rows, -2)).toEqual([]);
  });

  test("defaults to three highlights and prefers dish-linked items", () => {
    const rows = [
      offering({ item_id: itemUnlinkedHigh, item_name: "Unlinked high" }),
      offering({ item_id: itemUnlinkedLow, item_name: "Unlinked low" }),
      offering({
        item_id: itemLinkedHigh,
        item_name: "Linked high",
        dish_id: "123",
        match_kind: "exact",
      }),
      offering({
        item_id: itemLinkedLow,
        item_name: "Linked low",
        dish_id: "456",
        match_kind: "variant",
      }),
    ];

    const highlights = selectMenuHighlights(rows);

    expect(highlights).toHaveLength(3);
    expect(highlights.map((highlight) => highlight.id)).toEqual([
      itemLinkedLow,
      itemLinkedHigh,
      itemUnlinkedLow,
    ]);
    expect(highlights.map((highlight) => highlight.dishId)).toEqual(["456", "123", null]);
  });

  test("is deterministic regardless of input row order", () => {
    const rows = [
      offering({ item_id: itemUnlinkedHigh, item_name: "Unlinked high" }),
      offering({
        item_id: itemLinkedHigh,
        item_name: "Linked high",
        dish_id: "123",
        match_kind: "exact",
      }),
      offering({ item_id: itemUnlinkedLow, item_name: "Unlinked low" }),
      offering({
        item_id: itemLinkedLow,
        item_name: "Linked low",
        dish_id: "456",
        match_kind: "variant",
      }),
    ];

    const forward = selectMenuHighlights(rows);
    const reversed = selectMenuHighlights(rows.toReversed());

    expect(reversed).toEqual(forward);
  });

  test("respects explicit limits and reports real variant counts", () => {
    const rows = [
      offering({ item_id: itemLinkedLow, item_name: "Linked", dish_id: "456" }),
      offering({
        item_id: itemLinkedLow,
        item_name: "Linked",
        dish_id: "456",
        variant_id: variantB,
        variant_name: "Large",
      }),
      offering({ item_id: itemUnlinkedLow, item_name: "Plain" }),
    ];

    const [first] = selectMenuHighlights(rows, 1);

    expect(selectMenuHighlights(rows, 1)).toHaveLength(1);
    expect(first?.id).toBe(itemLinkedLow);
    expect(first?.name).toBe("Linked");
    expect(first?.variantCount).toBe(2);
    expect(selectMenuHighlights(rows, 10).map((highlight) => highlight.id)).toEqual([
      itemLinkedLow,
      itemUnlinkedLow,
    ]);
  });

  test("never invents names, prices or images", () => {
    const rows = [
      offering({ item_id: itemLinkedLow, item_name: "Linked", dish_id: "456" }),
      offering({ item_id: itemUnlinkedLow, item_name: "Plain" }),
    ];

    // SAFETY: offering fixtures carry the Reylo-inferred MenuOffering shape; tsc verifies every field against the live DB.
    // oxlint-disable-next-line typescript/no-unsafe-return, typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo; the checker cannot resolve Effect/Reylo generics here
    const names = new Set(rows.map((row) => row.item_name));
    // oxlint-disable-next-line typescript/no-unsafe-return, typescript/no-unsafe-member-access -- tsc-clean under live-DB Reylo; the checker cannot resolve Effect/Reylo generics here
    const ids = new Set(rows.map((row) => row.item_id));

    for (const highlight of selectMenuHighlights(rows, 5)) {
      expect(ids.has(highlight.id)).toBe(true);
      expect(names.has(highlight.name)).toBe(true);
      expect(highlight).not.toHaveProperty("price");
      expect(highlight).not.toHaveProperty("image");
    }
  });
});
