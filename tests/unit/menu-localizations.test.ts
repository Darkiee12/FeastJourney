import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  machineLocalizationFromRow,
  presentReviewed,
  presentReviewedWithLocalizations,
  resolveMenuText,
  type MenuMachineLocalization,
} from "@/modules/restaurant-discovery/menu-presentation";
import {
  localizationSourceFingerprint,
  menuSourceRevisionFingerprint,
  sha256Hex,
  type SourceRevisionOffering,
} from "@/modules/restaurant-discovery/menu-source-hash";
import type { MenuOffering } from "@/modules/restaurant-discovery/server/operations/discovery";
import {
  checkUnitSafety,
  chunkLocalizationUnits,
  localizationSourceHash,
  localizationTargetSchema,
  MAX_LOCALIZATION_BATCH_CHARS,
  MAX_LOCALIZATION_BATCH_UNITS,
  MAX_LOCALIZED_NAME_LENGTH,
  UNSAFE_ASSURANCE_PATTERN,
  type LocalizationUnit,
  type MenuLocalizationRow,
} from "@/modules/restaurant-discovery/server/operations/menu-localizations";

import {
  checkResolution,
  loadGroundTruthCases,
  scoreProbe,
  summarizeEvaluation,
} from "../eval/menu-localization-eval.ts";

const nodeSha256 = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");

const unitFixture = (key: string, size: number): LocalizationUnit => ({
  key,
  kind: "item",
  itemId: key,
  variantId: null,
  sourceLanguage: "vi",
  name: "n".repeat(size),
  description: null,
  sourceHash: "hash",
  curatorTranslated: false,
});

describe("sha256Hex", () => {
  test("matches known vectors, including empty and non-ASCII menu text", () => {
    expect(sha256Hex("")).toBe(nodeSha256(""));
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("Phở bò")).toBe(nodeSha256("Phở bò"));
    expect(sha256Hex("Nasi lemak ñ 日本語 mixed 🎉")).toBe(
      nodeSha256("Nasi lemak ñ 日本語 mixed 🎉"),
    );
  });
});

describe("localizationSourceFingerprint", () => {
  test("agrees with the canonical JSON encoding hashed by Node", () => {
    const input = {
      kind: "item" as const,
      sourceLanguage: "vi",
      target: "en",
      name: "Phở bò",
      description: "Nước dùng xương bò.",
    };

    expect(localizationSourceFingerprint(input)).toBe(
      nodeSha256(JSON.stringify(["item", "vi", "en", "Phở bò", "Nước dùng xương bò."])),
    );
    expect(localizationSourceHash(input)).toBe(localizationSourceFingerprint(input));
  });

  test("any source edit retires the row: name, description, language, or target", () => {
    const base = {
      kind: "item" as const,
      sourceLanguage: "vi",
      target: "en",
      name: "Phở bò",
      description: "Broth.",
    };

    const digest = localizationSourceFingerprint(base);

    expect(localizationSourceFingerprint({ ...base, name: "Phở gà" })).not.toBe(digest);
    expect(localizationSourceFingerprint({ ...base, description: "Other." })).not.toBe(digest);
    expect(localizationSourceFingerprint({ ...base, sourceLanguage: null })).not.toBe(digest);
    expect(localizationSourceFingerprint({ ...base, target: "hinglish" })).not.toBe(digest);
    expect(localizationSourceFingerprint({ ...base, kind: "variant" })).not.toBe(digest);
  });
});

describe("menuSourceRevisionFingerprint", () => {
  const offerings: ReadonlyArray<SourceRevisionOffering> = [
    {
      item_id: "item-1",
      item_name: "Phở bò",
      description: "Broth.",
      variant_id: "variant-1",
      variant_name: "Tô lớn",
      source_language: "vi",
    },
  ];

  test("stable for unchanged text, moves on any source edit", () => {
    const first = offerings[0];

    if (first === undefined) throw new Error("localization unit fixture needs an offering");

    const digest = menuSourceRevisionFingerprint(offerings, "en");

    expect(menuSourceRevisionFingerprint(offerings, "en")).toBe(digest);
    expect(
      menuSourceRevisionFingerprint([{ ...first, description: "Other broth." }], "en"),
    ).not.toBe(digest);
    expect(menuSourceRevisionFingerprint(offerings, "ja")).not.toBe(digest);
  });
});

