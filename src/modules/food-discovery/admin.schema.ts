import { z } from "zod";

/**
 * Client-safe transport schemas for the admin dashboard and import studio.
 * File bytes are re-parsed and re-validated on the server; the client
 * preview (name, size, detected records) is never trusted.
 */

export const MAX_IMPORT_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Transport bound: at most this many records travel in ONE stage/apply
 * server call. The per-call budget (transaction size, 60 s function budget)
 * is what this caps — NOT the logical dataset. Batches chain by cursor to
 * any size up to MAX_BATCHED_IMPORT_RECORDS. Kept at 100 so the existing
 * single-shot upload path (one transaction per call) stays within its
 * proven budget.
 */
export const MAX_IMPORT_RECORDS = 100;

/**
 * Logical-import bound: one job id, one provenance row, one review/apply
 * flow covers at most this many records, staged and applied in bounded
 * batches. Sized so the verified 4,474-record real dataset (and 2x headroom
 * beyond the 10,000-record target) imports without splitting files.
 */
export const MAX_BATCHED_IMPORT_RECORDS = 20_000;

/**
 * Single source of truth for import-job lifecycle states, mirroring the
 * database CHECK constraint (see V20261028_013). Route-level copies
 * previously omitted "applying" (jobs claimed for crash-safe resume) and
 * crashed on honest server data — always import this instead of
 * redeclaring the union.
 */
export const importJobStatusSchema = z.enum([
  "staged",
  "validated",
  "applying",
  "applied",
  "failed",
]);

export type ImportJobStatus = z.infer<typeof importJobStatusSchema>;

const sourceIdSchema = z.enum(["manual", "partner", "community", "other"]);

export type ImportSourceId = z.infer<typeof sourceIdSchema>;

export const importLicenseSchema = z.enum([
  "manual-entry",
  "partner-agreement",
  "permission-granted",
  "public-domain",
  "cc0",
  "cc-by",
  "cc-by-sa",
  "unknown",
  "other",
]);

export type ImportLicense = z.infer<typeof importLicenseSchema>;

/** Reviewed source registry: approved sources carry their reuse rules. */
export const SOURCE_REGISTRY: ReadonlyArray<{
  readonly id: ImportSourceId;
  readonly label: string;
  readonly reuseRule: string;
}> = [
  {
    id: "manual",
    label: "Manual curator entry",
    reuseRule: "Entered by a curator; the curator is responsible for accuracy.",
  },
  {
    id: "partner",
    label: "Partner dataset",
    reuseRule: "Reuse only under the signed partner agreement; keep attribution.",
  },
  {
    id: "community",
    label: "Community contribution",
    reuseRule: "Treat as unverified until a curator reviews every record.",
  },
  {
    id: "other",
    label: "Other / unlisted source",
    reuseRule: "Always requires manual license review before import.",
  },
];

const LICENSES_NEEDING_REVIEW: ReadonlySet<string> = new Set(["unknown", "other"]);

/** Unknown or ambiguous sources must be flagged for manual license review. */
export const needsLicenseReview = (sourceId: string, license: string): boolean =>
  sourceId === "other" || sourceId === "community" || LICENSES_NEEDING_REVIEW.has(license);

export const adminImportSourceSchema = z.object({
  sourceId: sourceIdSchema,
  sourceName: z.string().trim().min(1).max(200),
  sourceUrl: z.string().trim().max(2000).optional(),
  sourceVersion: z.string().trim().max(200).optional(),
  license: importLicenseSchema,
  attribution: z.string().trim().max(2000).optional(),
  editorialNotes: z.string().trim().max(2000).optional(),
});

export type AdminImportSource = z.infer<typeof adminImportSourceSchema>;

export const adminImportUploadSchema = adminImportSourceSchema.extend({
  fileName: z.string().trim().min(1).max(300),
  fileSize: z.number().int().min(1).max(MAX_IMPORT_FILE_BYTES),
  fileType: z.enum(["json", "csv"]),
  contentText: z.string().min(1).max(MAX_IMPORT_FILE_BYTES),
});

