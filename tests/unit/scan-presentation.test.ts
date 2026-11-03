import { describe, expect, test } from "bun:test";

import { presentReviewed } from "@/modules/restaurant-discovery/menu-presentation";
import {
  menuDocumentFitsStorage,
  validateMenuRevision,
} from "@/modules/restaurant-discovery/menu-scan-revision";
import { menuScanDocumentSchema } from "@/modules/restaurant-discovery/menu-scan.schema";
import type { MenuScanDocument } from "@/modules/restaurant-discovery/menu-scan.schema";
import type { MenuOffering } from "@/modules/restaurant-discovery/server/operations/discovery";

const page = "11111111-1111-4111-8111-111111111111";
const itemA = "22222222-2222-4222-8222-222222222222";
const variantA = "33333333-3333-4333-8333-333333333333";
const itemB = "66666666-6666-4666-8666-666666666666";
const variantB = "77777777-7777-4777-8777-777777777777";
const variantC = "99999999-9999-4999-8999-999999999999";

type ScanItem = MenuScanDocument["items"][number];

type ScanVariant = ScanItem["variants"][number];

const scanVariant = (overrides: Partial<ScanVariant> & { id: string }): ScanVariant => ({
  originalLabel: "",
  translatedLabel: null,
  price: {
    rawText: "65.000đ",
    amount: "65000",
    currency: "VND",
    taxTreatment: "included",
  },
  ...overrides,
});

const baseDocument = (): MenuScanDocument => ({
  schemaVersion: 1,
  sourceLanguage: "vi",
  targetLanguage: "en",
  menuTitle: "Synthetic",
  orderIntroduction: { original: "Xin mời", translated: "Please order" },
  pages: [{ assetId: page, pageNumber: 1 }],
  items: [
    {
      id: itemA,
      originalName: "Phở bò",
      translatedName: "Beef noodle soup",
      originalDescription: null,
      translatedDescription: null,
      explanatorySummary: null,
      ingredients: null,
      variants: [scanVariant({ id: variantA })],
      sourceReferences: [{ assetId: page, region: null }],
      uncertainties: [],
    },
  ],
});

const firstItem = (document: MenuScanDocument): ScanItem => {
  const item = document.items.at(0);

  if (item === undefined) throw new Error("fixture item missing");

  return item;
};