describe("localizationTargetSchema", () => {
  test("covers the reading targets plus explicit styles", () => {
    for (const target of ["en", "vi", "ja", "zh", "ko", "fr", "es", "ms", "hi", "hinglish"]) {
      expect(localizationTargetSchema.safeParse(target).success).toBe(true);
    }

    expect(localizationTargetSchema.safeParse("de").success).toBe(false);
  });
});

describe("chunkLocalizationUnits", () => {
  test("bounds batches by unit count", () => {
    const units = Array.from({ length: MAX_LOCALIZATION_BATCH_UNITS + 5 }, (_, index) =>
      unitFixture(`item:${index}`, 10),
    );

    const chunks = chunkLocalizationUnits(units);

    expect(chunks.length).toBe(2);
    expect(chunks[0]?.length).toBe(MAX_LOCALIZATION_BATCH_UNITS);
    expect(chunks[1]?.length).toBe(5);
  });

  test("bounds batches by source characters", () => {
    const big = Math.ceil(MAX_LOCALIZATION_BATCH_CHARS / 2) + 1;
    const chunks = chunkLocalizationUnits([unitFixture("item:a", big), unitFixture("item:b", big)]);

    expect(chunks.length).toBe(2);
  });
});

describe("checkUnitSafety", () => {
  const source: LocalizationUnit = {
    key: "item:probe",
    kind: "item",
    itemId: "probe",
    variantId: null,
    sourceLanguage: "en",
    name: "Peanut noodles",
    description: "Wheat noodles with peanut sauce.",
    sourceHash: "hash",
    curatorTranslated: false,
  };

  test("clean translations pass", () => {
    expect(
      checkUnitSafety(source, {
        key: "item:probe",
        displayName: "Peanut noodles",
        description: "Wheat noodles with peanut sauce.",
        explanation: null,
      }),
    ).toBe(true);
  });

  test("invented allergy assurances fail closed", () => {
    expect(
      checkUnitSafety(source, {
        key: "item:probe",
        displayName: "Peanut noodles",
        description: null,
        explanation: "Allergen-free and safe for all allergies.",
      }),
    ).toBe(false);
  });

  test("a printed assurance is grounded, not invented", () => {
    const printed: LocalizationUnit = {
      ...source,
      name: "Rice bowl",
      description: "Gluten-free tamari on request.",
    };

    expect(
      checkUnitSafety(printed, {
        key: "item:probe",
        displayName: "Rice bowl",
        description: "Gluten-free option with tamari.",
        explanation: null,
      }),
    ).toBe(true);
  });

  test("the guard pattern matches the documented claim shapes", () => {
    expect(UNSAFE_ASSURANCE_PATTERN.test("100% safe")).toBe(true);
    expect(UNSAFE_ASSURANCE_PATTERN.test("tastes safe and delicious")).toBe(false);
  });
});