export type AdminImportUpload = z.infer<typeof adminImportUploadSchema>;

export const adminImportApplySchema = z.object({
  jobId: z.string().regex(/^[0-9]+$/, "job id must be a decimal id string"),
});

/**
 * Bulk editorial publish transport (bounded per call):
 * candidates pages review rows; publish flips at most 50 explicit ids or
 * one ≤50 job window per call. Both acks are literals so a missing or
 * false checkbox fails closed at the transport boundary.
 */
export const bulkPublishAcksSchema = z.object({
  editorialAck: z.literal(true),
  licenseAck: z.literal(true),
});

export const adminBulkReviewCandidatesSchema = z.object({
  cursor: z
    .string()
    .regex(/^[0-9]+$/, "cursor must be a decimal id string")
    .default("0"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  jobId: z
    .string()
    .regex(/^[0-9]+$/, "job id must be a decimal id string")
    .nullish(),
});

export type AdminBulkReviewCandidates = z.infer<typeof adminBulkReviewCandidatesSchema>;

export const adminBulkPublishSchema = z.object({
  ids: z
    .array(z.string().regex(/^[0-9]+$/, "dish id must be a decimal id string"))
    .min(1)
    .max(50),
  acks: bulkPublishAcksSchema,
});

export type AdminBulkPublish = z.infer<typeof adminBulkPublishSchema>;

export const adminBulkPublishJobSchema = z.object({
  jobId: z.string().regex(/^[0-9]+$/, "job id must be a decimal id string"),
  cursor: z
    .string()
    .regex(/^[0-9]+$/, "cursor must be a decimal id string")
    .default("0"),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  acks: bulkPublishAcksSchema,
});

export type AdminBulkPublishJob = z.infer<typeof adminBulkPublishJobSchema>;

/**
 * Batched import protocol (one logical job, bounded calls):
 * begin reserves the job with the declared total; stageBatch appends one
 * window of records at baseIndex (must equal the server's staged_count
 * cursor); applyBatch applies one window of validated rows; issues pages
 * through staged records without loading them all. The client parses the
 * file locally and sends each batch once — the full file is never resent.
 */
export const adminImportBeginSchema = adminImportSourceSchema.extend({
  fileName: z.string().trim().min(1).max(300),
  fileType: z.enum(["json", "csv"]),
  totalRecords: z.number().int().min(1).max(MAX_BATCHED_IMPORT_RECORDS),
});

export type AdminImportBegin = z.infer<typeof adminImportBeginSchema>;

export const adminImportStageBatchSchema = z.object({
  jobId: z.string().regex(/^[0-9]+$/, "job id must be a decimal id string"),
  baseIndex: z.number().int().min(0),
  records: z.array(z.unknown()).min(1).max(MAX_IMPORT_RECORDS),
});

export type AdminImportStageBatch = z.infer<typeof adminImportStageBatchSchema>;

export const adminImportApplyBatchSchema = adminImportApplySchema.extend({
  approvals: z.object({
    licenseAck: z.boolean(),
    reviewAck: z.boolean(),
    duplicateRefs: z.array(z.string().min(1).max(300)),
  }),
  limit: z.coerce.number().int().min(1).max(MAX_IMPORT_RECORDS).default(MAX_IMPORT_RECORDS),
});

export type AdminImportApplyBatch = z.infer<typeof adminImportApplyBatchSchema>;

export const adminImportIssueStatusSchema = z.enum([
  "pending",
  "valid",
  "invalid",
  "applied",
  "skipped_duplicate",
]);

export const adminImportIssuesQuerySchema = z.object({
  jobId: z.string().regex(/^[0-9]+$/, "job id must be a decimal id string"),
  status: adminImportIssueStatusSchema.nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z
    .string()
    .regex(/^[0-9]+$/, "cursor must be a decimal id string")
    .default("0"),
});

export type AdminImportIssuesQuery = z.infer<typeof adminImportIssuesQuerySchema>;

export const adminDishesQuerySchema = z.object({
  status: z.enum(["draft", "review", "published", "archived"]).default("review"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .regex(/^[0-9]+$/, "cursor must be a decimal id string")
    .default("0"),
});

export const adminReviewsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .regex(/^[0-9]+$/, "cursor must be a decimal id string")
    .default("0"),
});

