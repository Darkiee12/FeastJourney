/**
 * Restaurant bulk import: staged venue-candidate pipeline (server-only).
 *
 * Owning module: restaurant-discovery. Application operation: Effect v4.
 * Browser-safe: no (imports Reylo SQL and server database plumbing).
 * Transport: route-local TanStack server functions (the shared
 * `restaurant.functions.ts` adapter is coordinator-owned). Authorization is
 * enforced here at the operation boundary, never in the route.
 *
 * Pipeline (ADR 0006): Acquire (manual CSV, manual JSON, pinned Overture
 * release) -> Stage -> Validate -> Deduplicate -> Review -> Apply -> Publish.
 * Applied rows insert `draft` venues; publication stays a separate curator
 * review. No source confidence is ever presented as a customer rating, and
 * no menu or dish evidence is inferred from names or taxonomy.
 *
 * Authorization split: staging/validation/duplicate resolution require
 * `restaurant:manage`; bulk apply additionally requires `restaurant:review`
 * (explicit bulk grant: two human grants, no machine identity). The future
 * single-key grant `restaurant:import` is proposed in the PR report; the
 * static permission vocabulary is coordinator-owned and untouched here.
 */

import { Effect } from "effect";
import { z } from "zod";

import {
  RestaurantInputError,
  RestaurantNotFound,
} from "@/modules/restaurant-discovery/server/operations/discovery";
import businessInsert from "@/modules/restaurant-discovery/server/repository/sql/admin-business.sql";
import sourceInsert from "@/modules/restaurant-discovery/server/repository/sql/admin-source.sql";
import nameInsert from "@/modules/restaurant-discovery/server/repository/sql/admin-venue-name.sql";
import businessFind from "@/modules/restaurant-discovery/server/repository/sql/import-business-find.sql";
import candidatesQuery from "@/modules/restaurant-discovery/server/repository/sql/import-duplicate-candidates.sql";
import exactQuery from "@/modules/restaurant-discovery/server/repository/sql/import-duplicate-exact.sql";
import jobApplyProgress from "@/modules/restaurant-discovery/server/repository/sql/import-job-apply-progress.sql";
import jobApprove from "@/modules/restaurant-discovery/server/repository/sql/import-job-approve.sql";
import jobClaim from "@/modules/restaurant-discovery/server/repository/sql/import-job-claim.sql";
import jobFind from "@/modules/restaurant-discovery/server/repository/sql/import-job-find.sql";
import jobInsert from "@/modules/restaurant-discovery/server/repository/sql/import-job-insert.sql";
import jobLock from "@/modules/restaurant-discovery/server/repository/sql/import-job-lock.sql";
import jobStage from "@/modules/restaurant-discovery/server/repository/sql/import-job-stage.sql";
import jobTryLock from "@/modules/restaurant-discovery/server/repository/sql/import-job-try-lock.sql";
import jobsRecent from "@/modules/restaurant-discovery/server/repository/sql/import-jobs-recent.sql";
import recordByDedup from "@/modules/restaurant-discovery/server/repository/sql/import-record-by-dedup.sql";
import recordCounts from "@/modules/restaurant-discovery/server/repository/sql/import-record-counts.sql";
import recordInsert from "@/modules/restaurant-discovery/server/repository/sql/import-record-insert.sql";
import recordLock from "@/modules/restaurant-discovery/server/repository/sql/import-record-lock.sql";
import recordUpdate from "@/modules/restaurant-discovery/server/repository/sql/import-record-update.sql";
import recordsByJob from "@/modules/restaurant-discovery/server/repository/sql/import-records-by-job.sql";
import recordsPending from "@/modules/restaurant-discovery/server/repository/sql/import-records-pending.sql";
import venueInsert from "@/modules/restaurant-discovery/server/repository/sql/import-venue-insert.sql";
import { Authorization, recordAuditEvent, type UserRepository } from "@/modules/user/server/index";
import { Actor } from "@/server/auth/actor";
import { CurrentActor } from "@/server/auth/current-actor";
import { withTransaction } from "@/server/database/client";
import type { Database } from "@/server/database/client";
import { PersistenceConflict, type TransactionFailed } from "@/server/database/errors";
import type { DatabaseError } from "@/server/database/query";
import { runQuery } from "@/server/database/query";

export type RestaurantImportJobRow = (typeof jobFind)["~reylo"]["element"];

export type RestaurantImportRecordRow = (typeof recordsByJob)["~reylo"]["element"];

export interface CoverageRegion {
  readonly name: string;
  readonly countryCode: string;
  readonly minLongitude: number;
  readonly maxLongitude: number;
  readonly minLatitude: number;
  readonly maxLatitude: number;
}

/** Supported coverage regions for restaurant discovery. (widen here, never in the wizard). */
const PRIMARY_REGION: CoverageRegion = {
  name: "Ho Chi Minh City",
  countryCode: "VN",
  minLongitude: 106.3,
  maxLongitude: 107.1,
  minLatitude: 10.3,
  maxLatitude: 11.2,
};

export const COVERAGE_REGIONS: ReadonlyArray<CoverageRegion> = [
  PRIMARY_REGION,
  {
    name: "Bangalore",
    countryCode: "IN",
    minLongitude: 77.3,
    maxLongitude: 77.9,
    minLatitude: 12.75,
    maxLatitude: 13.3,
  },
  {
    name: "Los Angeles",
    countryCode: "US",
    minLongitude: -118.7,
    maxLongitude: -117.7,
    minLatitude: 33.65,
    maxLatitude: 34.35,
  },
];

