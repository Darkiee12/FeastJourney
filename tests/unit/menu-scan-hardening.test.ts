import { describe, expect, test } from "bun:test";

import { validateMenuRevision } from "@/modules/restaurant-discovery/menu-scan-revision";
import {
  contributeScanSchema,
  menuExtractionSchema,
  menuScanDocumentSchema,
  type MenuScanDocument,
} from "@/modules/restaurant-discovery/menu-scan.schema";

const pageId = crypto.randomUUID();
const itemA = crypto.randomUUID();
const itemB = crypto.randomUUID();
const variantA = crypto.randomUUID();
const variantB = crypto.randomUUID();

const document = (): MenuScanDocument => ({
  schemaVersion: 1,
  sourceLanguage: "vi",
  targetLanguage: "en",
  menuTitle: "Synthetic correction fixture",
  orderIntroduction: { original: null, translated: null },
  pages: [{ assetId: pageId, pageNumber: 1 }],
  items: [
    {
      id: itemA,
      originalName: "Phở bò",
      translatedName: "Beef noodle soup",
      originalDescription: null,
      translatedDescription: null,
      explanatorySummary: null,
      ingredients: null,
      variants: [{ id: variantA, originalLabel: "", translatedLabel: null, price: null }],
      sourceReferences: [{ assetId: pageId, region: null }],
      uncertainties: [],
    },
    {
      id: itemB,
      originalName: "Trà",
      translatedName: "Tea",
      originalDescription: null,
      translatedDescription: null,
      explanatorySummary: null,
      ingredients: null,
      variants: [{ id: variantB, originalLabel: "", translatedLabel: null, price: null }],
      sourceReferences: [{ assetId: pageId, region: null }],
      uncertainties: [],
    },
  ],
});

describe("menu correction trust boundary", () => {
  test("requires explicit contribution consent rather than accepting unchecked input", () => {
    const input = {
      scanId: crypto.randomUUID(),
      revision: 1,
      consent: false,
      termsVersion: "menu-facts-v1",
      venueId: null,
    };

    expect(contributeScanSchema.safeParse(input).success).toBe(false);
    expect(contributeScanSchema.safeParse({ ...input, consent: true }).success).toBe(true);
  });
  test("allows correcting text and prices while preserving original revision", () => {
    const before = document();

    const next = {
      ...before,
      items: before.items.map((item) => ({ ...item, translatedName: "Customer correction" })),
    };

    expect(validateMenuRevision(before, next)).toBe(true);
    expect(before.items.map((item) => item.translatedName)).toEqual(["Beef noodle soup", "Tea"]);
  });

  test("rejects the same variant identity reused by different items", () => {
    const before = document();

    const next = {
      ...before,
      items: before.items.map((item) => ({
        ...item,
        variants: item.variants.map((variant) => ({
          ...variant,
          id: variantA,
          customerAdded: true,
        })),
      })),
    };

    expect(menuScanDocumentSchema.safeParse(next).success).toBe(true);
    expect(validateMenuRevision(before, next)).toBe(false);
  });

  test("allows explicit customer omissions to be added and items to be removed", () => {
    const before = document();

    const next = {
      ...before,
      items: before.items
        .filter((item) => item.id === itemA)
        .map((item) =>
          Object.assign({}, item, {
            variants: [
              ...item.variants,
              {
                id: crypto.randomUUID(),
                customerAdded: true,
                originalLabel: "Lớn",
                translatedLabel: "Large",
                price: null,
              },
            ],
          }),
        ),
    };

    expect(validateMenuRevision(before, next)).toBe(true);
  });

  test("rejects arbitrary replacement identities without customer-added provenance", () => {
    const before = document();

    const next = {
      ...before,
      items: before.items.map((item) => ({ ...item, id: crypto.randomUUID() })),
    };

    expect(validateMenuRevision(before, next)).toBe(false);
  });

  test("rejects changed or foreign page evidence", () => {
    const before = document();
    expect(
      validateMenuRevision(before, {
        ...before,
        pages: [{ assetId: crypto.randomUUID(), pageNumber: 1 }],
      }),
    ).toBe(false);
    expect(
      validateMenuRevision(before, {
        ...before,
        items: before.items.map((item) =>
          Object.assign({}, item, {
            sourceReferences: [{ assetId: crypto.randomUUID(), region: null }],
          }),
        ),
      }),
    ).toBe(false);
  });

  test("rejects duplicate item identities and empty menus", () => {
    const before = document();
    expect(
      validateMenuRevision(before, {
        ...before,
        items: before.items.map((item) => ({ ...item, id: itemA })),
      }),
    ).toBe(false);
    expect(validateMenuRevision(before, { ...before, items: [] })).toBe(false);
  });

  test("provider output cannot assert the customer-added marker", () => {
    const before = document();
    const item = before.items.at(0);

    if (item === undefined) throw new Error("fixture item missing");
    const { id: _id, variants, ...source } = item;

    const output = {
      sourceLanguage: "vi",
      menuTitle: null,
      orderIntroduction: { original: null, translated: null },
      items: [
        {
          ...source,
          customerAdded: true,
          variants: variants.map(({ id: _variantId, ...variant }) => variant),
        },
      ],
    };

    expect(menuExtractionSchema.safeParse(output).success).toBe(false);
  });
});