export const adminJobQuerySchema = z.object({
  jobId: z.string().regex(/^[0-9]+$/, "job id must be a decimal id string"),
  recordLimit: z.coerce.number().int().min(1).max(200).default(100),
});

const MAX_CSV_FIELDS = 12;

const CSV_COLUMNS: ReadonlySet<string> = new Set([
  "slug",
  "status",
  "parent_slug",
  "name",
  "language_tag",
  "name_kind",
  "description",
  "ingredients",
  "places",
  "cuisines",
  "categories",
  "editorial_note",
]);

/**
 * Minimal RFC 4180 reader: quoted fields, escaped double quotes, CRLF.
 * Deliberately small — the import studio documents exactly one CSV shape,
 * so the parser only needs to handle that shape correctly.
 *
 * Strictness (editorial imports must fail loudly, never corrupt silently):
 * - A `"` opening a quoted field must be the first character of the field;
 *   a stray `"` mid-field is rejected.
 * - A closing `"` must be followed by comma, CRLF/LF, or EOF; anything
 *   else (e.g. `"abc"def`) is rejected. Doubled `""` inside quoted fields
 *   stays legal as an escaped quote.
 * - A row that parses to a single empty/whitespace-only field is treated
 *   as a blank line and skipped (covers the trailing newline and stray
 *   blank lines); any other all-empty row (e.g. `,,` under a 2-column
 *   header) keeps its field count and fails the exact-width check in
 *   `csvToRecords` instead of being silently dropped.
 */
const parseCsvRows = (text: string): Array<Array<string>> => {
  const rows: Array<Array<string>> = [];
  let current: Array<string> = [];
  let field = "";
  let quoted = false;
  let index = 0;

  const sheetRow = (): number => rows.length + 1;

  const pushField = (): void => {
    current.push(field);
    field = "";
  };

  const pushRow = (): void => {
    current.push(field);
    field = "";
    rows.push(current);
    current = [];
  };

  while (index < text.length) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }

        quoted = false;
        index += 1;

        const next = index >= text.length ? null : text[index];

        if (next === null) {
          continue;
        }

        if (next === "," || next === "\n") {
          continue;
        }

        if (next === "\r" && text[index + 1] === "\n") {
          continue;
        }

        throw new Error(`row ${sheetRow()}: invalid quote placement`);
      }

      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      if (field.length > 0) {
        throw new Error(`row ${sheetRow()}: invalid quote placement`);
      }

      quoted = true;
      index += 1;
      continue;
    }

    if (char === ",") {
      pushField();
      index += 1;
      continue;
    }

    if (char === "\r" && text[index + 1] === "\n") {
      pushRow();
      index += 2;
      continue;
    }

    if (char === "\n") {
      pushRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  if (quoted) {
    throw new Error(`row ${sheetRow()}: unterminated quoted field`);
  }

  if (field.length > 0 || current.length > 0) {
    pushRow();
  }

  return rows.filter((row) => !(row.length === 1 && (row[0] ?? "").trim().length === 0));
};

const splitList = (value: string): Array<string> =>
  value
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/**
 * Places-cell splitter: entries are separated by `;` or `,`.
 * Only the `places` column uses this — other list columns keep `;` so
 * commas inside ingredient names stay intact. Place entries (`ISO`,
 * `place:<id>`, `City@Parent`) never contain commas themselves.
 */