describe("machine-tier presentation", () => {
  test("resolveMenuText labels an explicit machine tier", () => {
    const display = resolveMenuText({
      original: "Phở bò",
      sourceLanguage: "vi",
      translated: "Beef noodle soup",
      translationLanguage: "en",
      targetLanguage: "en",
      reviewed: true,
      provenance: "machine",
    });

    expect(display.provenance).toBe("machine");
  });

  test("legacy calls without provenance keep approved/unverified inference", () => {
    expect(
      resolveMenuText({
        original: "Phở bò",
        sourceLanguage: "vi",
        translated: "Beef noodle soup",
        translationLanguage: "en",
        targetLanguage: "en",
        reviewed: true,
      }).provenance,
    ).toBe("approved");
    expect(
      resolveMenuText({
        original: "Phở bò",
        sourceLanguage: "vi",
        translated: "Beef noodle soup",
        translationLanguage: "en",
        targetLanguage: "en",
        reviewed: false,
      }).provenance,
    ).toBe("unverified");
  });

  test("presentReviewed keeps its 3-arg shape working with no machine rows", () => {
    const offerings: Array<MenuOffering> = [
      {
        menu_id: "menu-1",
        menu_name: "Menu",
        source_language: "vi",
        item_id: "item-1",
        item_name: "Phở bò",
        description: "",
        translation_language: null,
        translated_name: null,
        translated_description: null,
        explanatory_summary: null,
        variant_id: "variant-1",
        variant_name: "Tô lớn",
        comparison_key: null,
        variant_translation_language: null,
        variant_translated_label: null,
        observation_id: null,
        amount: null,
        currency: null,
        price_kind: null,
        sales_channel: null,
        tax_treatment: null,
        observed_at: null,
        current_enough: null,
        source_category: null,
        source_url: null,
        raw_price_text: null,
        dish_id: null,
        match_kind: null,
      },
    ];

    const menu = presentReviewed(offerings, "Quán", "en");

    expect(menu.items[0]?.translatedName).toBeNull();

    const overlaid = presentReviewedWithLocalizations(offerings, "Quán", "en");

    expect(overlaid.items[0]?.translatedName).toBeNull();
  });
});

describe("localization consent guard", () => {
  test("generation sources are published reviewed rows only", () => {
    const currentFile = fileURLToPath(import.meta.url);

    const sqlPath = join(
      dirname(currentFile),
      "..",
      "..",
      "src",
      "modules",
      "restaurant-discovery",
      "server",
      "repository",
      "sql",
      "menu-localization-sources.sql",
    );

    const sql = readFileSync(sqlPath, "utf8");

    const queryBody = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    expect(queryBody).toContain("status='published'");
    expect(queryBody).not.toContain("menu_scan");
    expect(queryBody).not.toContain("draft");
  });
});

describe("localization eval fixtures", () => {
  test("harness checks pass on the hand-maintained fixtures", () => {
    const { cases, probes } = loadGroundTruthCases();

    expect(cases.length).toBeGreaterThanOrEqual(6);

    const targets = new Set(cases.map((entry) => entry.target));

    for (const expected of ["en", "ms", "zh", "hi", "ja"]) {
      expect(targets.has(expected)).toBe(true);
    }

    expect(cases.some((entry) => entry.sourceLanguage === null)).toBe(true);
    expect(cases.every((entry) => entry.origin.startsWith("synthetic"))).toBe(true);

    const summary = summarizeEvaluation(cases, probes);

    expect(summary.passed).toBe(true);
  });

  test("adversarial probes are classified exactly as marked", () => {
    const { probes } = loadGroundTruthCases();

    for (const probe of probes) {
      expect(scoreProbe(probe).passed).toBe(true);
    }
  });

  test("resolution precedence holds through the real overlay", () => {
    const resolution = checkResolution();

    expect(resolution.length).toBeGreaterThan(0);

    for (const entry of resolution) {
      expect(entry.passed).toBe(true);
    }
  });

  test("fixture display names respect the mobile-line bound", () => {
    const { cases } = loadGroundTruthCases();

    for (const entry of cases) {
      for (const output of entry.stubOutputs) {
        if (output.displayName !== null) {
          expect(output.displayName.length).toBeLessThanOrEqual(MAX_LOCALIZED_NAME_LENGTH);
        }
      }
    }
  });

  test("row mapping preserves provenance and never invents text", () => {
    const row: MenuLocalizationRow = {
      id: "00000000-0000-4000-8000-000000000003",
      item_id: "00000000-0000-4000-8000-000000000001",
      variant_id: null,
      target: "en",
      source_hash: "0".repeat(64),
      display_name: "Beef noodle soup",
      description: null,
      explanation: null,
      status: "machine",
      provider: "muse",
      model: "muse-spark-1.3",
      prompt_version: "menu-localize-v1",
      schema_version: 1,
      created_at: "2026-11-03T00:00:00.000Z",
    };

    const mapped: MenuMachineLocalization = machineLocalizationFromRow(row);

    expect(mapped.displayName).toBe("Beef noodle soup");
    expect(mapped.status).toBe("machine");
    expect(mapped.itemId).toBe("00000000-0000-4000-8000-000000000001");
  });
});
