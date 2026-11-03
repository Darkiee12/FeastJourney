// oxlint-disable-next-line import/no-unassigned-import -- side-effectful test environment setup, runs before server modules initialize.
import "../integration/cleanup";
import { describe, expect, test } from "bun:test";

import {
  applyFieldMapping,
  classifyDuplicateDecision,
  dedupKeyFor,
  isWithinCoverage,
  needsLicenseReview,
  normalizeVenueText,
  overtureReleaseError,
  parseCsvText,
  templateRowsToDrafts,
  validateStagedRow,
  COVERAGE_BOUNDS,
  FUZZY_SIMILARITY_THRESHOLD,
  IMPORT_TEMPLATE_HEADERS,
  OVERTURE_SOURCE_NAME,
} from "@/modules/restaurant-discovery/server/operations/bulk-import";

describe("normalizeVenueText", () => {
  test("collapses spacing, trims, and lowercases", () => {
    expect(normalizeVenueText("  Phở   Hòa  Pasteur ")).toBe("phở hòa pasteur");
  });

  test("empty input stays empty", () => {
    expect(normalizeVenueText("")).toBe("");
  });
});

describe("dedupKeyFor", () => {
  test("builds sourceName:datasetVersion:sourceRecordId", () => {
    expect(
      dedupKeyFor({
        sourceName: OVERTURE_SOURCE_NAME,
        datasetVersion: "2026-10.0",
        sourceRecordId: "abc123",
      }),
    ).toBe("Overture Maps Places:2026-10.0:abc123");
  });

  test("is null until all three parts are assigned", () => {
    expect(
      dedupKeyFor({ sourceName: "Manual", datasetVersion: null, sourceRecordId: "x" }),
    ).toBeNull();
    expect(
      dedupKeyFor({ sourceName: "Manual", datasetVersion: "v1", sourceRecordId: null }),
    ).toBeNull();
    expect(dedupKeyFor({ sourceName: "  ", datasetVersion: "v1", sourceRecordId: "x" })).toBeNull();
  });
});

describe("classifyDuplicateDecision", () => {
  test("exact normalized name+address auto-skips", () => {
    expect(
      classifyDuplicateDecision({ exactMatch: true, bestSimilarity: 1, bestDistanceMeters: 0 }),
    ).toBe("skip");
  });

  test("trigram-similar within 50 m goes to review, never auto-merge", () => {
    expect(
      classifyDuplicateDecision({ exactMatch: false, bestSimilarity: 0.9, bestDistanceMeters: 12 }),
    ).toBe("review");
    expect(
      classifyDuplicateDecision({
        exactMatch: false,
        bestSimilarity: FUZZY_SIMILARITY_THRESHOLD,
        bestDistanceMeters: 50,
      }),
    ).toBe("review");
  });

  test("similar name beyond 50 m is a new candidate", () => {
    expect(
      classifyDuplicateDecision({ exactMatch: false, bestSimilarity: 0.9, bestDistanceMeters: 51 }),
    ).toBe("create");
  });

  test("dissimilar nearby name is a new candidate", () => {
    expect(
      classifyDuplicateDecision({ exactMatch: false, bestSimilarity: 0.2, bestDistanceMeters: 5 }),
    ).toBe("create");
  });

  test("no candidate at all is a new candidate", () => {
    expect(
      classifyDuplicateDecision({
        exactMatch: false,
        bestSimilarity: null,
        bestDistanceMeters: null,
      }),
    ).toBe("create");
  });
});

describe("isWithinCoverage", () => {
  test("accepts central Ho Chi Minh City", () => {
    expect(isWithinCoverage(106.701, 10.775)).toBe(true);
  });

  test("rejects Hanoi", () => {
    expect(isWithinCoverage(105.854, 21.028)).toBe(false);
  });

  test("accepts the documented bounds edges", () => {
    expect(isWithinCoverage(COVERAGE_BOUNDS.minLongitude, COVERAGE_BOUNDS.minLatitude)).toBe(true);
    expect(isWithinCoverage(COVERAGE_BOUNDS.maxLongitude, COVERAGE_BOUNDS.maxLatitude)).toBe(true);
  });
});

describe("parseCsvText", () => {
  test("parses headers and rows", () => {
    const parsed = parseCsvText("name,address\nPho Hoa,1 Pasteur\n");
    expect(parsed?.headers).toEqual(["name", "address"]);
    expect(parsed?.rows).toEqual([["Pho Hoa", "1 Pasteur"]]);
  });

  test("handles quoted commas and escaped quotes", () => {
    const parsed = parseCsvText('name,address\n"Pho, Hoa","1 ""Pasteur"" St"\n');
    expect(parsed?.rows).toEqual([["Pho, Hoa", '1 "Pasteur" St']]);
  });

  test("returns null on malformed input", () => {
    expect(parseCsvText('name\n"unclosed')).toBeNull();
  });

  test("returns null when there is no header", () => {
    expect(parseCsvText("")).toBeNull();
    expect(parseCsvText("\n\n")).toBeNull();
  });
});