const splitPlaceList = (value: string): Array<string> =>
  value
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const PLACE_ASSOCIATIONS: ReadonlySet<string> = new Set(["origin", "associated", "popular"]);

/**
 * One parsed `places` cell entry: an ISO code, an internal registry place
 * id, or a city/locality display name optionally scoped by a parent ISO —
 * plus its place association. Exactly one of `iso`/`place_id`/`city` is
 * set; validation resolves the reference downstream and reports unknown
 * ids/isos/cities as actionable review issues (never silent fallbacks).
 */
interface CsvPlaceEntry {
  readonly iso?: string;
  readonly place_id?: string;
  readonly city?: string;
  readonly parent_iso?: string;
  readonly association: string;
}

const PLACE_ID_PREFIX = "place:";
const ISO_PATTERN = /^[A-Za-z]{2}(-[A-Za-z0-9]{1,3})?$/;

/**
 * One `places` cell entry: `ISO[:association]`, `place:<id>[:association]`,
 * `City@ParentISO[:association]`, or a bare city name `City[:association]`.
 * A bare target of any form claims no origin — all default to `associated`;
 * only an explicit `:origin` suffix records an origin claim. City-level
 * links may use the registry id (`place:<id>`) or the portable
 * `City@Parent` form (e.g. `Hanoi@VN:popular`); bare city names must resolve
 * unambiguously at validation or are reported as review issues. The
 * association match is case-insensitive and surrounding whitespace is
 * ignored. `sheetRow` is the 1-based spreadsheet row (header is row 1) so
 * errors point at the offending line.
 */
const parsePlaceEntry = (entry: string, sheetRow: number): CsvPlaceEntry => {
  if (entry.trim().toLowerCase().startsWith(PLACE_ID_PREFIX)) {
    return parsePlaceIdEntry(entry, sheetRow);
  }

  const separator = entry.indexOf(":");
  const head = (separator === -1 ? entry : entry.slice(0, separator)).trim();
  const rawAssociation = separator === -1 ? "" : entry.slice(separator + 1).trim();
  const association = rawAssociation === "" ? "associated" : rawAssociation.toLowerCase();

  if (head.length === 0) {
    throw new Error(`row ${sheetRow}: invalid place entry "${entry}"`);
  }

  if (!PLACE_ASSOCIATIONS.has(association)) {
    throw new Error(`row ${sheetRow}: unsupported place association "${rawAssociation}"`);
  }

  const atSign = head.lastIndexOf("@");

  if (atSign !== -1) {
    const city = head.slice(0, atSign).trim();
    const parentIso = head.slice(atSign + 1).trim();

    if (city.length === 0 || parentIso.length === 0) {
      throw new Error(`row ${sheetRow}: invalid place entry "${entry}"`);
    }

    return { city, parent_iso: parentIso, association };
  }

  if (ISO_PATTERN.test(head)) {
    return { iso: head, association };
  }

  return { city: head, association };
};

/**
 * `place:<decimal id>[:association]` entries: registry-id references for
 * city-level (or any sub-country) links. The id must be a non-empty decimal
 * string and at most one association suffix may follow; anything else
 * (empty id, non-numeric id, extra segments) is rejected at parse time so
 * the curator fixes the cell instead of shipping a dangling link. Unknown
 * numeric ids are still reported later by validation as review issues.
 */
const parsePlaceIdEntry = (entry: string, sheetRow: number): CsvPlaceEntry => {
  const withoutPrefix = entry.trim().slice(PLACE_ID_PREFIX.length);
  const segments = withoutPrefix.split(":");

  if (segments.length > 2) {
    throw new Error(`row ${sheetRow}: invalid place entry "${entry}"`);
  }

  const rawId = (segments[0] ?? "").trim();

  if (!/^[0-9]+$/.test(rawId)) {
    throw new Error(`row ${sheetRow}: invalid place id "${rawId}" in "${entry}"`);
  }

  if (segments.length === 1) {
    return { place_id: rawId, association: "associated" };
  }

  const rawAssociation = (segments[1] ?? "").trim();
  const association = rawAssociation.toLowerCase();

  if (!PLACE_ASSOCIATIONS.has(association)) {
    throw new Error(`row ${sheetRow}: unsupported place association "${rawAssociation}"`);
  }

  return { place_id: rawId, association };
};

