import { describe, expect, test } from "bun:test";

import {
  cleanCuisineSlug,
  cleanLanguageTag,
  cleanTaxonomyName,
} from "@/modules/food-discovery/server/operations/taxonomy-admin-service";

describe("cleanTaxonomyName", () => {
  test("trims and keeps valid names with their search key", () => {
    expect(cleanTaxonomyName("  Phở bò  ")).toEqual({ name: "Phở bò", searchKey: "pho bo" });
  });

  test("rejects blank, overlong, and non-searchable names", () => {
    expect(cleanTaxonomyName("   ")).toBeNull();
    expect(cleanTaxonomyName("")).toBeNull();
    expect(cleanTaxonomyName("!!!")).toBeNull();
    expect(cleanTaxonomyName("x".repeat(301))).toBeNull();
    expect(cleanTaxonomyName("x".repeat(300))).not.toBeNull();
  });
});

describe("cleanCuisineSlug", () => {
  test("derives a slug from the display name when omitted", () => {
    expect(cleanCuisineSlug(undefined, "Vietnamese Street Food")).toBe("vietnamese-street-food");
    expect(cleanCuisineSlug(null, "Phở")).toBe("pho");
  });

  test("accepts explicit slugs verbatim when they match the pattern", () => {
    expect(cleanCuisineSlug("vietnamese", "Vietnamese")).toBe("vietnamese");
    expect(cleanCuisineSlug("  sichuan-2024  ", "Sichuan")).toBe("sichuan-2024");
  });

  test("rejects explicit slugs outside the canonical pattern without normalizing them", () => {
    expect(cleanCuisineSlug("Vietnamese", "Vietnamese")).toBeNull();
    expect(cleanCuisineSlug("sichuan_food", "Sichuan")).toBeNull();
    expect(cleanCuisineSlug("sichuan--food", "Sichuan")).toBeNull();
    expect(cleanCuisineSlug("-sichuan", "Sichuan")).toBeNull();
    expect(cleanCuisineSlug("", "Sichuan")).toBeNull();
    expect(cleanCuisineSlug("x".repeat(121), "Sichuan")).toBeNull();
  });
});

describe("cleanLanguageTag", () => {
  test("defaults omitted and blank tags to English", () => {
    expect(cleanLanguageTag(undefined)).toBe("en");
    expect(cleanLanguageTag(null)).toBe("en");
    expect(cleanLanguageTag("   ")).toBe("en");
  });

  test("accepts canonical locale tags and rejects malformed ones", () => {
    expect(cleanLanguageTag("vi")).toBe("vi");
    expect(cleanLanguageTag(" en-US ")).toBe("en-US");
    expect(cleanLanguageTag("english")).toBeNull();
    expect(cleanLanguageTag("e")).toBeNull();
    expect(cleanLanguageTag("en_us")).toBeNull();
  });
});
