import { describe, expect, test } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  deriveSlug,
  isValidSlug,
  parseCuisineBulkLine,
  parseIngredientBulkLine,
  resolveCuisineRowStatuses,
  resolveIngredientRowStatuses,
  type BulkCuisineResult,
  type BulkIngredientResult,
} from "@/components/admin/taxonomy/taxonomy-contracts";
import { BulkResultList } from "@/components/admin/taxonomy/taxonomy-shared";

/**
 * Admin taxonomy UI pins (frontend workstream, `feat/admin-taxonomy-ui`).
 *
 * The six server functions are owned by the backend workstream and have not
 * landed, so these tests pin everything the UI owns: slug derivation plus
 * validity (mirroring `taxonomySlugSchema`), the bulk-line grammars, the
 * per-row outcome resolution, and the SSR markup contract for the bulk
 * result list. Interaction (search debounce, mutations, tab switching) is
 * covered by browser verification, not bun:test — no DOM renderer is
 * installed in this repo.
 */

describe("slug derivation", () => {
  test("derives hyphenated slugs from display names", () => {
    expect(deriveSlug("Hue cuisine")).toBe("hue-cuisine");
    expect(deriveSlug("  Ẩm thực Huế  ")).toBe("am-thuc-hue");
    expect(deriveSlug("Bánh mì & Phở!")).toBe("banh-mi-pho");
  });

  test("returns empty when nothing usable remains", () => {
    expect(deriveSlug("")).toBe("");
    expect(deriveSlug("---")).toBe("");
    expect(deriveSlug("   ")).toBe("");
  });
});

describe("slug validity", () => {
  test("accepts the server slug shape only", () => {
    expect(isValidSlug("hue")).toBe(true);
    expect(isValidSlug("hue-cuisine")).toBe(true);
    expect(isValidSlug("a1-b2")).toBe(true);
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("Hue")).toBe(false);
    expect(isValidSlug("-hue")).toBe(false);
    expect(isValidSlug("hue-")).toBe(false);
    expect(isValidSlug("hue--cuisine")).toBe(false);
    expect(isValidSlug("hue_cuisine")).toBe(false);
  });
});

describe("cuisine bulk-line grammar", () => {
  test("plain name becomes a slugless entry", () => {
    expect(parseCuisineBulkLine("Hue cuisine")).toEqual({
      kind: "cuisine",
      entry: { name: "Hue cuisine" },
    });
  });

  test("slug pipe name splits on the first separator", () => {
    expect(parseCuisineBulkLine("hue | Hue cuisine")).toEqual({
      kind: "cuisine",
      entry: { slug: "hue", name: "Hue cuisine" },
    });
    expect(parseCuisineBulkLine("a | b | c")).toEqual({
      kind: "cuisine",
      entry: { slug: "a", name: "b | c" },
    });
  });

  test("blank lines are skippable, missing names and bad slugs are invalid rows", () => {
    expect(parseCuisineBulkLine("   ")).toEqual({ kind: "empty" });
    expect(parseCuisineBulkLine("hue | ")).toEqual({
      kind: "cuisine-invalid",
      raw: "hue |",
      reason: "Missing display name after “|”.",
    });
    const bad = parseCuisineBulkLine("Bad Slug | Display");

    if (bad.kind !== "cuisine-invalid") {
      throw new Error("expected a cuisine-invalid row");
    }

    expect(bad.raw).toBe("Bad Slug | Display");
    expect(bad.reason).toContain("Bad Slug");
  });
});

describe("ingredient bulk-line grammar", () => {
  test("plain name becomes a tagless entry", () => {
    expect(parseIngredientBulkLine("Water spinach")).toEqual({
      kind: "ingredient",
      entry: { name: "Water spinach" },
    });
  });

  test("language tag pipe name splits correctly", () => {
    expect(parseIngredientBulkLine("vi | Rau muống")).toEqual({
      kind: "ingredient",
      entry: { languageTag: "vi", name: "Rau muống" },
    });
  });

  test("bad tags and missing names are invalid rows", () => {
    const bad = parseIngredientBulkLine("vietnamese | Rau muống");

    if (bad.kind !== "ingredient-invalid") {
      throw new Error("expected an ingredient-invalid row");
    }

    expect(bad.reason).toContain("vietnamese");
    expect(parseIngredientBulkLine("vi | ")).toEqual({
      kind: "ingredient-invalid",
      raw: "vi |",
      reason: "Missing display name after “|”.",
    });
  });
});

describe("bulk row status resolution", () => {
  test("cuisine rows absent from skipped/invalid count as created", () => {
    const result: BulkCuisineResult = {
      created: 1,
      skipped: [{ entry: { slug: "pho", name: "Pho" }, reason: "duplicate slug" }],
      invalid: [{ entry: { name: "Bad" }, reason: "empty after trim" }],
    };

    const rows = resolveCuisineRowStatuses(
      [{ slug: "hue", name: "Hue" }, { slug: "pho", name: "Pho" }, { name: "Bad" }],
      result,
    );

    expect(rows.map((row) => row.status)).toEqual(["created", "skipped", "invalid"]);
    expect(rows[1]?.reason).toBe("duplicate slug");
    expect(rows[2]?.reason).toBe("empty after trim");
    expect(rows[0]?.label).toBe("hue | Hue");
  });

  test("ingredient rows resolve the same way with language-tag labels", () => {
    const result: BulkIngredientResult = {
      created: 1,
      skipped: [{ entry: { name: "Basil" }, reason: "already exists" }],
      invalid: [],
    };

    const rows = resolveIngredientRowStatuses(
      [{ languageTag: "vi", name: "Rau muống" }, { name: "Basil" }],
      result,
    );

    expect(rows.map((row) => row.status)).toEqual(["created", "skipped"]);
    expect(rows[0]?.label).toBe("vi | Rau muống");
    expect(rows[1]?.reason).toBe("already exists");
  });
});

describe("bulk result list markup", () => {
  test("renders status text plus server reasons, not color alone", () => {
    const html = renderToStaticMarkup(
      createElement(BulkResultList, {
        createdCount: 1,
        emptyMessage: "No rows submitted.",
        rows: [
          { key: "0:hue:Hue", label: "hue | Hue", status: "created", reason: null },
          { key: "1:pho:Pho", label: "pho | Pho", status: "skipped", reason: "duplicate slug" },
          { key: "2::Bad", label: "Bad", status: "invalid", reason: "empty after trim" },
        ],
      }),
    );

    expect(html).toContain("1 created · 1 skipped · 1 invalid");
    expect(html).toContain("duplicate slug");
    expect(html).toContain("empty after trim");
    expect(html).toContain("hue | Hue");
  });

  test("empty submission renders the empty message", () => {
    const html = renderToStaticMarkup(
      createElement(BulkResultList, {
        createdCount: 0,
        emptyMessage: "No rows submitted.",
        rows: [],
      }),
    );

    expect(html).toContain("No rows submitted.");
  });
});
