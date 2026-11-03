import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { menuScanPageCopy } from "@/modules/restaurant-discovery/components/menu-copy";
import {
  scanFailureKind,
  scanModelChip,
} from "@/modules/restaurant-discovery/components/menu-scan-page";
import { ScanItemEditor } from "@/modules/restaurant-discovery/components/scan-item-editor";
import {
  DraftPriceFields,
  ScanPriceFields,
} from "@/modules/restaurant-discovery/components/scan-price-editor";
import { VariantEditor } from "@/modules/restaurant-discovery/components/scan-variant-editor";
import type { MenuScanDocument } from "@/modules/restaurant-discovery/menu-scan.schema";

const variant = (overrides = {}) => ({
  id: "v1111111-1111-4111-8111-111111111111",
  customerAdded: false as const,
  originalLabel: "Regular",
  translatedLabel: "Regular bowl",
  price: {
    rawText: "65.000đ",
    amount: "65000",
    currency: "VND",
    taxTreatment: "included" as const,
  },
  ...overrides,
});

const item = (overrides = {}): MenuScanDocument["items"][number] => ({
  id: "i2222222-2222-4222-8222-222222222222",
  customerAdded: false as const,
  originalName: "Phở bò",
  translatedName: "Beef noodle soup",
  originalDescription: null,
  translatedDescription: null,
  explanatorySummary: null,
  ingredients: null,
  sourceReferences: [{ assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", region: null }],
  uncertainties: [],
  variants: [variant()],
  ...overrides,
});

describe("scan model chip", () => {
  test("renders nothing when the view has no model field", () => {
    expect(scanModelChip(null)).toBeNull();
    expect(scanModelChip({ number: 2, model: null })).toBeNull();
    expect(scanModelChip({ number: 1, model: "" })).toBeNull();
  });

  test("reads model and revision from the view only", () => {
    expect(scanModelChip({ number: 3, model: "muse-spark-1.3" })).toEqual({
      model: "muse-spark-1.3",
      revision: 3,
    });
  });
});

describe("scan failure kinds", () => {
  test("maps codes to guidance families", () => {
    expect(scanFailureKind("invalid_request")).toBe("validation");
    expect(scanFailureKind("invalid_image")).toBe("validation");
    expect(scanFailureKind("invalid_extraction")).toBe("validation");
    expect(scanFailureKind("conflict")).toBe("conflict");
    expect(scanFailureKind("unauthenticated")).toBe("auth");
    expect(scanFailureKind("reauthentication_required")).toBe("auth");
    expect(scanFailureKind("not_found")).toBe("expired");
    expect(scanFailureKind("rate_limited")).toBeNull();
    expect(scanFailureKind("unavailable")).toBeNull();
    expect(scanFailureKind(undefined)).toBeNull();
  });
});

describe("scan page copy", () => {
  for (const locale of ["en", "vi"]) {
    test(`new ${locale} strings are short, present and carry no identifiers`, () => {
      const copy = menuScanPageCopy(locale);

      for (const value of Object.values(copy)) {
        expect(value.length).toBeGreaterThan(0);
        expect(value).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      }

      expect(copy.privacyShort.length).toBeLessThan(160);
      expect(copy.sheetTitle.length).toBeGreaterThan(0);
      expect(copy.retryAction.length).toBeGreaterThan(0);
    });
  }
});

describe("scan leaf editors", () => {
  test("variant without price offers a correction entry point", () => {
    const html = renderToStaticMarkup(
      <VariantEditor
        variant={variant({ price: null })}
        locale="en"
        sourceLanguage="vi"
        onChange={() => {}}
      />,
    );

    expect(html).toContain("No price was extracted");
    expect(html).toContain("Add a price correction");
  });

  test("variant price fields expose values with validity flags", () => {
    const html = renderToStaticMarkup(
      <ScanPriceFields
        locale="en"
        variantId="v1"
        price={{ rawText: "65.000đ", amount: "abc", currency: "VND", taxTreatment: "included" }}
        priceValid={false}
        onChange={() => {}}
      />,
    );

    expect(html).toContain('id="edit-raw-price-v1"');
    expect(html).toContain('value="65.000đ"');
    expect(html).toContain("aria-invalid");
  });

  test("draft price fields expose the sales channel", () => {
    const html = renderToStaticMarkup(
      <DraftPriceFields
        locale="en"
        clientKey="c1"
        price={{
          rawText: "65.000đ",
          amount: "65000",
          currency: "VND",
          channel: "dine_in",
          taxTreatment: "included",
        }}
        valid
        onChange={() => {}}
      />,
    );

    expect(html).toContain('id="draft-channel-c1"');
    expect(html).toContain("Dine in");
  });

  test("item editor names fields and flags customer additions", () => {
    const html = renderToStaticMarkup(
      <ScanItemEditor
        item={item({ customerAdded: true })}
        locale="en"
        sourceLanguage="vi"
        onUpdate={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(html).toContain('value="Phở bò"');
    expect(html).toContain("Added by you, not extracted");
    expect(html).toContain("Remove this dish");
  });
});
