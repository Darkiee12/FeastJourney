import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { menuCopy } from "@/modules/restaurant-discovery/components/menu-copy";
import { WaiterOrderCard } from "@/modules/restaurant-discovery/components/waiter-order-card";
import type {
  InteractiveMenu,
  MenuSelection,
} from "@/modules/restaurant-discovery/menu-presentation";

const menu = (
  price: { rawText: string; amount: string; currency: string } | null,
): InteractiveMenu => ({
  venueName: "Quán Phở Thật",
  sourceLanguage: "vi",
  targetLanguage: "en",
  introduction: {
    original: "Cho chúng tôi gọi các món sau.",
    translated: "We would like to order the following, please.",
  },
  provenance: "reviewed",
  items: [
    {
      id: "item-1",
      section: null,
      originalName: "Phở bò",
      translatedName: "Beef noodle soup",
      originalDescription: null,
      translatedDescription: null,
      explanatorySummary: null,
      uncertainties: [],
      assetIds: [],
      dishId: null,
      variants: [
        {
          id: "var-1",
          originalLabel: "Tô thường",
          translatedLabel: "Regular bowl",
          price: price === null ? null : { ...price, taxTreatment: "included" },
          provenance: "Reviewed listed menu price",
          sourceUrl: null,
        },
        {
          id: "var-2",
          originalLabel: "Tô đặc biệt",
          translatedLabel: "Special bowl",
          price: price === null ? null : { ...price, taxTreatment: "included" },
          provenance: "Reviewed listed menu price",
          sourceUrl: null,
        },
      ],
    },
  ],
});

const priced = { rawText: "65.000đ", amount: "65000", currency: "VND" };

const selectionWithNote = (quantity: number): ReadonlyArray<MenuSelection> => [
  {
    variantId: "var-1",
    quantity,
    instruction: "Less spicy please",
    originalLanguageInstruction: "Ít cay giúp tôi",
  },
];

const plainSelection = (quantity: number): ReadonlyArray<MenuSelection> => [
  { variantId: "var-1", quantity, instruction: "", originalLanguageInstruction: "" },
];

const copy = menuCopy("en");

describe("WaiterOrderCard", () => {
  test("venue, original names and large quantities lead; translations secondary", () => {
    const markup = renderToStaticMarkup(
      <WaiterOrderCard menu={menu(priced)} selections={plainSelection(2)} locale="en" />,
    );

    expect(markup).toContain("Quán Phở Thật");
    expect(markup).toContain("Phở bò");
    expect(markup).toContain("Tô thường");
    expect(markup).toContain("Beef noodle soup");
    expect(markup).toContain(copy.notSubmitted);
    expect(markup).toContain("VND");
  });

  test("unreviewed special requests never reach the waiter; compact warning instead", () => {
    const markup = renderToStaticMarkup(
      <WaiterOrderCard menu={menu(priced)} selections={selectionWithNote(1)} locale="en" />,
    );

    expect(markup).not.toContain("Ít cay giúp tôi");
    expect(markup).not.toContain("Less spicy please");
    expect(markup).toContain(copy.reviewRequired);
  });

  test("reviewed special requests render in both languages", () => {
    const markup = renderToStaticMarkup(
      <WaiterOrderCard
        menu={menu(priced)}
        selections={selectionWithNote(1)}
        locale="en"
        reviewedVariantIds={new Set(["var-1"])}
      />,
    );

    expect(markup).toContain("Ít cay giúp tôi");
    expect(markup).toContain("Less spicy please");
    expect(markup).not.toContain(copy.reviewRequired);
  });

  test("unknown price stays a compact warning, never a fabricated line total", () => {
    const markup = renderToStaticMarkup(
      <WaiterOrderCard menu={menu(null)} selections={plainSelection(1)} locale="en" />,
    );

    expect(markup).toContain(copy.unknownPrice);
    expect(markup).toContain(copy.priceCheck);
  });

  test("translation toggle and close wire the dialog chrome without remounting state", () => {
    const markup = renderToStaticMarkup(
      <WaiterOrderCard
        menu={menu(priced)}
        selections={plainSelection(1)}
        locale="en"
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain(`aria-label="${copy.back}"`);
  });

  test("quantity and variant edits render only when the parent wires callbacks", () => {
    const displayOnly = renderToStaticMarkup(
      <WaiterOrderCard menu={menu(priced)} selections={plainSelection(1)} locale="en" />,
    );

    expect(displayOnly).not.toContain(copy.variant);

    const editable = renderToStaticMarkup(
      <WaiterOrderCard
        menu={menu(priced)}
        selections={plainSelection(1)}
        locale="en"
        onQuantity={() => {}}
        onVariant={() => {}}
      />,
    );

    expect(editable).toContain(copy.variant);
    expect(editable).toContain(`aria-label="${copy.quantity}`);
  });
});