/**
 * Documented CSV shape: one row per dish, one name per dish.
 * Columns: slug,status,parent_slug,name,language_tag,name_kind,
 * description,ingredients,places,cuisines,categories,editorial_note.
 * Multi-value cells use `;` separators (ingredient names, place entries,
 * cuisine/category slugs); the `places` cell additionally accepts `,`.
 * Each `places` entry is `ISO[:association]`, `place:<id>[:association]`,
 * `City@ParentISO[:association]`, or a bare city name, where association is
 * one of `origin`, `associated`, or `popular`; a bare target of any form
 * means `associated`, never `origin`. Unknown ingredients, places, cuisines,
 * or categories are reported as review issues by validation, not silently
 * dropped.
 */
export const csvToRecords = (text: string): Array<unknown> => {
  const rows = parseCsvRows(text);

  if (rows.length < 2) {
    throw new Error("CSV needs a header row and at least one data row");
  }

  const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());

  if (header.length > MAX_CSV_FIELDS) {
    throw new Error(`CSV has ${header.length} columns; at most ${MAX_CSV_FIELDS} are supported`);
  }

  const seenColumns = new Set<string>();

  for (const column of header) {
    if (seenColumns.has(column)) {
      throw new Error(`duplicate CSV column "${column}"`);
    }

    seenColumns.add(column);
  }

  const nameIndex = header.indexOf("name");

  if (nameIndex === -1) {
    throw new Error('CSV header must include a "name" column');
  }

  for (const column of header) {
    if (!CSV_COLUMNS.has(column)) {
      throw new Error(`unsupported CSV column "${column}"`);
    }
  }

  return rows.slice(1).map((row, rowNumber) => {
    // Every data row must match the header width exactly: too few or too
    // many fields is malformed (e.g. an extra unescaped comma), never
    // silently truncated or padded. Blank single-field lines were already
    // skipped by parseCsvRows; wider all-empty rows fail here by design.
    if (row.length !== header.length) {
      throw new Error(
        `row ${rowNumber + 2}: expected ${header.length} columns but found ${row.length}`,
      );
    }

    const cell = (column: string): string => {
      const position = header.indexOf(column);

      if (position === -1) {
        return "";
      }

      return (row[position] ?? "").trim();
    };

    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- untrusted CSV cells; the ImportPayload Effect Schema in validateImport establishes the record contract downstream.
    const record: Record<string, unknown> = {
      names: [
        {
          language_tag: cell("language_tag") === "" ? "en" : cell("language_tag"),
          name: cell("name"),
          name_kind: cell("name_kind") === "" ? "localized" : cell("name_kind"),
        },
      ],
    };

    if (cell("slug") !== "") {
      record.slug = cell("slug");
    }

    if (cell("status") !== "") {
      record.status = cell("status");
    }

    if (cell("parent_slug") !== "") {
      record.parent_slug = cell("parent_slug");
    }

    if (cell("description") !== "") {
      record.descriptions = [
        {
          language_tag: cell("language_tag") === "" ? "en" : cell("language_tag"),
          description: cell("description"),
          summary: null,
        },
      ];
    }

    const ingredients = splitList(cell("ingredients"));

    if (ingredients.length > 0) {
      record.ingredients = ingredients.map((name) => ({ name, role: "common" }));
    }

    const places = splitPlaceList(cell("places"));

    if (places.length > 0) {
      record.places = places.map((entry) => parsePlaceEntry(entry, rowNumber + 2));
    }

    const cuisines = splitList(cell("cuisines"));

    if (cuisines.length > 0) {
      record.cuisines = cuisines;
    }

    const categories = splitList(cell("categories"));

    if (categories.length > 0) {
      record.categories = categories;
    }

    if (cell("editorial_note") !== "") {
      record.editorial_note = cell("editorial_note");
    }

    if (cell("name") === "") {
      throw new Error(`row ${rowNumber + 2}: "name" is required`);
    }

    return record;
  });
};