const offering = (overrides: Partial<MenuOffering>): MenuOffering => ({
  menu_id: "44444444-4444-4444-8444-444444444444",
  menu_name: "Main",
  source_language: "vi",
  translation_language: "en",
  translated_name: "Beef noodle soup",
  translated_description: null,
  explanatory_summary: null,
  item_id: itemA,
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

describe("validateMenuRevision", () => {
  test("rejects invalid PostgreSQL Unicode at the menu trust boundary", () => {
    for (const invalid of ["Nul\u0000text", "Broken\ud800text"]) {
      const document = baseDocument();
      firstItem(document).originalName = invalid;
      expect(menuScanDocumentSchema.safeParse(document).success).toBe(false);
    }

    expect(menuScanDocumentSchema.safeParse(baseDocument()).success).toBe(true);
  });

  test("bounds normalized UTF-8 storage size, including multibyte names", () => {
    const document = baseDocument();
    expect(menuDocumentFitsStorage(document)).toBe(true);
    const item = firstItem(document);

    const large = {
      ...item,
      originalDescription: "食".repeat(3000),
      translatedDescription: "食".repeat(3000),
      explanatorySummary: "食".repeat(3000),
    };

    document.items = Array.from({ length: 100 }, () => large);
    expect(menuScanDocumentSchema.safeParse(document).success).toBe(true);
    expect(menuDocumentFitsStorage(document)).toBe(false);
  });
  test("accepts untouched and field-corrected documents", () => {
    expect(validateMenuRevision(baseDocument(), structuredClone(baseDocument()))).toBe(true);

    const corrected = baseDocument();
    const item = firstItem(corrected);
    item.originalName = "Phở bò tái";
    expect(validateMenuRevision(baseDocument(), corrected)).toBe(true);
  });

  test("allows removing items but forbids empty menus", () => {
    const removed = baseDocument();
    removed.items = [];
    expect(validateMenuRevision(baseDocument(), removed)).toBe(false);
  });

  test("requires the customer flag on added items and variants", () => {
    const added = baseDocument();
    added.items.push({ ...firstItem(added), id: itemB });
    expect(validateMenuRevision(baseDocument(), added)).toBe(false);

    const flagged = baseDocument();
    flagged.items.push({
      ...firstItem(flagged),
      id: itemB,
      customerAdded: true,
      variants: [{ ...scanVariant({ id: variantB }), customerAdded: true }],
    });
    expect(validateMenuRevision(baseDocument(), flagged)).toBe(true);
  });

  test("rejects unflagged variant additions, unknown pages and duplicates", () => {
    const addedVariant = baseDocument();
    firstItem(addedVariant).variants.push(scanVariant({ id: variantB }));
    expect(validateMenuRevision(baseDocument(), addedVariant)).toBe(false);

    const flaggedVariant = baseDocument();
    firstItem(flaggedVariant).variants.push(scanVariant({ id: variantB, customerAdded: true }));
    expect(validateMenuRevision(baseDocument(), flaggedVariant)).toBe(true);

    const badPage = baseDocument();
    firstItem(badPage).sourceReferences = [
      { assetId: "88888888-8888-4888-8888-888888888888", region: null },
    ];
    expect(validateMenuRevision(baseDocument(), badPage)).toBe(false);

    const duplicated = baseDocument();
    duplicated.items.push(firstItem(duplicated));
    expect(validateMenuRevision(baseDocument(), duplicated)).toBe(false);
  });

  test("rejects language and page changes", () => {
    const previous = baseDocument();
    expect(
      validateMenuRevision(previous, { ...structuredClone(previous), targetLanguage: "vi" }),
    ).toBe(false);
    expect(validateMenuRevision(previous, { ...structuredClone(previous), pages: [] })).toBe(false);
  });
});

describe("presentReviewed", () => {
  test("projects offerings into the shared ordering contract", () => {
    const menu = presentReviewed(
      [offering({}), offering({ variant_id: variantC, variant_name: "Large" })],
      "Branch",
      "en",
    );

    expect(menu.provenance).toBe("reviewed");
    expect(menu.venueName).toBe("Branch");
    expect(menu.items.length).toBe(1);
    expect(menu.items.at(0)?.variants.length).toBe(2);
    expect(menu.items.at(0)?.variants.at(0)?.price?.amount).toBe("65000");
    expect(menu.items.at(0)?.variants.at(0)?.provenance).toContain("Reviewed listed menu price");
  });

  test("marks stale and unknown prices explicitly", () => {
    const menu = presentReviewed(
      [
        offering({ current_enough: false }),
        offering({
          variant_id: variantC,
          variant_name: "Large",
          observation_id: null,
          amount: null,
          currency: null,
        }),
      ],
      null,
      "vi",
    );

    expect(menu.items.at(0)?.uncertainties.length).toBe(1);
    expect(menu.items.at(0)?.variants.at(1)?.price).toBeNull();
  });

  test("links the first canonical dish match", () => {
    const menu = presentReviewed(
      [offering({ dish_id: "123", match_kind: "exact" })],
      "Branch",
      "en",
    );

    expect(menu.items.at(0)?.dishId).toBe("123");
    expect(presentReviewed([], "Branch", "en").items).toEqual([]);
  });

  test("retains dated source provenance without inventing a listed price", () => {
    const menu = presentReviewed(
      [offering({ observation_id: null, price_kind: null, amount: null, currency: null })],
      "Branch",
      "en",
    );

    const variant = menu.items[0]?.variants[0];

    expect(variant?.price).toBeNull();
    expect(variant?.provenance).toContain("price unknown");
    expect(variant?.provenance).toContain("observed 2026-10-01");
    expect(variant?.provenance).not.toContain("Reviewed listed menu price");
  });
});
