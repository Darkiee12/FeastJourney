import { describe, expect, test } from "bun:test";

import { csvToRecords } from "@/modules/food-discovery/admin.schema";

describe("csvToRecords places grammar", () => {
  test("bare ISO codes default to associated, never origin", () => {
    expect(csvToRecords("name,places\nPho,VN\n")).toEqual([
      {
        names: [{ language_tag: "en", name: "Pho", name_kind: "localized" }],
        places: [{ iso: "VN", association: "associated" }],
      },
    ]);
  });

  test("explicit :origin and :popular suffixes are preserved", () => {
    expect(csvToRecords("name,places\nPho,VN:origin\n")).toEqual([
      {
        names: [{ language_tag: "en", name: "Pho", name_kind: "localized" }],
        places: [{ iso: "VN", association: "origin" }],
      },
    ]);

    expect(csvToRecords("name,places\nPho,FR:popular\n")).toEqual([
      {
        names: [{ language_tag: "en", name: "Pho", name_kind: "localized" }],
        places: [{ iso: "FR", association: "popular" }],
      },
    ]);
  });

  test("association suffixes match case-insensitively", () => {
    expect(csvToRecords("name,places\nPho,vn:Origin\n")).toEqual([
      {
        names: [{ language_tag: "en", name: "Pho", name_kind: "localized" }],
        places: [{ iso: "vn", association: "origin" }],
      },
    ]);
  });

  test("surrounding whitespace around ISO and association is tolerated", () => {
    expect(csvToRecords("name,places\nPho, VN : popular \n")).toEqual([
      {
        names: [{ language_tag: "en", name: "Pho", name_kind: "localized" }],
        places: [{ iso: "VN", association: "popular" }],
      },
    ]);
  });

  test("mixed cells yield each entry with its own association", () => {
    expect(csvToRecords("name,places\nPho,VN:origin;FR:popular;DE\n")).toEqual([
      {
        names: [{ language_tag: "en", name: "Pho", name_kind: "localized" }],
        places: [
          { iso: "VN", association: "origin" },
          { iso: "FR", association: "popular" },
          { iso: "DE", association: "associated" },
        ],
      },
    ]);
  });

  test("empty entries after splitting are ignored", () => {
    expect(csvToRecords("name,places\nPho,VN;; DE\n")).toEqual([
      {
        names: [{ language_tag: "en", name: "Pho", name_kind: "localized" }],
        places: [
          { iso: "VN", association: "associated" },
          { iso: "DE", association: "associated" },
        ],
      },
    ]);
  });

  test("unknown associations throw naming the 1-based data row", () => {
    expect(() => csvToRecords("name,places\nPho,VN:homeland\n")).toThrow(
      'row 2: unsupported place association "homeland"',
    );

    expect(() => csvToRecords("name,places\nPho,VN\nBun,FR:homeland\n")).toThrow(
      'row 3: unsupported place association "homeland"',
    );
  });

  test("place:<id> entries resolve to canonical place ids for city-level links", () => {
    expect(csvToRecords("name,places\nPho,place:264\n")).toEqual([
      {
        names: [{ language_tag: "en", name: "Pho", name_kind: "localized" }],
        places: [{ place_id: "264", association: "associated" }],
      },
    ]);

    expect(csvToRecords("name,places\nPho,place:264:origin\n")).toEqual([
      {
        names: [{ language_tag: "en", name: "Pho", name_kind: "localized" }],
        places: [{ place_id: "264", association: "origin" }],
      },
    ]);

    expect(csvToRecords("name,places\nPho,VN;place:264:popular\n")).toEqual([
      {
        names: [{ language_tag: "en", name: "Pho", name_kind: "localized" }],
        places: [
          { iso: "VN", association: "associated" },
          { place_id: "264", association: "popular" },
        ],
      },
    ]);
  });

  test("malformed place:<id> entries throw naming the 1-based data row", () => {
    expect(() => csvToRecords("name,places\nPho,place:abc\n")).toThrow("row 2: invalid place id");

    expect(() => csvToRecords("name,places\nPho,place:\n")).toThrow("row 2: invalid place id");

    expect(() => csvToRecords("name,places\nPho,place:264:homeland\n")).toThrow(
      'row 2: unsupported place association "homeland"',
    );
  });
});

describe("csvToRecords existing behaviors", () => {
  test("parses the documented CSV shape with quoted fields", () => {
    const records = csvToRecords(
      'slug,status,name,language_tag,ingredients,places\n"my-dish",review,"Good, Tasty Dish",en,"rice; beans",VN\n',
    );

    expect(records.length).toBe(1);

    const serialized = JSON.stringify(records[0]);

    expect(serialized).toContain("Good, Tasty Dish");
    expect(serialized).toContain("beans");
  });

  test("rejects CSV with unknown columns", () => {
    expect(() => csvToRecords("name,frobnicate\nx\n")).toThrow(
      'unsupported CSV column "frobnicate"',
    );
  });

  test("rejects data rows without a name", () => {
    expect(() => csvToRecords("name,places\n,VN\n")).toThrow('row 2: "name" is required');
  });
});

describe("csvToRecords strict validation", () => {
  test("rejects exact duplicate headers naming the column", () => {
    expect(() => csvToRecords("name,name\nPho,Bun\n")).toThrow('duplicate CSV column "name"');
  });

  test("rejects case-variant duplicates after trimming", () => {
    expect(() => csvToRecords("Name,NAME\nPho,Bun\n")).toThrow('duplicate CSV column "name"');

    expect(() => csvToRecords(" name , Name \nPho,Bun\n")).toThrow('duplicate CSV column "name"');
  });

  test("rejects short rows naming the spreadsheet row", () => {
    expect(() => csvToRecords("name,places\nPho\n")).toThrow(
      "row 2: expected 2 columns but found 1",
    );

    expect(() => csvToRecords("name,places\nPho,VN\nBun\n")).toThrow(
      "row 3: expected 2 columns but found 1",
    );
  });

  test("rejects long rows with extra unescaped commas instead of truncating", () => {
    expect(() => csvToRecords("name,places\nPho,VN,extra\n")).toThrow(
      "row 2: expected 2 columns but found 3",
    );
  });

  test("rejects stray quotes mid-field", () => {
    expect(() => csvToRecords('name\nab"cd\n')).toThrow("row 2: invalid quote placement");
  });

  test("rejects closing quotes not followed by a delimiter", () => {
    expect(() => csvToRecords('name\n"abc"def\n')).toThrow("row 2: invalid quote placement");
  });

  test("rejects unterminated quoted fields", () => {
    expect(() => csvToRecords('name\n"abc\n')).toThrow("unterminated quoted field");
  });

  test("keeps quoted commas, newlines, and escaped quotes legal", () => {
    const records = csvToRecords('name,description\n"Pho, tasty","line1\nline2"\n');

    expect(records.length).toBe(1);

    const serialized = JSON.stringify(records[0]);

    expect(serialized).toContain("Pho, tasty");
    expect(serialized).toContain("line1\\nline2");

    const escaped = csvToRecords('name\n"a""b"\n');

    expect(JSON.stringify(escaped[0])).toContain('a\\"b');
  });
});