const checkRecordArray = (records: Array<unknown>): Array<unknown> => {
  if (!Array.isArray(records)) {
    throw new Error('JSON must be an array or an object with a "records" array');
  }

  if (records.length === 0) {
    throw new Error("dataset contains no records");
  }

  // Dataset-level guard only: the 100-record single-transaction bound lives
  // in the stage/apply batch schemas (and the legacy single-shot path), so
  // large real datasets parse here and travel in bounded batches instead of
  // being rejected outright.
  if (records.length > MAX_BATCHED_IMPORT_RECORDS) {
    throw new Error(
      `dataset has ${records.length} records; at most ${MAX_BATCHED_IMPORT_RECORDS} per import job`,
    );
  }

  return records;
};

const jsonEnvelopeSchema = z.union([
  z.array(z.unknown()),
  z.object({ records: z.array(z.unknown()) }),
]);

/** Documented JSON shape: `{ "records": [...] }` or a bare `[...]` array. */
export const jsonToRecords = (text: string): Array<unknown> => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("file is not valid JSON");
  }

  const envelope = jsonEnvelopeSchema.safeParse(parsed);

  if (!envelope.success) {
    throw new Error('JSON must be an array or an object with a "records" array');
  }

  const records = Array.isArray(envelope.data) ? envelope.data : envelope.data.records;

  return checkRecordArray(records);
};

export const recordsFromUpload = (fileType: "json" | "csv", text: string): Array<unknown> =>
  fileType === "json" ? jsonToRecords(text) : csvToRecords(text);

/** Canonical FeastJourney JSON template offered as a download in the studio. */
export const FEASTJOURNEY_JSON_TEMPLATE = `{
  "records": [
    {
      "slug": "pho-bo-vietnam",
      "status": "review",
      "names": [
        {
          "language_tag": "vi",
          "name": "Phở bò",
          "name_kind": "native"
        },
        {
          "language_tag": "en",
          "name": "Beef pho",
          "name_kind": "localized"
        }
      ],
      "descriptions": [
        {
          "language_tag": "en",
          "description": "Vietnamese beef noodle soup with flat rice noodles in an aromatic broth.",
          "summary": null
        }
      ],
      "ingredients": [
        { "name": "rice noodles", "role": "core" },
        { "name": "beef", "role": "core" }
      ],
      "places": [
        { "iso": "VN", "association": "origin" },
        { "city": "Hanoi", "parent_iso": "VN", "association": "popular" }
      ],
      "cuisines": ["vietnamese"],
      "categories": ["noodles"],
      "editorial_note": "Seeded from the documented template; verify ingredients with a local cook."
    }
  ]
}
`;

/**
 * Dish-editing transport schemas (curator dish editor). Every mutation uses
 * explicit `{ upsert, remove }` semantics: rows carry their record ids, so
 * an edit never inserts a duplicate and a removal never recreates the dish.
 * Place targets reuse the canonical `placeRefSchema` contract
 * (`place.schema.ts`): registry id, ISO code, or city name with optional
 * parent-ISO scoping. All mutations enforce `food:update` at the server
 * boundary; status transitions to `published` additionally require
 * `food:publish`, exactly like the dish-status endpoint.
 */

const dishIdInputSchema = z.string().regex(/^[0-9]+$/, "dish id must be a decimal id string");

const dishSlugInputSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase alphanumeric with hyphens")
  .max(120);

const dishNameKindSchema = z.enum(["native", "localized", "alias", "transliteration"]);

const dishLanguageTagSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z]{2,8})?$/, "language_tag must be a BCP 47 tag");