export const COVERAGE_BOUNDS: CoverageRegion = PRIMARY_REGION;

/** Trigram floor for fuzzy duplicate candidacy (ADR 0006: within 50 m). */
export const FUZZY_SIMILARITY_THRESHOLD = 0.4;
export const FUZZY_DISTANCE_METERS = 50;

/** Stage cap per job: larger releases split across jobs (cursor-driven
 * validate staging is follow-up work, not this change). */
export const MAX_STAGE_ROWS = 1000;

/** Bounded apply window per call: every call fits the server-function
 * budget; the caller repeats until done. */
export const IMPORT_APPLY_BATCH_SIZE = 100;

/** Licenses that never need a license acknowledgement. Anything else
 * (including missing and `other`, which is what Overture rows carry per
 * ADR 0006) forces an explicit license review before apply. */
const REVIEWED_LICENSES: ReadonlySet<string> = new Set([
  "manual-entry",
  "partner-agreement",
  "permission-granted",
  "public-domain",
  "cc0",
  "cc-by",
  "cc-by-sa",
]);

export const needsLicenseReview = (license: string | null): boolean => {
  if (license === null || license.trim().length === 0) return true;

  const suffix = license.includes(":")
    ? license.split(":").slice(1).join(":").trim()
    : license.trim();

  return !REVIEWED_LICENSES.has(suffix.toLowerCase());
};

export const OVERTURE_SOURCE_NAME = "Overture Maps Places";

/** Reylo reads jsonb projections as text but writes take live values
 * (a pre-stringified string would double-encode). Warnings ride along
 * unchanged; corrupt text degrades to null because warnings are advisory. */
const warningsSchema = z.array(z.string());

const warningsOf = (text: string | null): ReadonlyArray<string> | null => {
  if (text === null) return null;

  try {
    const parsed = warningsSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const overtureReleaseError = (
  sourceName: string,
  release: string | null,
  sourceVersion: string | null,
): string | null => {
  if (sourceName.trim().toLowerCase() !== OVERTURE_SOURCE_NAME.toLowerCase()) return null;

  if (release === null || release.trim().length === 0) {
    return "Pin the Overture release (for example 2026-10.0) before staging";
  }

  if (sourceVersion === null || sourceVersion.trim().length === 0) {
    return "Record the Overture dataset version before staging";
  }

  return null;
};

/** Collapse incidental spacing, then lowercase: the canonical form the
 * exact-match dedup compares. */
export const normalizeVenueText = (value: string): string =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

/** Stable external-identity dedup key `sourceName:datasetVersion:sourceRecordId`.
 * Nullable until assigned: manual rows without a stable source record id
 * never get one, and NULLs never collide in the partial unique index. */
export const dedupKeyFor = (input: {
  readonly sourceName: string;
  readonly datasetVersion: string | null;
  readonly sourceRecordId: string | null;
}): string | null => {
  const name = input.sourceName.trim();
  const version = input.datasetVersion?.trim() ?? "";
  const recordId = input.sourceRecordId?.trim() ?? "";

  if (name.length === 0 || version.length === 0 || recordId.length === 0) return null;

  return `${name}:${version}:${recordId}`;
};

export type DuplicateDecision = "skip" | "review" | "create";

/** ADR 0006 dedup, pure: exact normalized name+address auto-skips, a
 * trigram-similar name within 50 m goes to curator review, everything else
 * is a new candidate. The wizard never auto-merges on fuzzy names. */
export const classifyDuplicateDecision = (input: {
  readonly exactMatch: boolean;
  readonly bestSimilarity: number | null;
  readonly bestDistanceMeters: number | null;
}): DuplicateDecision => {
  if (input.exactMatch) return "skip";

  if (
    input.bestSimilarity !== null &&
    input.bestDistanceMeters !== null &&
    input.bestSimilarity >= FUZZY_SIMILARITY_THRESHOLD &&
    input.bestDistanceMeters <= FUZZY_DISTANCE_METERS
  ) {
    return "review";
  }

  return "create";
};

export const isWithinCoverage = (
  longitude: number,
  latitude: number,
  countryCode?: string,
): boolean =>
  COVERAGE_REGIONS.some(
    (region) =>
      (countryCode === undefined || region.countryCode === countryCode) &&
      Number.isFinite(longitude) &&
      Number.isFinite(latitude) &&
      longitude >= region.minLongitude &&
      longitude <= region.maxLongitude &&
      latitude >= region.minLatitude &&
      latitude <= region.maxLatitude,
  );

export interface ParsedCsv {
  readonly headers: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

/** Minimal CSV parser (quoted fields, escaped quotes, CRLF). Returns null
 * on malformed input (unclosed quote) instead of guessing. */
export const parseCsvText = (text: string): ParsedCsv | null => {
  const rows: Array<Array<string>> = [];
  let current: Array<string> = [];
  let field = "";
  let quoted = false;
  let consumedAny = false;

  const pushField = (): void => {
    current.push(field);
    field = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    consumedAny = true;
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }

      continue;
    }

    if (char === '"') {
      if (field.length === 0) {
        quoted = true;
      } else {
        field += char;
      }

      continue;
    }

    if (char === ",") {
      pushField();
      continue;
    }

    if (char === "\r") continue;

    if (char === "\n") {
      pushField();
      rows.push(current);
      current = [];
      field = "";
      continue;
    }

    field += char;
  }

  if (quoted) return null;

  if (consumedAny) {
    pushField();
    rows.push(current);
  }

  const nonEmpty = rows.filter((row) => row.some((cell) => cell.trim().length > 0));
  const headerRow = nonEmpty[0];

  if (headerRow === undefined) return null;

  return { headers: headerRow.map((cell) => cell.trim()), rows: nonEmpty.slice(1) };
};

const STAGED_FIELDS = [
  "businessName",
  "name",
  "address",
  "area",
  "countryCode",
  "longitude",
  "latitude",
  "cuisineSlugs",
  "sourceRecordId",
  "observedAt",
  "sourceUrl",
] as const;

export type StagedField = (typeof STAGED_FIELDS)[number];

export interface FieldMapping {
  readonly column: string;
  readonly field: StagedField | "ignore";
}

/** Column vocabulary the wizard offers, including the ADR 0006 Overture
 * template headers. Unknown columns are ignored, never rejected. */
export const IMPORT_TEMPLATE_HEADERS: ReadonlyArray<string> = [...STAGED_FIELDS];

export interface StagedRowDraft {
  readonly businessName: string | undefined;
  readonly name: string | undefined;
  readonly address: string | undefined;
  readonly area: string | undefined;
  readonly countryCode: string | undefined;
  readonly longitude: string | undefined;
  readonly latitude: string | undefined;
  readonly cuisineSlugs: string | undefined;
  readonly sourceRecordId: string | undefined;
  readonly observedAt: string | undefined;
  readonly sourceUrl: string | undefined;
}

const EMPTY_DRAFT: StagedRowDraft = {
  businessName: undefined,
  name: undefined,
  address: undefined,
  area: undefined,
  countryCode: undefined,
  longitude: undefined,
  latitude: undefined,
  cuisineSlugs: undefined,
  sourceRecordId: undefined,
  observedAt: undefined,
  sourceUrl: undefined,
};

/** First mapping wins for a repeated field; unknown columns are ignored. */
export const applyFieldMapping = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  mapping: ReadonlyArray<FieldMapping>,
): ReadonlyArray<StagedRowDraft> => {
  const claimed = new Set<StagedField>();
  const picks: Array<{ readonly index: number; readonly field: StagedField }> = [];

  for (const entry of mapping) {
    if (entry.field === "ignore" || claimed.has(entry.field)) continue;
    const index = headers.indexOf(entry.column);

    if (index === -1) continue;
    claimed.add(entry.field);
    picks.push({ index, field: entry.field });
  }

  return rows.map((row) => {
    const draft: StagedRowDraft = { ...EMPTY_DRAFT };

    for (const pick of picks) {
      const cell = row[pick.index]?.trim();

      if (cell === undefined || cell.length === 0) continue;

      Object.assign(draft, { [pick.field]: cell });
    }

    return draft;
  });
};

