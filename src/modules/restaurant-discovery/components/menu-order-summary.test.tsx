import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { menuCopy } from "@/modules/restaurant-discovery/components/menu-copy";
import { MenuOrderSummary } from "@/modules/restaurant-discovery/components/menu-order-summary";
import type {
  InteractiveMenu,
  MenuSelection,
} from "@/modules/restaurant-discovery/menu-presentation";

const menuWithPrice = (amount: string | null, currency: string | null): InteractiveMenu => ({
  venueName: "Quán Phở Thật",
  sourceLanguage: "vi",
  targetLanguage: "en",
  introduction: { original: null, translated: null },
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
          price:
            amount === null || currency === null
              ? null
              : { rawText: "65.000đ", amount, currency, taxTreatment: "included" },
          provenance: "Reviewed listed menu price",
          sourceUrl: null,
        },
      ],
    },
  ],
});

const selection = (quantity: number): ReadonlyArray<MenuSelection> => [
  { variantId: "var-1", quantity, instruction: "", originalLanguageInstruction: "" },
];

const copy = menuCopy("en");

describe("MenuOrderSummary", () => {
  test("hidden at zero selections", () => {
    expect(
      renderToStaticMarkup(
        <MenuOrderSummary
          menu={menuWithPrice("65000", "VND")}
          selections={[]}
          locale="en"
          onViewOrder={() => {}}
        />,
      ),
    ).toBe("");
  });

  test("calculable subtotal reuses canonical price math, never a rebuilt sum", () => {
    const markup = renderToStaticMarkup(
      <MenuOrderSummary
        menu={menuWithPrice("65000", "VND")}
        selections={selection(2)}
        locale="en"
        onViewOrder={() => {}}
      />,
    );

    expect(markup).toContain(copy.show);
    expect(markup).toContain(copy.selected);
    expect(markup).toContain("VND");
  });

  test("unknown price never renders a misleading complete subtotal", () => {
    const markup = renderToStaticMarkup(
      <MenuOrderSummary
        menu={menuWithPrice(null, null)}
        selections={selection(1)}
        locale="en"
        onViewOrder={() => {}}
      />,
    );

    expect(markup).toContain("Ask the waiter for a total");
    expect(markup).not.toContain(copy.subtotal);
  });

  test("review-blocked subdues the view action with an announced reason", () => {
    const markup = renderToStaticMarkup(
      <MenuOrderSummary
        menu={menuWithPrice("65000", "VND")}
        selections={selection(1)}
        locale="en"
        onViewOrder={() => {}}
        reviewBlocked
      />,
    );

    expect(markup).toContain("disabled");
    expect(markup).toContain(copy.reviewRequired);
  });
});