describe("applyFieldMapping", () => {
  test("maps columns to template fields and ignores unknown columns", () => {
    const drafts = applyFieldMapping(
      ["businessName", "name", "mystery"],
      [["Bun Cha Co", "Bun Cha", "???"]],
      [
        { column: "businessName", field: "businessName" },
        { column: "name", field: "name" },
        { column: "mystery", field: "ignore" },
      ],
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.businessName).toBe("Bun Cha Co");
    expect(drafts[0]?.name).toBe("Bun Cha");
  });

  test("first mapping wins for a repeated field", () => {
    const drafts = applyFieldMapping(
      ["a", "b"],
      [["first", "second"]],
      [
        { column: "a", field: "name" },
        { column: "b", field: "name" },
      ],
    );

    expect(drafts[0]?.name).toBe("first");
  });

  test("blank cells stay undefined", () => {
    const drafts = applyFieldMapping(["name"], [["  "]], [{ column: "name", field: "name" }]);
    expect(drafts[0]?.name).toBeUndefined();
  });
});

describe("templateRowsToDrafts", () => {
  test("passes template-vocabulary rows through", () => {
    const drafts = templateRowsToDrafts([{ name: "Pho Hoa", address: "1 Pasteur" }]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.name).toBe("Pho Hoa");
  });

  test("rejects non-object rows", () => {
    expect(() => templateRowsToDrafts(["nope"])).toThrow();
  });

  test("template headers cover the documented vocabulary", () => {
    expect(IMPORT_TEMPLATE_HEADERS).toContain("sourceRecordId");
    expect(IMPORT_TEMPLATE_HEADERS).not.toContain("datasetVersion");
  });
});

describe("validateStagedRow", () => {
  const jobUrl = "https://example.com/release";

  test("accepts a complete HCMC row", () => {
    const check = validateStagedRow(
      {
        businessName: "Pho Hoa",
        name: "Phở Hòa Pasteur",
        address: "260C Pasteur, Quận 3",
        area: "Quận 3",
        countryCode: "vn",
        longitude: "106.682",
        latitude: "10.782",
        cuisineSlugs: undefined,
        sourceRecordId: "ov-1",
        observedAt: "2026-10-01T00:00:00Z",
        sourceUrl: undefined,
      },
      0,
      jobUrl,
    );

    expect(check.errors).toEqual([]);
    expect(check.staged).not.toBeNull();
    expect(check.externalRef).toBe("ov-1");
  });

  test("rejects rows outside coverage and non-VN countries", () => {
    const hanoi = validateStagedRow(
      {
        businessName: "Cha Ca",
        name: "Chả Cá Lã Vọng",
        address: "14 Cha Ca, Hoan Kiem",
        area: "Hoàn Kiếm",
        countryCode: "VN",
        longitude: "105.854",
        latitude: "21.028",
        cuisineSlugs: undefined,
        sourceRecordId: "hn-1",
        observedAt: undefined,
        sourceUrl: undefined,
      },
      0,
      jobUrl,
    );

    expect(hanoi.staged).toBeNull();
    expect(hanoi.errors.some((message) => message.includes("Ho Chi Minh City"))).toBe(true);

    const foreign = validateStagedRow(
      {
        businessName: "B",
        name: "N",
        address: "A",
        area: "Area",
        countryCode: "US",
        longitude: "106.7",
        latitude: "10.77",
        cuisineSlugs: undefined,
        sourceRecordId: undefined,
        observedAt: undefined,
        sourceUrl: undefined,
      },
      1,
      jobUrl,
    );

    expect(foreign.staged).toBeNull();
    expect(foreign.errors.some((message) => message.includes("VN"))).toBe(true);
  });

  test("requires provenance and warns on unreviewed cuisines and missing ids", () => {
    const check = validateStagedRow(
      {
        businessName: "B",
        name: "N",
        address: "A",
        area: "Area",
        countryCode: "VN",
        longitude: "106.7",
        latitude: "10.77",
        cuisineSlugs: "vietnamese",
        sourceRecordId: undefined,
        observedAt: undefined,
        sourceUrl: undefined,
      },
      2,
      null,
    );

    expect(check.staged).toBeNull();
    expect(check.errors.some((message) => message.includes("provenance"))).toBe(true);

    const warned = validateStagedRow(
      {
        businessName: "B",
        name: "N",
        address: "A",
        area: "Area",
        countryCode: "VN",
        longitude: "106.7",
        latitude: "10.77",
        cuisineSlugs: "vietnamese",
        sourceRecordId: undefined,
        observedAt: undefined,
        sourceUrl: undefined,
      },
      3,
      jobUrl,
    );

    expect(warned.staged).not.toBeNull();
    expect(warned.warnings.some((message) => message.includes("cuisine"))).toBe(true);
    expect(warned.warnings.some((message) => message.includes("reimports"))).toBe(true);
  });
});

describe("needsLicenseReview", () => {
  test("reviewed first-party licenses pass without acknowledgement", () => {
    expect(needsLicenseReview("manual:manual-entry")).toBe(false);
    expect(needsLicenseReview("cc0")).toBe(false);
  });

  test("missing, unknown, and Overture other licenses require review", () => {
    expect(needsLicenseReview(null)).toBe(true);
    expect(needsLicenseReview("")).toBe(true);
    expect(needsLicenseReview("other")).toBe(true);
    expect(needsLicenseReview("partner:other")).toBe(true);
  });
});

describe("overtureReleaseError", () => {
  test("requires a pinned release and dataset version for Overture", () => {
    expect(overtureReleaseError(OVERTURE_SOURCE_NAME, null, null)).not.toBeNull();
    expect(overtureReleaseError(OVERTURE_SOURCE_NAME, "2026-10.0", null)).not.toBeNull();
    expect(overtureReleaseError(OVERTURE_SOURCE_NAME, "2026-10.0", "2026-10.0")).toBeNull();
  });

  test("manual sources are not pinned", () => {
    expect(overtureReleaseError("Manual curator entry", null, null)).toBeNull();
  });
});