const dishIsoInputSchema = z.string().trim().min(1).max(10);

const dishPlaceRefSchema = z.union([
  z.object({ placeId: dishIdInputSchema }),
  z.object({ iso: dishIsoInputSchema }),
  z.object({
    city: z.string().trim().min(1).max(300),
    parentIso: dishIsoInputSchema.optional(),
  }),
]);

export type AdminDishPlaceRef = z.infer<typeof dishPlaceRefSchema>;

export const adminUpdateDishFieldsSchema = z.object({
  dishId: dishIdInputSchema,
  slug: dishSlugInputSchema.optional(),
  parentSlug: dishSlugInputSchema.nullish(),
  status: z.enum(["draft", "review", "published", "archived"]).optional(),
});

export type AdminUpdateDishFields = z.infer<typeof adminUpdateDishFieldsSchema>;

const dishNameUpsertSchema = z.object({
  id: dishIdInputSchema.optional(),
  languageTag: dishLanguageTagSchema,
  name: z.string().trim().min(1).max(300),
  nameKind: dishNameKindSchema,
  isPreferred: z.boolean().optional(),
});

export const adminUpdateDishNamesSchema = z.object({
  dishId: dishIdInputSchema,
  upsert: z.array(dishNameUpsertSchema).max(50).default([]),
  removeIds: z.array(dishIdInputSchema).max(50).default([]),
});

export type AdminUpdateDishNames = z.infer<typeof adminUpdateDishNamesSchema>;

const dishDescriptionUpsertSchema = z.object({
  languageTag: dishLanguageTagSchema,
  description: z.string().min(1).max(20000),
  summary: z.string().max(1000).nullable().default(null),
});

export const adminUpdateDishDescriptionsSchema = z.object({
  dishId: dishIdInputSchema,
  upsert: z.array(dishDescriptionUpsertSchema).max(50).default([]),
  removeLanguageTags: z.array(dishLanguageTagSchema).max(50).default([]),
});

export type AdminUpdateDishDescriptions = z.infer<typeof adminUpdateDishDescriptionsSchema>;

const dishIngredientUpsertSchema = z.object({
  ingredientId: dishIdInputSchema,
  role: z.enum(["core", "common", "optional", "garnish"]),
});

export const adminUpdateDishIngredientsSchema = z.object({
  dishId: dishIdInputSchema,
  upsert: z.array(dishIngredientUpsertSchema).max(50).default([]),
  removeIngredientIds: z.array(dishIdInputSchema).max(50).default([]),
});

export type AdminUpdateDishIngredients = z.infer<typeof adminUpdateDishIngredientsSchema>;

const taxonomySlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase alphanumeric with hyphens")
  .max(80);

export const adminUpdateDishTaxonomySchema = z.object({
  dishId: dishIdInputSchema,
  cuisineUpsert: z.array(taxonomySlugSchema).max(50).default([]),
  cuisineRemove: z.array(taxonomySlugSchema).max(50).default([]),
  categoryUpsert: z.array(taxonomySlugSchema).max(50).default([]),
  categoryRemove: z.array(taxonomySlugSchema).max(50).default([]),
});

export type AdminUpdateDishTaxonomy = z.infer<typeof adminUpdateDishTaxonomySchema>;

const dishPlaceUpsertSchema = z.object({
  place: dishPlaceRefSchema,
  association: z.enum(["origin", "associated", "popular"]).optional(),
  isDisputed: z.boolean().optional(),
  note: z.string().max(2000).nullable().optional(),
});

export const adminUpdateDishPlacesSchema = z.object({
  dishId: dishIdInputSchema,
  upsert: z.array(dishPlaceUpsertSchema).max(50).default([]),
  removePlaceIds: z.array(dishIdInputSchema).max(50).default([]),
});

export type AdminUpdateDishPlaces = z.infer<typeof adminUpdateDishPlacesSchema>;