const stagedRowSchema = z.object({
  businessName: z.string().trim().min(1).max(300),
  name: z.string().trim().min(1).max(300),
  address: z.string().trim().min(1).max(1000),
  area: z.string().trim().min(1).max(200),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
  cuisineSlugs: z.array(z.string().min(1).max(100)).default([]),
  sourceRecordId: z.string().min(1).max(300).nullable(),
  observedAt: z.string().min(1).max(100).nullable(),
  sourceUrl: z.string().url().max(2000).nullable(),
});

export type StagedRow = z.infer<typeof stagedRowSchema>;

export interface RowCheck {
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly staged: StagedRow | null;
  readonly externalRef: string;
}

/** Pure row validation: required fields, bounded geography (HCMC only),
 * provenance URL presence, and advisory warnings. Dedup against stored
 * venues happens in the validate operation, not here. */
export const validateStagedRow = (
  draft: StagedRowDraft,
  index: number,
  jobSourceUrl: string | null,
): RowCheck => {
  const errors: Array<string> = [];
  const warnings: Array<string> = [];
  const externalRef = draft.sourceRecordId?.trim() || `row-${index + 1}`;

  const longitude = draft.longitude === undefined ? Number.NaN : Number(draft.longitude);
  const latitude = draft.latitude === undefined ? Number.NaN : Number(draft.latitude);

  const candidate = {
    businessName: draft.businessName?.trim() ?? "",
    name: draft.name?.trim() ?? "",
    address: draft.address?.trim() ?? "",
    area: draft.area?.trim() ?? "",
    countryCode: draft.countryCode?.trim().toUpperCase() ?? "",
    longitude,
    latitude,
    cuisineSlugs:
      draft.cuisineSlugs === undefined
        ? []
        : draft.cuisineSlugs
            .split(/[;,]/)
            .map((part) => part.trim())
            .filter((part) => part.length > 0),
    sourceRecordId: draft.sourceRecordId?.trim() || null,
    observedAt: draft.observedAt?.trim() || null,
    sourceUrl: draft.sourceUrl?.trim() || jobSourceUrl,
  };

  const parsed = stagedRowSchema.safeParse(candidate);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join(".") || "row"}: ${issue.message}`);
    }
  } else {
    const region = COVERAGE_REGIONS.find((r) => r.countryCode === parsed.data.countryCode);

    if (region === undefined) {
      errors.push(
        `countryCode: only ${COVERAGE_REGIONS.map((r) => r.countryCode).join(", ")} venues are in scope (${COVERAGE_BOUNDS.name} first)`,
      );
    } else if (
      !isWithinCoverage(parsed.data.longitude, parsed.data.latitude, parsed.data.countryCode)
    ) {
      errors.push(`coordinates: outside the ${region.name} coverage bounds`);
    }

    if (parsed.data.sourceUrl === null) {
      errors.push("sourceUrl: a provenance URL is required (row or job level)");
    }

    if (parsed.data.observedAt !== null && Number.isNaN(Date.parse(parsed.data.observedAt))) {
      errors.push("observedAt: must be a parseable date-time");
    }

    if (parsed.data.cuisineSlugs.length > 0) {
      warnings.push(
        "cuisineSlugs: cuisine links are not imported; a curator adds them after apply",
      );
    }

    if (parsed.data.sourceRecordId === null) {
      warnings.push("sourceRecordId: absent, so reimports of this row cannot dedupe");
    }
  }

  // No source confidence is ever presented as a customer rating: validation
  // reports structural facts only, never quality scores.
  if (errors.length > 0) {
    return { errors, warnings, staged: null, externalRef };
  }

  const staged = parsed.success ? parsed.data : null;

  if (staged === null) {
    return {
      errors: ["row: failed validation without details"],
      warnings,
      staged: null,
      externalRef,
    };
  }

  return { errors, warnings, staged, externalRef };
};

/** Template cell: strings pass through, numbers and booleans coerce;
 * objects and arrays are rejected so `[object Object]` never lands in a
 * venue field. Zod owns the boundary; no manual type narrowing. */
const templateCellSchema = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((value) => String(value));

const templateRowSchema = z.record(z.string(), z.unknown());

/** Overture acquire helper: rows already flattened to the template
 * vocabulary pass through untouched; anything else is rejected with the
 * template headers so curators flatten explicitly. Never guesses at
 * Overture's native schema. */
export const templateRowsToDrafts = (rows: ReadonlyArray<unknown>): StagedRowDraft[] => {
  const drafts: Array<StagedRowDraft> = [];

  for (const row of rows) {
    const parsed = templateRowSchema.safeParse(row);

    if (!parsed.success || Array.isArray(row)) {
      throw new Error("Overture rows must be objects flattened to the template vocabulary");
    }

    const draft: StagedRowDraft = { ...EMPTY_DRAFT };

    for (const field of STAGED_FIELDS) {
      const cell = templateCellSchema.safeParse(parsed.data[field]);

      if (!cell.success) continue;

      const text = cell.data.trim();

      if (text.length === 0) continue;

      Object.assign(draft, { [field]: text });
    }

    drafts.push(draft);
  }

  return drafts;
};

const authorizeStage = Effect.gen(function* () {
  const actor = yield* CurrentActor;
  const authorization = yield* Authorization;
  yield* authorization.require(actor, { resource: "restaurant", actions: ["manage"] });

  return Actor.$match(actor, {
    Guest: () => Effect.fail(new RestaurantInputError({ reason: "A verified member is required" })),
    Member: ({ userId }) => Effect.succeed(userId),
  });
}).pipe(Effect.flatten);

const authorizeBulkApply = Effect.gen(function* () {
  const actor = yield* CurrentActor;
  const authorization = yield* Authorization;
  yield* authorization.require(actor, { resource: "restaurant", actions: ["manage"] });
  yield* authorization.require(actor, { resource: "restaurant", actions: ["review"] });

  return Actor.$match(actor, {
    Guest: () => Effect.fail(new RestaurantInputError({ reason: "A verified member is required" })),
    Member: ({ userId }) => Effect.succeed(userId),
  });
}).pipe(Effect.flatten);

export interface StageReport {
  readonly jobId: string;
  readonly status: string;
  readonly stagedCount: number;
  readonly totalRecords: number;
}

export const stageRestaurantImport = Effect.fn("restaurant-import/stage")(function* (input: {
  readonly sourceName: string;
  readonly format: "json" | "csv";
  readonly sourceVersion: string | null;
  readonly release: string | null;
  readonly license: string | null;
  readonly attribution: string | null;
  readonly jobSourceUrl: string | null;
  readonly jsonRecords?: ReadonlyArray<unknown>;
  readonly csvText?: string;
  readonly mapping?: ReadonlyArray<FieldMapping>;
}) {
  const actorId = yield* authorizeStage;

  const sourceName = input.sourceName.trim();

  if (sourceName.length === 0 || sourceName.length > 200) {
    return yield* new RestaurantInputError({
      reason: "source name is required (1-200 characters)",
    });
  }

  const releaseError = overtureReleaseError(sourceName, input.release, input.sourceVersion);

  if (releaseError !== null) return yield* new RestaurantInputError({ reason: releaseError });

  let drafts: ReadonlyArray<StagedRowDraft>;

  if (input.format === "csv") {
    if (input.csvText === undefined || input.mapping === undefined) {
      return yield* new RestaurantInputError({
        reason: "CSV acquire needs file text and a field mapping",
      });
    }

    const parsed = parseCsvText(input.csvText);

    if (parsed === null)
      return yield* new RestaurantInputError({ reason: "CSV is malformed (unclosed quote)" });

    if (parsed.headers.length === 0)
      return yield* new RestaurantInputError({ reason: "CSV has no header row" });
    drafts = applyFieldMapping(parsed.headers, parsed.rows, input.mapping);
  } else {
    const records = input.jsonRecords ?? [];
    drafts = templateRowsToDrafts(records);
  }

  if (drafts.length === 0)
    return yield* new RestaurantInputError({ reason: "No records to stage" });

  if (drafts.length > MAX_STAGE_ROWS) {
    return yield* new RestaurantInputError({
      reason: `Too many records (${drafts.length}); split across jobs of at most ${MAX_STAGE_ROWS}`,
    });
  }

  return yield* withTransaction(
    "restaurant-import/stage",
    Effect.gen(function* () {
      const job = yield* runQuery("restaurant-import/stage-job", (sql) =>
        jobInsert.run(sql, {
          source_name: sourceName,
          source_version: input.sourceVersion?.trim() || null,
          release: input.release?.trim() || null,
          license: input.license?.trim() || null,
          attribution: input.attribution?.trim() || null,
          format: input.format,
          status: "staged",
          total_records: drafts.length,
          valid_records: 0,
          invalid_records: 0,
          dry_run: true,
          created_by: actorId,
        }),
      );

      let index = 0;

      const seenRefs = new Set<string>();
      const seenKeys = new Set<string>();

      for (const draft of drafts) {
        const check = validateStagedRow(draft, index, input.jobSourceUrl?.trim() || null);

        const dedupKey =
          check.staged === null
            ? null
            : dedupKeyFor({
                sourceName,
                datasetVersion: input.sourceVersion?.trim() || null,
                sourceRecordId: check.staged.sourceRecordId,
              });

        const batchDuplicate =
          seenRefs.has(check.externalRef) ||
          (dedupKey !== null && check.errors.length === 0 && seenKeys.has(dedupKey));

        if (batchDuplicate) {
          yield* runQuery("restaurant-import/stage-batch-dup", (sql) =>
            recordInsert.run(sql, {
              job_id: job.id,
              record_index: index,
              external_ref: check.externalRef,
              status: "invalid",
              errors: [`duplicate source record "${check.externalRef}" in this batch`],
              warnings: null,
              venue_id: null,
              duplicate_of: null,
              dedup_key: null,
              payload: check.staged ?? draft,
            }),
          );
          index += 1;

          continue;
        }

        seenRefs.add(check.externalRef);

        if (dedupKey !== null && check.errors.length === 0) seenKeys.add(dedupKey);

        if (dedupKey !== null) {
          const prior = yield* runQuery("restaurant-import/stage-dedup", (sql) =>
            recordByDedup.run(sql, { dedup_key: dedupKey }),
          );

          if (prior !== null) {
            yield* runQuery("restaurant-import/stage-skipped", (sql) =>
              recordInsert.run(sql, {
                job_id: job.id,
                record_index: index,
                external_ref: check.externalRef,
                status: "skipped_duplicate",
                errors: null,
                warnings: ["reimport: external identity already staged"],
                venue_id: prior.venue_id,
                duplicate_of: prior.venue_id,
                dedup_key: null,
                payload: check.staged ?? draft,
              }),
            );
            index += 1;
            continue;
          }
        }

        const status = check.errors.length > 0 ? "invalid" : "staged";
        yield* runQuery("restaurant-import/stage-record", (sql) =>
          recordInsert.run(sql, {
            job_id: job.id,
            record_index: index,
            external_ref: check.externalRef,
            status,
            errors: check.errors.length === 0 ? null : [...check.errors],
            warnings: check.warnings.length === 0 ? null : [...check.warnings],
            venue_id: null,
            duplicate_of: null,
            dedup_key: status === "staged" ? dedupKey : null,
            payload: check.staged ?? draft,
          }),
        );
        index += 1;
      }

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.import.staged",
        outcome: "succeeded",
        resource: job.id,
      });

      const report: StageReport = {
        jobId: job.id,
        status: job.status,
        stagedCount: drafts.length,
        totalRecords: drafts.length,
      };

      return report;
    }),
  );
});

export interface ValidateReport {
  readonly jobId: string;
  readonly status: string;
  readonly valid: number;
  readonly invalid: number;
  readonly skippedDuplicate: number;
  readonly needsReview: number;
}

export const validateRestaurantImport = Effect.fn("restaurant-import/validate")(function* (input: {
  readonly jobId: string;
}) {
  const actorId = yield* authorizeStage;

  return yield* withTransaction(
    "restaurant-import/validate",
    Effect.gen(function* () {
      const job = yield* runQuery("restaurant-import/validate-lock", (sql) =>
        jobLock.run(sql, { id: input.jobId }),
      );

      if (job === null) return yield* new RestaurantNotFound();

      if (job.status !== "staged") {
        return yield* new RestaurantInputError({
          reason: `Import job is ${job.status}; only staged jobs can be validated`,
        });
      }

      const rows = yield* runQuery("restaurant-import/validate-rows", (sql) =>
        recordsByJob.run(sql, { job_id: job.id, limit: MAX_STAGE_ROWS, offset: 0 }),
      );

      let valid = 0;
      let invalid = 0;
      let skipped = 0;
      let needsReview = 0;

      for (const row of rows) {
        if (row.status === "skipped_duplicate") {
          skipped += 1;
          continue;
        }

        if (row.status === "invalid") {
          invalid += 1;
          continue;
        }

        const raw: unknown = JSON.parse(row.payload);
        const parsed = stagedRowSchema.safeParse(raw);

        if (!parsed.success) {
          yield* runQuery("restaurant-import/validate-mark", (sql) =>
            recordUpdate.run(sql, {
              id: row.id,
              status: "invalid",
              errors: parsed.error.issues.map((issue) => issue.message),
              warnings: warningsOf(row.warnings),
              venue_id: null,
              duplicate_of: null,
            }),
          );
          invalid += 1;
          continue;
        }

        const staged = parsed.data;

        const exact = yield* runQuery("restaurant-import/validate-exact", (sql) =>
          exactQuery.run(sql, { name: staged.name, address: staged.address }),
        );

        if (exact !== null) {
          yield* runQuery("restaurant-import/validate-skip", (sql) =>
            recordUpdate.run(sql, {
              id: row.id,
              status: "skipped_duplicate",
              errors: null,
              warnings: warningsOf(row.warnings),
              venue_id: null,
              duplicate_of: exact.venue_id,
            }),
          );
          skipped += 1;
          continue;
        }

        const candidates = yield* runQuery("restaurant-import/validate-candidates", (sql) =>
          candidatesQuery.run(sql, {
            name: staged.name,
            longitude: staged.longitude,
            latitude: staged.latitude,
            threshold: FUZZY_SIMILARITY_THRESHOLD,
          }),
        );

        const best = candidates[0];

        const decision = classifyDuplicateDecision({
          exactMatch: false,
          bestSimilarity: best === undefined ? null : Number(best.similarity),
          bestDistanceMeters: best === undefined ? null : Number(best.distance_m),
        });

        if (decision === "review" && best !== undefined) {
          yield* runQuery("restaurant-import/validate-review", (sql) =>
            recordUpdate.run(sql, {
              id: row.id,
              status: "needs_review",
              errors: null,
              warnings: warningsOf(row.warnings),
              venue_id: null,
              duplicate_of: best.venue_id,
            }),
          );
          needsReview += 1;
          continue;
        }

        yield* runQuery("restaurant-import/validate-ok", (sql) =>
          recordUpdate.run(sql, {
            id: row.id,
            status: "valid",
            errors: null,
            warnings: warningsOf(row.warnings),
            venue_id: null,
            duplicate_of: null,
          }),
        );
        valid += 1;
      }

      const status = valid + needsReview > 0 ? "validated" : "failed";
      yield* runQuery("restaurant-import/validate-job", (sql) =>
        jobStage.run(sql, {
          id: job.id,
          valid_records: valid,
          invalid_records: invalid,
          status,
          completed_at: null,
        }),
      );

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.import.validated",
        outcome: "succeeded",
        resource: job.id,
      });

      const report: ValidateReport = {
        jobId: job.id,
        status,
        valid,
        invalid,
        skippedDuplicate: skipped,
        needsReview,
      };

      return report;
    }),
  );
});

export const resolveImportRecord = Effect.fn("restaurant-import/resolve")(function* (input: {
  readonly jobId: string;
  readonly recordId: string;
  readonly decision: "approved" | "skipped";
  readonly duplicateOf?: string;
}) {
  const actorId = yield* authorizeStage;

  return yield* withTransaction(
    "restaurant-import/resolve",
    Effect.gen(function* () {
      const job = yield* runQuery("restaurant-import/resolve-lock", (sql) =>
        jobLock.run(sql, { id: input.jobId }),
      );

      if (job === null) return yield* new RestaurantNotFound();

      if (job.status !== "validated" && job.status !== "applying") {
        return yield* new RestaurantInputError({
          reason: `Import job is ${job.status}; only jobs awaiting review can be resolved`,
        });
      }

      const row = yield* runQuery("restaurant-import/resolve-row", (sql) =>
        recordLock.run(sql, { id: input.recordId }),
      );

      if (row === null || row.job_id !== job.id) return yield* new RestaurantNotFound();

      if (row.status !== "needs_review") {
        return yield* new RestaurantInputError({
          reason: `Record is ${row.status}; only rows awaiting review can be resolved`,
        });
      }

      const duplicateOf =
        input.decision === "skipped" ? (input.duplicateOf ?? row.duplicate_of) : null;

      yield* runQuery("restaurant-import/resolve-update", (sql) =>
        recordUpdate.run(sql, {
          id: row.id,
          status: input.decision === "approved" ? "approved" : "skipped_duplicate",
          errors: null,
          warnings: warningsOf(row.warnings),
          venue_id: null,
          duplicate_of: duplicateOf,
        }),
      );

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: `restaurant.import.record.${input.decision}`,
        outcome: "succeeded",
        resource: row.id,
      });

      return {
        recordId: row.id,
        status: input.decision === "approved" ? "approved" : "skipped_duplicate",
      };
    }),
  );
});

export interface ApplyReport {
  readonly jobId: string;
  readonly status: string;
  readonly applied: number;
  readonly skippedDuplicate: number;
  readonly failed: number;
  readonly pendingReview: number;
  readonly done: boolean;
}

const applyOneRecord = (
  job: RestaurantImportJobRow,
  row: RestaurantImportRecordRow,
  actorId: string,
): Effect.Effect<
  "applied",
  RestaurantInputError | PersistenceConflict | TransactionFailed | DatabaseError,
  Database | UserRepository
> =>
  withTransaction(
    "restaurant-import/apply-row",
    Effect.gen(function* () {
      const locked = yield* runQuery("restaurant-import/apply-lock", (sql) =>
        recordLock.run(sql, { id: row.id }),
      );

      if (locked === null) {
        return yield* new RestaurantInputError({
          reason: `Record ${row.external_ref} disappeared`,
        });
      }

      if (locked.status !== "valid" && locked.status !== "approved") {
        return yield* new PersistenceConflict({
          operation: "restaurant-import/apply-row",
          constraint: "record_no_longer_appliable",
        });
      }

      const raw: unknown = JSON.parse(locked.payload);
      const parsed = stagedRowSchema.safeParse(raw);

      if (!parsed.success) {
        return yield* new RestaurantInputError({
          reason: `Stored row ${row.external_ref} is corrupt`,
        });
      }

      const staged = parsed.data;

      const existingBusiness = yield* runQuery("restaurant-import/apply-business-find", (sql) =>
        businessFind.run(sql, { name: staged.businessName }),
      );

      const businessId =
        existingBusiness === null
          ? (yield* runQuery("restaurant-import/apply-business", (sql) =>
              businessInsert.run(sql, { name: staged.businessName }),
            )).id
          : existingBusiness.id;

      const venueId = crypto.randomUUID();
      yield* runQuery("restaurant-import/apply-venue", (sql) =>
        venueInsert.run(sql, {
          id: venueId,
          business: businessId,
          name: staged.name,
          address: staged.address,
          area: staged.area,
          country: staged.countryCode,
          longitude: staged.longitude,
          latitude: staged.latitude,
        }),
      );
      yield* runQuery("restaurant-import/apply-name", (sql) =>
        nameInsert.run(sql, { venue: venueId, name: staged.name }),
      );

      // Provenance: every applied venue carries an authorized_provider
      // source row with the import dedup key. observed_at is the apply time
      // (the CHECK horizon requires it to be ~now); the dataset's own
      // observedAt stays in the import payload for audit. Validity follows
      // the standard 90-day review horizon.
      const observed = new Date();
      const validUntil = new Date(observed.getTime() + 90 * 86400000);
      yield* runQuery("restaurant-import/apply-source", (sql) =>
        sourceInsert.run(sql, {
          venue: venueId,
          category: "authorized_provider",
          url: staged.sourceUrl,
          object_key: null,
          deduplication: locked.dedup_key ?? `restaurant-import:${job.id}:${locked.record_index}`,
          verified: false,
          observed: observed.toISOString(),
          until: validUntil.toISOString(),
          actor: actorId,
        }),
      );

      yield* runQuery("restaurant-import/apply-mark", (sql) =>
        recordUpdate.run(sql, {
          id: locked.id,
          status: "applied",
          errors: null,
          warnings: warningsOf(locked.warnings),
          venue_id: venueId,
          duplicate_of: null,
        }),
      );

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.import.applied",
        outcome: "succeeded",
        resource: venueId,
      });

      return "applied" as const;
    }),
  );

const markRecordFailed = (
  rowId: string,
  reason: string,
): Effect.Effect<void, TransactionFailed | DatabaseError, Database> =>
  withTransaction(
    "restaurant-import/apply-fail",
    Effect.gen(function* () {
      const locked = yield* runQuery("restaurant-import/apply-fail-lock", (sql) =>
        recordLock.run(sql, { id: rowId }),
      );

      if (locked === null) return;

      if (locked.status !== "valid" && locked.status !== "approved") return;
      yield* runQuery("restaurant-import/apply-fail-mark", (sql) =>
        recordUpdate.run(sql, {
          id: locked.id,
          status: "failed",
          errors: [reason],
          warnings: warningsOf(locked.warnings),
          venue_id: null,
          duplicate_of: locked.duplicate_of,
        }),
      );
    }),
  );

export const applyRestaurantImport = Effect.fn("restaurant-import/apply")(function* (input: {
  readonly jobId: string;
  readonly licenseAck: boolean;
  readonly reviewAck: boolean;
  readonly acknowledgedRefs: ReadonlyArray<string>;
  readonly limit?: number;
}) {
  const actorId = yield* authorizeBulkApply;

  const job = yield* runQuery("restaurant-import/apply-find", (sql) =>
    jobFind.run(sql, { id: input.jobId }),
  );

  if (job === null) return yield* new RestaurantNotFound();

  if (job.status !== "validated" && job.status !== "applying") {
    return yield* new PersistenceConflict({
      operation: "restaurant-import/apply",
      constraint: `job_${job.status}_not_appliable`,
    });
  }

  if (needsLicenseReview(job.license) && !input.licenseAck) {
    return yield* new RestaurantInputError({
      reason: "License review acknowledgement is required before applying this import",
    });
  }

  if (!input.reviewAck) {
    return yield* new RestaurantInputError({
      reason: "Review acknowledgement is required before applying this import",
    });
  }

  // Guard transaction: non-blocking mutual exclusion, approval write, and
  // the atomic validated -> applying claim. A lock collision surfaces as a
  // typed apply conflict instead of serializing behind the live batch.
  // Commits fast; row work below runs in per-row transactions so a crash
  // resumes from row statuses.
  const contended = Effect.fail(
    new PersistenceConflict({
      operation: "restaurant-import/apply",
      constraint: "apply_already_running",
    }),
  );

  yield* withTransaction(
    "restaurant-import/apply-guard",
    Effect.gen(function* () {
      const attempt = yield* runQuery("restaurant-import/apply-try-lock", (sql) =>
        jobTryLock.run(sql, { id: job.id }),
      ).pipe(
        Effect.catchTags({
          PersistenceError: () => contended,
          PersistenceConflict: () => contended,
          TransactionConflict: () => contended,
        }),
      );

      if (attempt === null) return yield* new RestaurantNotFound();

      if (attempt.status !== "validated" && attempt.status !== "applying") {
        return yield* new PersistenceConflict({
          operation: "restaurant-import/apply",
          constraint: `job_${attempt.status}_not_appliable`,
        });
      }

      yield* runQuery("restaurant-import/apply-approve", (sql) =>
        jobApprove.run(sql, {
          id: job.id,
          approved_by: actorId,
          license_ack: input.licenseAck,
          review_ack: input.reviewAck,
          acknowledged_duplicates: [...input.acknowledgedRefs],
        }),
      );

      const claimed = yield* runQuery("restaurant-import/apply-claim", (sql) =>
        jobClaim.run(sql, { id: job.id }),
      );

      if (claimed === null) {
        return yield* new PersistenceConflict({
          operation: "restaurant-import/apply",
          constraint: "apply_claim_lost",
        });
      }

      const acknowledged = new Set(input.acknowledgedRefs);

      if (acknowledged.size > 0) {
        const awaiting = yield* runQuery("restaurant-import/apply-awaiting", (sql) =>
          recordsByJob.run(sql, { job_id: job.id, limit: MAX_STAGE_ROWS, offset: 0 }),
        );

        for (const candidate of awaiting) {
          if (candidate.status !== "needs_review") continue;

          if (!acknowledged.has(candidate.external_ref)) continue;
          yield* runQuery("restaurant-import/apply-ack", (sql) =>
            recordUpdate.run(sql, {
              id: candidate.id,
              status: "approved",
              errors: null,
              warnings: warningsOf(candidate.warnings),
              venue_id: null,
              duplicate_of: null,
            }),
          );
        }
      }

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.import.apply_claimed",
        outcome: "succeeded",
        resource: job.id,
      });

      return "claimed" as const;
    }),
  );

  const windowLimit = Math.min(
    Math.max(Math.floor(input.limit ?? IMPORT_APPLY_BATCH_SIZE), 1),
    IMPORT_APPLY_BATCH_SIZE,
  );

  for (;;) {
    const window = yield* runQuery("restaurant-import/apply-window", (sql) =>
      recordsPending.run(sql, { job_id: job.id, limit: windowLimit }),
    );

    if (window.length === 0) break;

    for (const row of window) {
      const outcome = yield* applyOneRecord(job, row, actorId).pipe(
        Effect.as({ outcome: "applied" as const }),
        Effect.catchTags({
          RestaurantInputError: (cause) =>
            Effect.succeed({ outcome: "failed" as const, reason: cause.reason }),
          PersistenceConflict: () =>
            Effect.succeed({ outcome: "failed" as const, reason: "record no longer appliable" }),
        }),
      );

      if (outcome.outcome === "failed") {
        yield* markRecordFailed(row.id, outcome.reason);
      }
    }
  }

  const tally = yield* runQuery("restaurant-import/apply-tally", (sql) =>
    recordCounts.run(sql, { job_id: job.id }),
  );

  const appliableRemain = tally.valid + tally.approved;
  const done = appliableRemain === 0 && tally.needs_review === 0;
  const status = done ? "applied" : "applying";

  yield* withTransaction(
    "restaurant-import/apply-finish",
    Effect.gen(function* () {
      yield* runQuery("restaurant-import/apply-progress", (sql) =>
        jobApplyProgress.run(sql, {
          id: job.id,
          applied_count: tally.applied,
          skipped_count: tally.skipped_duplicate,
          apply_failed_count: tally.failed,
          status,
          completed_at: done ? new Date().toISOString() : null,
        }),
      );
      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: `restaurant.import.${status}`,
        outcome: "succeeded",
        resource: job.id,
      });
    }),
  );

  const report: ApplyReport = {
    jobId: job.id,
    status,
    applied: tally.applied,
    skippedDuplicate: tally.skipped_duplicate,
    failed: tally.failed,
    pendingReview: tally.needs_review,
    done,
  };

  return report;
});

export interface JobDetail {
  readonly job: RestaurantImportJobRow;
  readonly records: ReadonlyArray<RestaurantImportRecordRow>;
  readonly counts: {
    readonly staged: number;
    readonly valid: number;
    readonly invalid: number;
    readonly needsReview: number;
    readonly approved: number;
    readonly applied: number;
    readonly skippedDuplicate: number;
    readonly failed: number;
  };
}

export const getRestaurantImportJob = Effect.fn("restaurant-import/job")(function* (input: {
  readonly jobId: string;
  readonly limit?: number;
  readonly offset?: number;
}) {
  yield* authorizeStage;

  const job = yield* runQuery("restaurant-import/job-find", (sql) =>
    jobFind.run(sql, { id: input.jobId }),
  );

  if (job === null) return yield* new RestaurantNotFound();
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 100), 1), 500);
  const offset = Math.max(Math.floor(input.offset ?? 0), 0);

  const records = yield* runQuery("restaurant-import/job-records", (sql) =>
    recordsByJob.run(sql, { job_id: job.id, limit, offset }),
  );

  const tally = yield* runQuery("restaurant-import/job-tally", (sql) =>
    recordCounts.run(sql, { job_id: job.id }),
  );

  const detail: JobDetail = {
    job,
    records,
    counts: {
      staged: tally.staged,
      valid: tally.valid,
      invalid: tally.invalid,
      needsReview: tally.needs_review,
      approved: tally.approved,
      applied: tally.applied,
      skippedDuplicate: tally.skipped_duplicate,
      failed: tally.failed,
    },
  };

  return detail;
});

export const listRestaurantImportJobs = Effect.fn("restaurant-import/jobs")(function* (input: {
  readonly limit?: number;
  readonly offset?: number;
}) {
  yield* authorizeStage;
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 20), 1), 100);
  const offset = Math.max(Math.floor(input.offset ?? 0), 0);

  return yield* runQuery("restaurant-import/jobs", (sql) => jobsRecent.run(sql, { limit, offset }));
});
