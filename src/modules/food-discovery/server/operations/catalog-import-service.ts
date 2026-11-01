import { Context, Effect, Layer, Option, Schema } from "effect";

import {
  MAX_BATCHED_IMPORT_RECORDS,
  MAX_IMPORT_RECORDS,
  needsLicenseReview,
} from "@/modules/food-discovery/admin.schema";
import {
  CatalogConflict,
  DishNotFound,
  InvalidDishData,
  InvalidRelationship,
} from "@/modules/food-discovery/server/domain/errors";
import {
  encodeDbId,
  isDbIdString,
  Slug,
  slugifyName,
} from "@/modules/food-discovery/server/domain/ids";
import {
  AuthoringDescription,
  AuthoringDish,
  AuthoringIngredient,
  AuthoringName,
  StoredImportRecord,
} from "@/modules/food-discovery/server/domain/schemas";
import {
  asLocalizedName,
  isSearchableQuery,
  normalizeSearchKey,
  pickDisplayName,
  toContainsKey,
  toPrefixKey,
} from "@/modules/food-discovery/server/domain/search";
import { CurationRepository } from "@/modules/food-discovery/server/repository/curation-repository";
import { DishRelationsRepository } from "@/modules/food-discovery/server/repository/dish-relations-repository";
import { DishRepository } from "@/modules/food-discovery/server/repository/dish-repository";
import { IngredientRepository } from "@/modules/food-discovery/server/repository/ingredient-repository";
import { PlaceRepository } from "@/modules/food-discovery/server/repository/place-repository";
import {
  SourceRepository,
  TaxonomyRepository,
} from "@/modules/food-discovery/server/repository/taxonomy-repository";
import type { Database } from "@/server/database/client";
import { withTransaction } from "@/server/database/client";
import type {
  DatabaseUnavailable,
  PersistenceConflict,
  PersistenceError,
  TransactionConflict,
  TransactionFailed,
} from "@/server/database/errors";
import type { DatabaseError } from "@/server/database/query";

export type CatalogImportError =
  | CatalogConflict
  | DishNotFound
  | InvalidDishData
  | InvalidRelationship
  | DatabaseUnavailable
  | PersistenceError
  | PersistenceConflict
  | TransactionConflict
  | TransactionFailed;

export interface ImportValidationItem {
  readonly externalRef: string;
  readonly status: "valid" | "invalid";
  readonly errors: ReadonlyArray<string>;
  readonly duplicateOf: string | null;
  readonly slug: string | null;
}

export interface ImportValidationReport {
  readonly jobId: string;
  readonly totalRecords: number;
  readonly validRecords: number;
  readonly invalidRecords: number;
  readonly items: ReadonlyArray<ImportValidationItem>;
}

export interface ImportApplyReport {
  readonly jobId: string;
  readonly applied: number;
  readonly skippedDuplicate: number;
  readonly failed: number;
  /**
   * Bounded-batch apply: one call applies at most `limit` rows. `done` is
   * true only when no `valid` rows remain (and the job flipped to applied);
   * otherwise the client must call again. `pending` is the remaining `valid`
   * count for progress display. Past `done`, re-entry is a typed conflict
   * (exactly-once holds: no row can apply twice, and the caller learns the
   * terminal state from the conflict reason instead of a silent no-op).
   */
  readonly done: boolean;
  readonly pending: number;
}

export interface ImportBeginInput {
  readonly sourceName: string;
  readonly format?: "json" | "csv";
  readonly totalRecords: number;
  readonly sourceUrl?: string | null;
  readonly sourceVersion?: string | null;
  readonly license?: string | null;
  readonly attribution?: string | null;
  readonly editorialNotes?: string | null;
}

export interface ImportBeginReport {
  readonly jobId: string;
  readonly status: "staged";
  readonly stagedCount: number;
  readonly totalRecords: number;
}

export interface ImportStageBatchInput {
  readonly jobId: string;
  /** Global 0-based position of records[0] in the logical dataset. */
  readonly baseIndex: number;
  readonly records: ReadonlyArray<unknown>;
}

export interface ImportStageBatchReport {
  readonly jobId: string;
  readonly status: string;
  readonly stagedCount: number;
  readonly totalRecords: number;
  readonly validRecords: number;
  readonly invalidRecords: number;
  readonly batchValid: number;
  readonly batchInvalid: number;
  /** True once stagedCount reaches totalRecords (job is review-ready). */
  readonly complete: boolean;
}

export interface ImportJobIssueRecord {
  readonly id: string;
  readonly jobId: string;
  readonly externalRef: string;
  readonly status: string;
  readonly errors: string | null;
  readonly dishId: string | null;
  readonly recordIndex: number | null;
  readonly recordSlug: string | null;
  readonly duplicateOf: string | null;
  readonly createdAt: string;
}

export interface ImportJobIssuesPage {
  readonly job: {
    readonly id: string;
    readonly sourceName: string;
    readonly status: string;
    readonly totalRecords: number;
    readonly validRecords: number;
    readonly invalidRecords: number;
  };
  readonly records: ReadonlyArray<ImportJobIssueRecord>;
  readonly nextCursor: string | null;
  readonly totals: {
    readonly total: number;
    readonly pending: number;
    readonly valid: number;
    readonly invalid: number;
    readonly applied: number;
    readonly skippedDuplicate: number;
  };
}

export interface ImportJobIssuesInput {
  readonly jobId: string;
  readonly status?: "pending" | "valid" | "invalid" | "applied" | "skipped_duplicate" | null;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ImportValidateInput {
  readonly sourceName: string;
  readonly payload: unknown;
  readonly format?: "json" | "csv";
  readonly sourceUrl?: string | null;
  readonly sourceVersion?: string | null;
  readonly license?: string | null;
  readonly attribution?: string | null;
  readonly editorialNotes?: string | null;
}

export interface ImportApplyApprovals {
  readonly licenseAck: boolean;
  readonly reviewAck: boolean;
  readonly duplicateRefs: ReadonlyArray<string>;
}

export interface ImportApplyInput {
  readonly jobId: string;
  readonly approvals: ImportApplyApprovals;
  readonly actorUserId: string;
  /**
   * Bounded-batch apply: at most this many `valid` rows per call.
   * Defaults to IMPORT_APPLY_BATCH_SIZE; the client drives the cursor
   * forward (repeat until the report says done) to stay inside the
   * server-function budget on large jobs.
   */
  readonly limit?: number;
}

/** Bounded batch sizes: every stage/apply call commits at most this many rows. */
export const IMPORT_STAGE_BATCH_SIZE = MAX_IMPORT_RECORDS;

export const IMPORT_APPLY_BATCH_SIZE = MAX_IMPORT_RECORDS;

/**
 * Best-effort duplicate target from a stored import-record payload envelope.
 * Corrupt payloads surface as null and fail loudly at apply time, never
 * silently. Module scope: captures nothing from the service closure.
 * Plain try/catch JSON parse plus a schema decode, matching the repo's
 * established cursor.ts / quiz-model.ts idiom.
 */
const StoredDuplicateEnvelope = Schema.Struct({ duplicateOf: Schema.NullOr(Schema.String) });

const storedDuplicateOf = (payloadText: string | null): string | null => {
  if (payloadText === null || payloadText === "") {
    return null;
  }

  let raw: unknown;

  try {
    raw = JSON.parse(payloadText);
  } catch {
    return null;
  }

  const decoded = Schema.decodeUnknownOption(StoredDuplicateEnvelope)(raw);

  if (Option.isSome(decoded) && decoded.value.duplicateOf !== null) {
    return decoded.value.duplicateOf;
  }

  return null;
};

/**
 * Multi-place place-entry grammar for catalog imports (CSV cells and JSON
 * place arrays share it at the service boundary).
 *
 * Entry = target [":" association]; target = <ISO3166> | "place:"<id> |
 * <city>"@"<parent ISO> | <bare city>; association ∈ origin | associated |
 * popular, case-insensitive, omitted → `associated` (never `origin`).
 *
 * CSV cells split entries on `;` (documented shape, backward compatible)
 * and `,` (coordinator contract); JSON keeps `{iso}` / `{place_id}` and
 * adds `{city, parent_iso}` object forms plus raw grammar strings.
 * Resolution mirrors the place workstream: preferred names then aliases,
 * scoped by the parent; ambiguous or missing names become validation
 * issues — never silent country fallbacks, never auto-created places,
 * never inferred origin.
 */
const IMPORT_PLACE_ASSOCIATIONS: ReadonlySet<string> = new Set(["origin", "associated", "popular"]);

const IMPORT_PLACE_ID_PREFIX = "place:";

const IMPORT_ISO_PATTERN = /^[A-Za-z]{2}(-[A-Za-z0-9]{1,3})?$/;

type ParsedPlaceTarget =
  | { readonly kind: "iso"; readonly iso: string; readonly association: string }
  | { readonly kind: "id"; readonly placeId: string; readonly association: string }
  | {
      readonly kind: "city";
      readonly city: string;
      readonly parentIso: string | null;
      readonly association: string;
    };

type ParsedPlaceEntry =
  | { readonly ok: true; readonly target: ParsedPlaceTarget }
  | { readonly ok: false; readonly error: string };

const parsePlaceIdTarget = (entry: string): ParsedPlaceEntry => {
  const withoutPrefix = entry.trim().slice(IMPORT_PLACE_ID_PREFIX.length);
  const segments = withoutPrefix.split(":");

  if (segments.length > 2) {
    return { ok: false, error: `invalid place entry "${entry}"` };
  }

  const rawId = (segments[0] ?? "").trim();

  if (!/^[0-9]+$/.test(rawId)) {
    return { ok: false, error: `invalid place id "${rawId}" in "${entry}"` };
  }

  if (segments.length === 1) {
    return { ok: true, target: { kind: "id", placeId: rawId, association: "associated" } };
  }

  const rawAssociation = (segments[1] ?? "").trim();
  const association = rawAssociation.toLowerCase();

  if (!IMPORT_PLACE_ASSOCIATIONS.has(association)) {
    return { ok: false, error: `unsupported place association "${rawAssociation}" in "${entry}"` };
  }

  return { ok: true, target: { kind: "id", placeId: rawId, association } };
};

/**
 * Pure parse of one `places` cell entry. Never throws: every malformed
 * entry becomes a validation issue naming the offending text, so curators
 * fix the cell instead of shipping a dangling link.
 */
const parseImportPlaceText = (entry: string): ParsedPlaceEntry => {
  const trimmed = entry.trim();

  if (trimmed.length === 0) {
    return { ok: false, error: `invalid place entry "${entry}"` };
  }

  if (trimmed.toLowerCase().startsWith(IMPORT_PLACE_ID_PREFIX)) {
    return parsePlaceIdTarget(trimmed);
  }

  const separator = trimmed.indexOf(":");
  const head = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim();
  const rawAssociation = separator === -1 ? null : trimmed.slice(separator + 1).trim();
  const association = rawAssociation === null ? "associated" : rawAssociation.toLowerCase();

  if (rawAssociation !== null && !IMPORT_PLACE_ASSOCIATIONS.has(association)) {
    return {
      ok: false,
      error: `unsupported place association "${rawAssociation}" in "${entry}"`,
    };
  }

  if (head.length === 0) {
    return { ok: false, error: `invalid place entry "${entry}"` };
  }

  if (IMPORT_ISO_PATTERN.test(head)) {
    return { ok: true, target: { kind: "iso", iso: head, association } };
  }

  const atSign = head.lastIndexOf("@");

  if (atSign !== -1) {
    const city = head.slice(0, atSign).trim();
    const parentIso = head.slice(atSign + 1).trim();

    if (city.length === 0 || parentIso.length === 0) {
      return { ok: false, error: `invalid place entry "${entry}"` };
    }

    return { ok: true, target: { kind: "city", city, parentIso, association } };
  }

  return { ok: true, target: { kind: "city", city: head, parentIso: null, association } };
};

/**
 * Extended dish shape for import normalization: every `AuthoringDish`
 * field reuses its canonical schema, but `places` entries also accept the
 * CSV grammar as raw strings and the `{city, parent_iso}` object form.
 * Canonical payloads decode identically here and downstream; extended
 * forms are resolved to canonical links by `normalizeExtendedRecord`
 * before the strict `AuthoringDish` decode.
 */
const ExtendedAuthoringPlace = Schema.Struct({
  iso: Schema.optional(Schema.String),
  place_id: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
  parent_iso: Schema.optional(Schema.String),
  association: Schema.optional(Schema.String),
  note: Schema.optional(Schema.Unknown),
});

type ExtendedAuthoringPlace = typeof ExtendedAuthoringPlace.Type;

const ExtendedAuthoringDish = Schema.Struct({
  slug: Schema.optional(Slug),
  status: Schema.optional(Schema.Literals(["draft", "review"])),
  parent_slug: Schema.optional(Slug),
  names: Schema.NonEmptyArray(AuthoringName),
  descriptions: Schema.optional(Schema.Array(AuthoringDescription)),
  ingredients: Schema.optional(Schema.Array(AuthoringIngredient)),
  places: Schema.optional(Schema.Array(Schema.Union([Schema.String, ExtendedAuthoringPlace]))),
  cuisines: Schema.optional(Schema.Array(Schema.String)),
  categories: Schema.optional(Schema.Array(Schema.String)),
  editorial_note: Schema.optional(
    Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(2000))),
  ),
});

type ExtendedAuthoringDish = typeof ExtendedAuthoringDish.Type;

/**
 * Single-shot duplicate-slug preflight shared by the strict and extended
 * decode paths. Pure over the slug list: a repeated slug fails the whole
 * job before any row is staged, so no job exists for a duplicated dataset.
 */
const checkDuplicateSlugs = (
  slugs: ReadonlyArray<string | null>,
): Effect.Effect<void, InvalidDishData> => {
  const seenSlugs = new Map<string, string>();

  for (const [index, slug] of slugs.entries()) {
    if (slug === null) {
      continue;
    }

    const externalRef = slug;
    const first = seenSlugs.get(slug);

    if (first !== undefined) {
      return Effect.fail(
        new InvalidDishData({
          reason: `duplicate slug "${slug}" in records "${first}" and "${externalRef}" (record ${index + 1})`,
        }),
      );
    }

    seenSlugs.set(slug, externalRef);
  }

  return Effect.void;
};

export class CatalogImportService extends Context.Service<
  CatalogImportService,
  {
    readonly validateImport: (
      input: ImportValidateInput,
    ) => Effect.Effect<ImportValidationReport, CatalogImportError, Database>;
    readonly applyImport: (
      input: ImportApplyInput,
    ) => Effect.Effect<ImportApplyReport, CatalogImportError, Database>;
    readonly beginImport: (
      input: ImportBeginInput,
    ) => Effect.Effect<ImportBeginReport, CatalogImportError, Database>;
    readonly stageImportBatch: (
      input: ImportStageBatchInput,
    ) => Effect.Effect<ImportStageBatchReport, CatalogImportError, Database>;
    readonly applyImportBatch: (
      input: ImportApplyInput,
    ) => Effect.Effect<ImportApplyReport, CatalogImportError, Database>;
    readonly importJobIssues: (
      input: ImportJobIssuesInput,
    ) => Effect.Effect<ImportJobIssuesPage, CatalogImportError, Database>;
  }
>()("feastjourney/food-discovery/CatalogImportService") {}

const MAX_SLUG_ATTEMPTS = 20;

export const CatalogImportServiceLive = Layer.effect(
  CatalogImportService,
  Effect.gen(function* () {
    const dishes = yield* DishRepository;
    const relations = yield* DishRelationsRepository;
    const ingredientRepository = yield* IngredientRepository;
    const placeRepository = yield* PlaceRepository;
    const taxonomy = yield* TaxonomyRepository;
    const sources = yield* SourceRepository;
    const curation = yield* CurationRepository;

    const uniqueSlug = (base: string): Effect.Effect<string, DatabaseError, Database> =>
      Effect.gen(function* () {
        if ((yield* dishes.findBySlug(base)) === null) {
          return base;
        }

        for (let attempt = 2; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
          const candidate = `${base}-${attempt}`;

          if ((yield* dishes.findBySlug(candidate)) === null) {
            return candidate;
          }
        }

        return `${base}-${Date.now().toString(36)}`;
      });

    const resolveIngredients = (record: AuthoringDish) =>
      Effect.gen(function* () {
        const resolved: Array<{ readonly id: bigint; readonly role: string }> = [];
        const errors: Array<string> = [];

        for (const ingredient of record.ingredients ?? []) {
          const key = normalizeSearchKey(ingredient.name);

          if (key.length === 0) {
            errors.push(`ingredient "${ingredient.name}" has no searchable text`);

            continue;
          }

          const candidates = yield* ingredientRepository.resolveByKey(
            key,
            ingredient.language_tag ?? "en",
            1,
          );

          const match = candidates[0];

          if (match === undefined) {
            errors.push(`unknown ingredient "${ingredient.name}"`);

            continue;
          }

          resolved.push({ id: match.ingredientId, role: ingredient.role });
        }

        return { resolved, errors };
      });

    /**
     * Geographic context for one place ("Bengaluru (Karnataka, IN)"):
     * preferred English display name plus the province/state and country
     * from the canonical ancestor chain — never parsed from display text.
     * Used in ambiguous/missing validation issues so curators can tell
     * same-named places apart.
     */
    const placeContextLabel = (placeId: bigint): Effect.Effect<string, DatabaseError, Database> =>
      Effect.gen(function* () {
        const place = yield* placeRepository.findById(placeId);

        if (place === null) {
          return `place:${placeId.toString()}`;
        }

        const chain = yield* placeRepository.ancestors(placeId);

        const ancestorIds = chain.filter((entry) => entry.id !== placeId).map((entry) => entry.id);

        const relatedIds = ancestorIds.length === 0 ? [placeId] : [placeId, ...ancestorIds];
        const names = yield* placeRepository.namesByPlaceIds(relatedIds);
        const byPlace = new Map<string, Array<(typeof names)[number]>>();

        for (const entry of names) {
          const keyId = entry.place_id.toString();
          const existing = byPlace.get(keyId);

          if (existing === undefined) {
            byPlace.set(keyId, [entry]);
          } else {
            existing.push(entry);
          }
        }

        const displayOf = (id: bigint): string | null => {
          const labels = (byPlace.get(id.toString()) ?? []).map(asLocalizedName);
          const picked = pickDisplayName(labels, "en");

          return picked === undefined ? null : picked.name;
        };

        const display = displayOf(placeId) ?? place.iso3166 ?? `place:${placeId.toString()}`;
        const contextParts: Array<string> = [];

        for (const entry of chain) {
          if (entry.id === placeId) {
            continue;
          }

          if (
            entry.kind !== "province" &&
            entry.kind !== "subnational" &&
            entry.kind !== "country"
          ) {
            continue;
          }

          const label = displayOf(entry.id);

          if (label !== null && label !== display && !contextParts.includes(label)) {
            contextParts.push(label);
          }
        }

        if (contextParts.length === 0 && place.iso3166 !== null && display !== place.iso3166) {
          contextParts.push(place.iso3166);
        }

        if (contextParts.length === 0) {
          return display;
        }

        return `${display} (${contextParts.join(", ")})`;
      });

    /**
     * Resolves a city/province name against the place registry. Preferred
     * names win over aliases; a parent ISO scopes the search to that
     * parent's subtree. Ambiguous bare names and unknown names (or unknown
     * parents) become actionable validation issues naming the Place Manager
     * — never a silent country fallback, never an auto-created place, and
     * never an inferred origin (the caller defaults omitted associations).
     */
    const resolveCityTarget = (
      city: string,
      parentIso: string | null,
      label: string,
    ): Effect.Effect<
      { readonly placeId: bigint | null; readonly error: string | null },
      DatabaseError,
      Database
    > =>
      Effect.gen(function* () {
        const key = normalizeSearchKey(city);

        if (key.length === 0) {
          return { placeId: null, error: `place "${label}" has no searchable text` };
        }

        let parentId: bigint | null = null;

        if (parentIso !== null) {
          const parent = yield* placeRepository.findByIso(parentIso);

          if (parent === null) {
            return {
              placeId: null,
              error:
                `unknown parent place iso "${parentIso}" for city "${city}". ` +
                `Register it in the Place Manager, then re-validate the import.`,
            };
          }

          parentId = parent.id;
        }

        const hits = yield* placeRepository.searchIds({
          q: key,
          prefix: toPrefixKey(key),
          contains: toContainsKey(key),
          limit: 10,
        });

        if (hits.length === 0) {
          return {
            placeId: null,
            error:
              `unknown place "${label}". ` +
              `Register it in the Place Manager, then re-validate the import.`,
          };
        }

        const tierById = new Map<string, number>();

        for (const hit of hits) {
          tierById.set(hit.id.toString(), hit.tier);
        }

        const names = yield* placeRepository.namesByPlaceIds(hits.map((hit) => hit.id));
        const namesById = new Map<string, Array<(typeof names)[number]>>();

        for (const entry of names) {
          const keyId = entry.place_id.toString();
          const existing = namesById.get(keyId);

          if (existing === undefined) {
            namesById.set(keyId, [entry]);
          } else {
            existing.push(entry);
          }
        }

        const matchesKey = (name: string): boolean => normalizeSearchKey(name) === key;

        const ranked = hits.toSorted((left, right) => {
          const leftNames = namesById.get(left.id.toString()) ?? [];
          const rightNames = namesById.get(right.id.toString()) ?? [];

          const leftPreferred = leftNames.some(
            (entry) => entry.is_preferred && matchesKey(entry.name),
          );

          const rightPreferred = rightNames.some(
            (entry) => entry.is_preferred && matchesKey(entry.name),
          );

          if (leftPreferred !== rightPreferred) {
            return leftPreferred ? -1 : 1;
          }

          const leftExact = leftNames.some((entry) => matchesKey(entry.name));
          const rightExact = rightNames.some((entry) => matchesKey(entry.name));

          if (leftExact !== rightExact) {
            return leftExact ? -1 : 1;
          }

          const tierOrder =
            (tierById.get(left.id.toString()) ?? 2) - (tierById.get(right.id.toString()) ?? 2);

          if (tierOrder !== 0) {
            return tierOrder;
          }

          if (left.id < right.id) {
            return -1;
          }

          if (left.id > right.id) {
            return 1;
          }

          return 0;
        });

        let scoped = ranked;

        if (parentId !== null) {
          const kept: Array<(typeof ranked)[number]> = [];

          for (const hit of ranked) {
            const chain = yield* placeRepository.ancestors(hit.id);

            if (chain.some((entry) => entry.id === parentId)) {
              kept.push(hit);
            }
          }

          if (kept.length === 0) {
            const contexts: Array<string> = [];

            for (const hit of ranked.slice(0, 3)) {
              contexts.push(`"${yield* placeContextLabel(hit.id)}" [place:${hit.id.toString()}]`);
            }

            return {
              placeId: null,
              error:
                `no place named "${city}" found under "${parentIso}". ` +
                `Closest matches live elsewhere: ${contexts.join(", ")}. ` +
                `Use "City@OtherParent" or "place:<id>", or register the city in the Place Manager.`,
            };
          }

          scoped = kept;
        }

        if (scoped.length === 1 && scoped[0] !== undefined) {
          return { placeId: scoped[0].id, error: null };
        }

        const listed: Array<string> = [];

        for (const hit of scoped.slice(0, 5)) {
          listed.push(`"${yield* placeContextLabel(hit.id)}" [place:${hit.id.toString()}]`);
        }

        return {
          placeId: null,
          error:
            `ambiguous city "${label}": ${scoped.length.toString()} places match — ` +
            `${listed.join(", ")}. ` +
            `Refine the entry with "City@ParentIso" or "place:<id>".`,
        };
      });

    interface NormalizedPlaceOutcome {
      readonly values: ReadonlyArray<unknown>;
      readonly errors: ReadonlyArray<string>;
    }

    /**
     * One CSV-grammar place string (`"Hanoi@VN:popular"`, `"place:45"`,
     * `"VN:origin"`) to canonical links. Strings may still carry `;` (the
     * documented cell separator) or the contract's `,` separator, so split
     * on both: neither character is legal inside a single valid entry.
     */
    const normalizePlaceText = (
      text: string,
      label: string,
    ): Effect.Effect<NormalizedPlaceOutcome, DatabaseError, Database> =>
      Effect.gen(function* () {
        const values: Array<unknown> = [];
        const errors: Array<string> = [];

        for (const part of text.split(/[;,]/)) {
          const trimmed = part.trim();

          if (trimmed.length === 0) {
            continue;
          }

          const parsed = parseImportPlaceText(trimmed);

          if (!parsed.ok) {
            errors.push(`${label}: ${parsed.error}`);

            continue;
          }

          const target = parsed.target;

          if (target.kind === "iso") {
            values.push({ iso: target.iso, association: target.association });

            continue;
          }

          if (target.kind === "id") {
            values.push({ place_id: target.placeId, association: target.association });

            continue;
          }

          const display =
            target.parentIso === null ? target.city : `${target.city}@${target.parentIso}`;

          const resolved = yield* resolveCityTarget(target.city, target.parentIso, display);

          if (resolved.error !== null || resolved.placeId === null) {
            errors.push(`${label}: ${resolved.error ?? `unknown place "${display}"`}`);

            continue;
          }

          values.push({ place_id: resolved.placeId.toString(), association: target.association });
        }

        return { values, errors };
      });

    /**
     * One decoded `{city, parent_iso}` object to a canonical link.
     * Canonical `{iso}`/`{place_id}` objects pass through untouched so the
     * strict `AuthoringDish` decode validates them exactly as before.
     */
    const normalizePlaceObject = (
      place: ExtendedAuthoringPlace,
      label: string,
    ): Effect.Effect<NormalizedPlaceOutcome, DatabaseError, Database> =>
      Effect.gen(function* () {
        if (place.city === undefined) {
          if (place.parent_iso !== undefined) {
            return {
              values: [],
              errors: [`${label}: place entry has "parent_iso" without "city"`],
            };
          }

          return { values: [place], errors: [] };
        }

        const city = place.city.trim();

        if (city.length === 0) {
          return { values: [], errors: [`${label}: place entry has an invalid "city"`] };
        }

        if (place.parent_iso !== undefined && place.parent_iso.trim().length === 0) {
          return { values: [], errors: [`${label}: place entry has an invalid "parent_iso"`] };
        }

        const parentIso = place.parent_iso === undefined ? null : place.parent_iso.trim();
        const rawAssociation = place.association === undefined ? "associated" : place.association;

        if (!IMPORT_PLACE_ASSOCIATIONS.has(rawAssociation.trim().toLowerCase())) {
          return {
            values: [],
            errors: [`${label}: unsupported place association "${rawAssociation}"`],
          };
        }

        const association = rawAssociation.trim().toLowerCase();
        const display = parentIso === null ? city : `${city}@${parentIso}`;
        const resolved = yield* resolveCityTarget(city, parentIso, display);

        if (resolved.error !== null || resolved.placeId === null) {
          return {
            values: [],
            errors: [`${label}: ${resolved.error ?? `unknown place "${display}"`}`],
          };
        }

        if (place.note === undefined) {
          return {
            values: [{ place_id: resolved.placeId.toString(), association }],
            errors: [],
          };
        }

        return {
          values: [{ place_id: resolved.placeId.toString(), association, note: place.note }],
          errors: [],
        };
      });

    /**
     * Pre-decode normalization for an extended import record's `places`
     * array: grammar strings and `{city, parent_iso}` objects become
     * canonical `{iso | place_id, association}` links; unresolvable entries
     * are dropped with an actionable error that marks the row invalid.
     * Entries no schema recognizes pass through so the strict
     * `AuthoringDish` decode reports them exactly as before.
     */
    const normalizeExtendedRecord = (
      record: ExtendedAuthoringDish,
      recordRef: string,
    ): Effect.Effect<
      { readonly record: unknown; readonly placeErrors: Array<string> },
      DatabaseError,
      Database
    > =>
      Effect.gen(function* () {
        if (record.places === undefined) {
          return { record, placeErrors: [] };
        }

        const canonical: Array<unknown> = [];
        const placeErrors: Array<string> = [];

        for (const [position, entry] of record.places.entries()) {
          const label = `${recordRef}: places[${position.toString()}]`;
          const asText = Schema.decodeUnknownOption(Schema.String)(entry);

          if (Option.isSome(asText)) {
            const normalized = yield* normalizePlaceText(asText.value, label);

            canonical.push(...normalized.values);
            placeErrors.push(...normalized.errors);

            continue;
          }

          const asObject = Schema.decodeUnknownOption(ExtendedAuthoringPlace)(entry);

          if (Option.isNone(asObject)) {
            canonical.push(entry);

            continue;
          }

          const normalized = yield* normalizePlaceObject(asObject.value, label);

          canonical.push(...normalized.values);
          placeErrors.push(...normalized.errors);
        }

        return { record: { ...record, places: canonical }, placeErrors };
      });

    /**
     * Validates canonical `{iso | place_id, association}` place links.
     * City/province grammar strings and `{city, parent_iso}` forms are
     * normalized to this shape by `normalizeExtendedRecord` before decode,
     * so only registry-linked canonical entries ever arrive here.
     */
    const resolvePlaces = (record: AuthoringDish) =>
      Effect.gen(function* () {
        const resolved: Array<{ readonly id: bigint; readonly association: string }> = [];
        const errors: Array<string> = [];

        for (const place of record.places ?? []) {
          if (place.iso !== undefined) {
            const found = yield* placeRepository.findByIso(place.iso);

            if (found === null) {
              errors.push(`unknown place iso "${place.iso}"`);

              continue;
            }

            resolved.push({ id: found.id, association: place.association });

            continue;
          }

          if (place.place_id !== undefined) {
            if (!isDbIdString(place.place_id)) {
              errors.push(`invalid place id "${place.place_id}"`);

              continue;
            }

            const found = yield* placeRepository.findById(BigInt(place.place_id));

            if (found === null) {
              errors.push(`unknown place id "${place.place_id}"`);

              continue;
            }

            resolved.push({ id: found.id, association: place.association });

            continue;
          }

          errors.push("place entries require iso or placeId");
        }

        return { resolved, errors };
      });

    const findDuplicateSlug = (
      record: AuthoringDish,
      placeIds: ReadonlyArray<bigint>,
      cuisineSlugs: ReadonlyArray<string>,
    ): Effect.Effect<string | null, DatabaseError, Database> =>
      Effect.gen(function* () {
        for (const name of record.names) {
          if (!isSearchableQuery(name.name)) {
            continue;
          }

          const key = normalizeSearchKey(name.name);

          if (key.length === 0) {
            continue;
          }

          const dishIds = yield* dishes.resolveByNameKey(key, 5);

          for (const dishId of dishIds) {
            const candidate = yield* dishes.findById(dishId);

            if (candidate === null) {
              continue;
            }

            const [candidatePlaces, candidateCuisines] = yield* Effect.all(
              [relations.placesByDishIds([dishId]), relations.cuisinesByDishIds([dishId])],
              { concurrency: 2 },
            );

            const placeOverlap = candidatePlaces.some((entry) => placeIds.includes(entry.place_id));

            const cuisineOverlap =
              cuisineSlugs.length === 0 ||
              candidateCuisines.some((entry) => cuisineSlugs.includes(entry.slug));

            if (placeOverlap && cuisineOverlap) {
              return candidate.slug;
            }
          }
        }

        return null;
      });

    const validateRecord = (
      record: AuthoringDish,
      index: number,
      priorErrors: ReadonlyArray<string> = [],
    ): Effect.Effect<
      {
        readonly externalRef: string;
        readonly errors: Array<string>;
        readonly slug: string | null;
        readonly duplicateOf: string | null;
      },
      DatabaseError,
      Database
    > =>
      Effect.gen(function* () {
        // City/province normalization findings (unknown or ambiguous
        // names) arrive here so the row reports them and stays invalid.
        const errors: Array<string> = [...priorErrors];
        const externalRef = record.slug ?? `record-${index + 1}`;

        if (record.slug !== undefined) {
          const taken = yield* dishes.findBySlug(record.slug);

          if (taken !== null) {
            errors.push(`slug "${record.slug}" already exists`);
          }
        }

        if (record.parent_slug !== undefined) {
          const parent = yield* dishes.findBySlug(record.parent_slug);

          if (parent === null) {
            errors.push(`unknown parent slug "${record.parent_slug}"`);
          }
        }

        const { errors: ingredientErrors } = yield* resolveIngredients(record);

        const { resolved: placeIds, errors: placeErrors } = yield* resolvePlaces(record);

        errors.push(...ingredientErrors, ...placeErrors);

        const cuisineSlugs = [...new Set(record.cuisines ?? [])];

        for (const slug of cuisineSlugs) {
          if ((yield* taxonomy.cuisineBySlug(slug)) === null) {
            errors.push(`unknown cuisine "${slug}"`);
          }
        }

        const categorySlugs = [...new Set(record.categories ?? [])];

        if (categorySlugs.length > 0) {
          const found = yield* taxonomy.categoriesBySlugs(categorySlugs);

          if (found.length !== categorySlugs.length) {
            errors.push("one or more categories are unknown");
          }
        }

        const duplicateOf =
          errors.length === 0
            ? yield* findDuplicateSlug(
                record,
                placeIds.map((entry) => entry.id),
                cuisineSlugs,
              )
            : null;

        return { externalRef, errors, slug: record.slug ?? null, duplicateOf };
      });

    /**
     * Lenient single-shot envelope: records stay `unknown` so one extended
     * place form (a `{city, parent_iso}` object or a grammar string) does
     * not fail the whole job. Each record is normalized (city names resolved
     * against the registry) and decoded individually; shape failures become
     * per-record invalid rows, exactly like the batched stage path.
     */
    const LenientImportPayload = Schema.Struct({
      source_name: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
      records: Schema.Array(Schema.Unknown),
    });

    interface PreparedImportRecord {
      /** Envelope content staged for apply; always canonical `AuthoringDish` when decoded. */
      readonly raw: unknown;
      readonly decoded: AuthoringDish | null;
      readonly priorErrors: ReadonlyArray<string>;
    }

    const stageValidatedRecords = (
      trimmedSource: string,
      input: ImportValidateInput,
      prepared: ReadonlyArray<PreparedImportRecord>,
    ): Effect.Effect<ImportValidationReport, CatalogImportError, Database> =>
      withTransaction(
        "import/validate",
        Effect.gen(function* () {
          const job = yield* curation.insertImportJob({
            sourceName: trimmedSource,
            format: input.format ?? "json",
            status: "staged",
            totalRecords: prepared.length,
            validRecords: 0,
            invalidRecords: 0,
            dryRun: true,
            sourceUrl: input.sourceUrl ?? null,
            sourceVersion: input.sourceVersion ?? null,
            license: input.license ?? null,
            attribution: input.attribution ?? null,
            editorialNotes: input.editorialNotes ?? null,
          });

          const items: Array<ImportValidationItem> = [];
          let valid = 0;

          for (const [index, entry] of prepared.entries()) {
            if (entry.decoded === null) {
              const externalRef = `record-${index + 1}`;
              const errors = ["record is not a valid dish entry"];

              yield* curation.insertImportRecord({
                jobId: job.id,
                externalRef,
                status: "invalid",
                errors: JSON.stringify(errors),
                dishId: null,
                payload: { record: entry.raw, duplicateOf: null },
              });

              items.push({
                externalRef,
                status: "invalid",
                errors,
                duplicateOf: null,
                slug: null,
              });

              continue;
            }

            const checked = yield* validateRecord(entry.decoded, index, entry.priorErrors);
            const status = checked.errors.length === 0 ? "valid" : "invalid";

            if (status === "valid") {
              valid += 1;
            }

            yield* curation.insertImportRecord({
              jobId: job.id,
              externalRef: checked.externalRef,
              status,
              errors: checked.errors.length === 0 ? null : JSON.stringify(checked.errors),
              dishId: null,
              payload: { record: entry.decoded, duplicateOf: checked.duplicateOf },
            });

            items.push({
              externalRef: checked.externalRef,
              status,
              errors: checked.errors,
              duplicateOf: checked.duplicateOf,
              slug: checked.slug,
            });
          }

          const invalid = prepared.length - valid;

          // Single-shot legacy path stages its full dataset atomically, so
          // the stage cursor lands on totalRecords in the same transaction.
          yield* curation.updateImportJobStage({
            id: job.id,
            stagedCount: prepared.length,
            validRecords: valid,
            invalidRecords: invalid,
            status: valid > 0 ? "validated" : "failed",
            completedAt: new Date().toISOString(),
          });

          return {
            jobId: encodeDbId(job.id),
            totalRecords: prepared.length,
            validRecords: valid,
            invalidRecords: invalid,
            items,
          };
        }),
      );

    const validateImport = (input: ImportValidateInput) =>
      Effect.gen(function* () {
        const trimmedSource = input.sourceName.trim().slice(0, 200);

        if (trimmedSource.length === 0) {
          return yield* new InvalidDishData({ reason: "source name is required" });
        }

        // Records decode through the extended dish shape (a superset of the
        // strict `AuthoringDish`: it also accepts grammar strings and
        // `{city, parent_iso}` place forms). Strict `Schema.Struct` decoding
        // strips unknown keys, so decoding strict-first would silently drop
        // city names before normalization ever sees them.
        const envelope = yield* Option.match(
          Schema.decodeUnknownOption(LenientImportPayload)(input.payload),
          {
            onNone: () => Effect.fail(new InvalidDishData({ reason: "invalid import payload" })),
            onSome: (value) => Effect.succeed(value),
          },
        );

        // Single-shot bound (the strict `ImportPayload` cap): larger datasets
        // travel through the batched stage protocol instead.
        if (envelope.records.length === 0 || envelope.records.length > MAX_IMPORT_RECORDS) {
          return yield* new InvalidDishData({ reason: "invalid import payload" });
        }

        const extended = envelope.records.map((raw) =>
          Schema.decodeUnknownOption(ExtendedAuthoringDish)(raw),
        );

        yield* checkDuplicateSlugs(
          extended.map((entry) => (Option.isSome(entry) ? (entry.value.slug ?? null) : null)),
        );

        // Normalization reads the place registry (no writes), so it runs
        // before the staging transaction; per-record issues ride along as
        // prior errors and keep their rows invalid.
        const prepared: Array<PreparedImportRecord> = [];

        for (const [index, entry] of extended.entries()) {
          if (Option.isNone(entry)) {
            prepared.push({
              raw: envelope.records[index],
              decoded: null,
              priorErrors: [],
            });

            continue;
          }

          const recordRef = entry.value.slug ?? `record-${index + 1}`;
          const normalized = yield* normalizeExtendedRecord(entry.value, recordRef);
          const authoring = Schema.decodeUnknownOption(AuthoringDish)(normalized.record);

          prepared.push({
            raw: envelope.records[index],
            decoded: Option.isSome(authoring) ? authoring.value : null,
            priorErrors: normalized.placeErrors,
          });
        }

        return yield* stageValidatedRecords(trimmedSource, input, prepared);
      });

    interface ApplyJobProvenance {
      readonly id: bigint;
      readonly sourceName: string;
      readonly sourceUrl: string | null;
      readonly sourceVersion: string | null;
      readonly license: string | null;
      readonly attribution: string | null;
    }

    // Provenance provider: the admin studio stores `<sourceId>:<license>`
    // in the job license column, so the prefix is the registry source id
    // (manual/partner/community/other, seeded by V013) — never the license
    // text after the colon. Prefix-less jobs (for example the public API
    // path, which stores no license) fall back to a slugified source name
    // and usually resolve no provider, in which case provenance is skipped.
    const providerSlugForJob = (job: ApplyJobProvenance): string | null => {
      const licenseRaw = job.license ?? "";
      const separator = licenseRaw.indexOf(":");

      if (separator > 0) {
        const sourceId = licenseRaw.slice(0, separator).trim().toLowerCase();

        if (sourceId.length > 0) {
          return sourceId;
        }
      }

      return slugifyName(job.sourceName);
    };

    const applyRecord = (
      job: ApplyJobProvenance,
      recordRowId: bigint,
      externalRef: string,
      record: AuthoringDish,
      duplicateOf: string | null,
    ): Effect.Effect<{ readonly applied: boolean }, CatalogImportError, Database> =>
      withTransaction(
        `import/${job.id.toString()}`,
        Effect.gen(function* () {
          const baseSlug = record.slug ?? slugifyName(record.names[0].name);
          const slug = yield* uniqueSlug(baseSlug);
          let parentId: bigint | null = null;

          if (record.parent_slug !== undefined) {
            const parent = yield* dishes.findBySlug(record.parent_slug);

            if (parent === null) {
              return yield* new InvalidRelationship({
                reason: `unknown parent slug "${record.parent_slug}"`,
              });
            }

            parentId = parent.id;
          }

          const existing = yield* dishes.findBySlug(slug);

          if (existing !== null) {
            yield* curation.updateImportRecord({
              id: recordRowId,
              status: "skipped_duplicate",
              errors: JSON.stringify([`slug "${slug}" already exists`]),
              dishId: existing.id,
            });

            return { applied: false };
          }

          const created = yield* dishes.insert({
            slug,
            parentDishId: parentId,
            status: "review",
          });

          yield* curation.insertRevision({
            dishId: created.id,
            actor: `import:${job.id.toString()}`,
            operation: "created",
            summary: `bulk import from staged record ${slug}`,
          });

          const providerSlug = providerSlugForJob(job);

          if (providerSlug !== null) {
            const provider = yield* sources.providerBySlug(providerSlug);

            if (provider !== null) {
              // Source identity: a record slug is a globally unique dish
              // handle, so a slugged record reuses its slug as the source
              // external_id. Slugless records use job-relative `record-N`
              // refs that repeat in every job, so scope them with the job
              // id (`<jobId>:record-N`): stable across resume retries of
              // the same job, yet never colliding across jobs, so a later
              // job can no longer overwrite an earlier job's source payload
              // through the (provider_id, external_id) upsert.
              const sourceExternalId = record.slug ?? `${job.id.toString()}:${externalRef}`;

              const stored = yield* sources.upsertRecord({
                providerId: provider.id,
                externalId: sourceExternalId,
                canonicalUrl: job.sourceUrl,
                retrievedAt: new Date().toISOString(),
                revision: job.sourceVersion,
                license: job.license,
                attribution: job.attribution,
                importStatus: "imported",
                payload: JSON.stringify(record),
              });

              yield* relations.linkDishSource(created.id, stored.id);
            }
          }

          const preferredByLocale = new Set<string>();

          for (const name of record.names) {
            const isPreferred = !preferredByLocale.has(name.language_tag);
            preferredByLocale.add(name.language_tag);

            yield* relations
              .insertName({
                dishId: created.id,
                languageTag: name.language_tag,
                name: name.name,
                nameKind: name.name_kind,
                isPreferred,
                searchKey: normalizeSearchKey(name.name),
              })
              .pipe(Effect.catchTag("PersistenceConflict", () => Effect.void));
          }

          for (const description of record.descriptions ?? []) {
            yield* relations.upsertDescription({
              dishId: created.id,
              languageTag: description.language_tag,
              description: description.description,
              summary: description.summary,
            });
          }

          for (const ingredient of record.ingredients ?? []) {
            const key = normalizeSearchKey(ingredient.name);

            const candidates = yield* ingredientRepository.resolveByKey(
              key,
              ingredient.language_tag ?? "en",
              1,
            );

            const match = candidates[0];

            if (match === undefined) {
              return yield* new InvalidRelationship({
                reason: `unknown ingredient "${ingredient.name}"`,
              });
            }

            yield* relations.linkIngredient(created.id, match.ingredientId, ingredient.role);
            yield* curation.insertRevision({
              dishId: created.id,
              actor: `import:${job.id.toString()}`,
              operation: "ingredient_linked",
              summary: `linked ingredient ${match.ingredientId.toString()} (${ingredient.role})`,
            });
          }

          for (const place of record.places ?? []) {
            if (place.iso !== undefined) {
              const found = yield* placeRepository.findByIso(place.iso);

              if (found === null) {
                return yield* new InvalidRelationship({
                  reason: `unknown place iso "${place.iso}"`,
                });
              }

              yield* relations.linkPlace({
                dishId: created.id,
                placeId: found.id,
                association: place.association,
                isDisputed: false,
                note: place.note ?? null,
              });
            } else if (place.place_id !== undefined && isDbIdString(place.place_id)) {
              const found = yield* placeRepository.findById(BigInt(place.place_id));

              if (found === null) {
                return yield* new InvalidRelationship({
                  reason: `unknown place id "${place.place_id}"`,
                });
              }

              yield* relations.linkPlace({
                dishId: created.id,
                placeId: found.id,
                association: place.association,
                isDisputed: false,
                note: place.note ?? null,
              });
            } else {
              return yield* new InvalidRelationship({
                reason: "place entries require iso or placeId",
              });
            }

            yield* curation.insertRevision({
              dishId: created.id,
              actor: `import:${job.id.toString()}`,
              operation: "place_linked",
              summary: `linked place (${place.association})`,
            });
          }

          const cuisineSlugs = new Set(record.cuisines ?? []);

          for (const cuisineSlug of cuisineSlugs) {
            const cuisine = yield* taxonomy.cuisineBySlug(cuisineSlug);

            if (cuisine === null) {
              return yield* new InvalidRelationship({ reason: `unknown cuisine "${cuisineSlug}"` });
            }

            yield* relations.linkCuisine(created.id, cuisine.id);
            yield* curation.insertRevision({
              dishId: created.id,
              actor: `import:${job.id.toString()}`,
              operation: "cuisine_linked",
              summary: `linked cuisine ${cuisine.slug}`,
            });
          }

          const categorySlugs = [...new Set(record.categories ?? [])];

          if (categorySlugs.length > 0) {
            const categories = yield* taxonomy.categoriesBySlugs(categorySlugs);

            for (const category of categories) {
              yield* relations.linkCategory(created.id, category.id);
              yield* curation.insertRevision({
                dishId: created.id,
                actor: `import:${job.id.toString()}`,
                operation: "category_linked",
                summary: `linked category ${category.slug}`,
              });
            }
          }

          if (duplicateOf !== null) {
            yield* curation.insertNote({
              dishId: created.id,
              author: `import:${job.id.toString()}`,
              noteKind: "review",
              note: `Possible duplicate of ${duplicateOf}; verify before publishing.`,
            });
          }

          if (record.editorial_note !== undefined) {
            yield* curation.insertNote({
              dishId: created.id,
              author: `import:${job.id.toString()}`,
              noteKind: "review",
              note: record.editorial_note,
            });
          }

          yield* curation.updateImportRecord({
            id: recordRowId,
            status: "applied",
            errors: null,
            dishId: created.id,
          });

          return { applied: true };
        }),
      );

    /**
     * Declares ONE logical import job up front: the client parsed the file
     * locally (never sent in full) and now reserves a job for exactly
     * totalRecords staged rows. The job sits in `staged` with staged_count 0
     * — open for batch appends until the cursor reaches totalRecords.
     */
    const beginImport = (input: ImportBeginInput) =>
      Effect.gen(function* () {
        const trimmedSource = input.sourceName.trim().slice(0, 200);

        if (trimmedSource.length === 0) {
          return yield* new InvalidDishData({ reason: "source name is required" });
        }

        if (
          !Number.isInteger(input.totalRecords) ||
          input.totalRecords < 1 ||
          input.totalRecords > MAX_BATCHED_IMPORT_RECORDS
        ) {
          return yield* new InvalidDishData({
            reason: `totalRecords must be between 1 and ${MAX_BATCHED_IMPORT_RECORDS}; got ${input.totalRecords}`,
          });
        }

        const job = yield* curation.insertImportJob({
          sourceName: trimmedSource,
          format: input.format ?? "json",
          status: "staged",
          totalRecords: input.totalRecords,
          validRecords: 0,
          invalidRecords: 0,
          dryRun: true,
          sourceUrl: input.sourceUrl ?? null,
          sourceVersion: input.sourceVersion ?? null,
          license: input.license ?? null,
          attribution: input.attribution ?? null,
          editorialNotes: input.editorialNotes ?? null,
        });

        return {
          jobId: encodeDbId(job.id),
          status: "staged" as const,
          stagedCount: 0,
          totalRecords: input.totalRecords,
        };
      });

    /**
     * Stages ONE bounded batch of a logical import. The batch commits in a
     * single short transaction (<= IMPORT_STAGE_BATCH_SIZE rows), so every
     * call fits the server-function budget no matter how large the dataset.
     *
     * Stable identity: record_index is the global 0-based dataset position
     * (UNIQUE per job — a retried batch conflicts instead of duplicating),
     * externalRef is the slug or `record-<global 1-based index>`, and
     * record_slug feeds the GLOBAL duplicate scan: the batch is compared
     * against every slug already staged for this job (persisted findings,
     * one indexed query) plus the live catalog, without loading all stored
     * payloads into memory.
     *
     * Cursor protocol: the next batch must start exactly at staged_count.
     * A batch fully below the cursor is an idempotent replay (returns
     * current progress without writing); a partially overlapping batch is a
     * conflict telling the client the exact cursor to resume from. A crash
     * can never leave a half-written batch: the whole batch is one
     * transaction.
     */
    const stageImportBatch = (input: ImportStageBatchInput) =>
      Effect.gen(function* () {
        if (!isDbIdString(input.jobId)) {
          return yield* new InvalidDishData({ reason: "job id must be a decimal id string" });
        }

        if (!Number.isInteger(input.baseIndex) || input.baseIndex < 0) {
          return yield* new InvalidDishData({ reason: "baseIndex must be a non-negative integer" });
        }

        if (input.records.length === 0 || input.records.length > IMPORT_STAGE_BATCH_SIZE) {
          return yield* new InvalidDishData({
            reason: `each stage batch holds 1 to ${IMPORT_STAGE_BATCH_SIZE} records; got ${input.records.length}`,
          });
        }

        return yield* withTransaction(
          "import/stage-batch",
          Effect.gen(function* () {
            const jobId = BigInt(input.jobId);
            const locked = yield* curation.lockImportJob(jobId);

            if (locked === null) {
              return yield* new DishNotFound({ dishId: input.jobId });
            }

            if (locked.status !== "staged") {
              return yield* new CatalogConflict({
                reason: `import job ${input.jobId} is ${locked.status}; only open staged jobs accept batches`,
              });
            }

            const endIndex = input.baseIndex + input.records.length;

            // Idempotent replay: this exact batch (or an earlier prefix the
            // client is re-asking about) already committed — report progress.
            if (endIndex <= locked.staged_count) {
              const complete = locked.staged_count >= locked.total_records;
              let status: string = locked.status;

              if (complete) {
                if (locked.valid_records > 0) {
                  status = "validated";
                } else {
                  status = "failed";
                }
              }

              return {
                jobId: input.jobId,
                status,
                stagedCount: locked.staged_count,
                totalRecords: locked.total_records,
                validRecords: locked.valid_records,
                invalidRecords: locked.invalid_records,
                batchValid: 0,
                batchInvalid: 0,
                complete,
              };
            }

            if (input.baseIndex !== locked.staged_count) {
              return yield* new CatalogConflict({
                reason:
                  `import job ${input.jobId} resume cursor is ${locked.staged_count}; ` +
                  `re-send the batch starting at record index ${locked.staged_count}`,
              });
            }

            if (endIndex > locked.total_records) {
              return yield* new InvalidDishData({
                reason:
                  `batch of ${input.records.length} records at index ${input.baseIndex} ` +
                  `overruns the declared total of ${locked.total_records} records`,
              });
            }

            // Global duplicate preflight: persisted staged slugs for the
            // whole job in one indexed scan — no payload parsing in memory.
            const staged = yield* curation.stagedSlugsByJobId(jobId);
            const stagedSlugs = new Map<string, string>();

            for (const row of staged) {
              if (row.record_slug !== null && !stagedSlugs.has(row.record_slug)) {
                stagedSlugs.set(row.record_slug, row.external_ref);
              }
            }

            const batchSlugs = new Map<string, string>();
            let batchValid = 0;
            let batchInvalid = 0;

            for (const [offset, raw] of input.records.entries()) {
              const globalIndex = input.baseIndex + offset;

              const invalidRow = curation.insertStagedImportRecord({
                jobId,
                externalRef: `record-${globalIndex + 1}`,
                status: "invalid",
                errors: JSON.stringify(["record is not a valid dish entry"]),
                dishId: null,
                payload: { record: raw, duplicateOf: null },
                recordIndex: globalIndex,
                recordSlug: null,
              });

              // Extended shape first: strict `AuthoringDish` decoding strips
              // unknown keys, so city forms would lose their names before
              // normalization ever sees them. Undecodable rows stage invalid
              // (never applied) with the raw envelope preserved — the batch
              // continues.
              const extended = Schema.decodeUnknownOption(ExtendedAuthoringDish)(raw);

              if (Option.isNone(extended)) {
                yield* invalidRow;

                batchInvalid += 1;

                continue;
              }

              // City/province place forms normalize to canonical registry
              // links here; unresolvable names ride along as prior errors
              // and keep the row invalid (never applied).
              const recordRef = extended.value.slug ?? `record-${globalIndex + 1}`;
              const normalized = yield* normalizeExtendedRecord(extended.value, recordRef);
              const authoring = Schema.decodeUnknownOption(AuthoringDish)(normalized.record);

              if (Option.isNone(authoring)) {
                yield* invalidRow;

                batchInvalid += 1;

                continue;
              }

              const record = authoring.value;
              const externalRef = record.slug ?? `record-${globalIndex + 1}`;
              const checked = yield* validateRecord(record, globalIndex, normalized.placeErrors);
              const errors = [...checked.errors];
              let duplicateSlug = false;

              if (record.slug !== undefined) {
                const earlierBatch = batchSlugs.get(record.slug);

                if (earlierBatch !== undefined) {
                  errors.push(
                    `duplicate slug "${record.slug}" also used by "${earlierBatch}" in this import (record ${globalIndex + 1})`,
                  );
                  duplicateSlug = true;
                } else {
                  batchSlugs.set(record.slug, externalRef);
                }

                const earlierStaged = stagedSlugs.get(record.slug);

                if (earlierStaged !== undefined) {
                  errors.push(
                    `duplicate slug "${record.slug}" already staged as "${earlierStaged}" in this import`,
                  );
                  duplicateSlug = true;
                }
              }

              // Colliding rows keep the global finding (record_slug plus the
              // error text name the slug) but need a distinct external_ref:
              // (job_id, external_ref) is UNIQUE, so reusing the bare slug
              // would reject the second occurrence. `#` never appears in
              // real slugs, so the suffix cannot collide with a genuine ref;
              // the global index keeps even pathological repeats unique.
              // Truncated to the 300-char column bound with the index
              // suffix intact, so uniqueness always survives.
              let storedExternalRef = externalRef;

              if (duplicateSlug && record.slug !== undefined) {
                const tag = `#record-${globalIndex + 1}`;
                const candidate = `${record.slug}${tag}`;

                storedExternalRef =
                  candidate.length > 300
                    ? `${record.slug.slice(0, 300 - tag.length)}${tag}`
                    : candidate;
              }

              const status = errors.length === 0 ? "valid" : "invalid";

              if (status === "valid") {
                batchValid += 1;
              } else {
                batchInvalid += 1;
              }

              yield* curation.insertStagedImportRecord({
                jobId,
                externalRef: storedExternalRef,
                status,
                errors: errors.length === 0 ? null : JSON.stringify(errors),
                dishId: null,
                payload: { record, duplicateOf: checked.duplicateOf },
                recordIndex: globalIndex,
                recordSlug: record.slug ?? null,
              });
            }

            const stagedCount = locked.staged_count + input.records.length;
            const validRecords = locked.valid_records + batchValid;
            const invalidRecords = locked.invalid_records + batchInvalid;
            const complete = stagedCount >= locked.total_records;
            let status: string = "staged";

            if (complete) {
              if (validRecords > 0) {
                status = "validated";
              } else {
                status = "failed";
              }
            }

            yield* curation.updateImportJobStage({
              id: jobId,
              stagedCount,
              validRecords,
              invalidRecords,
              status,
              completedAt: complete ? new Date().toISOString() : null,
            });

            return {
              jobId: input.jobId,
              status,
              stagedCount,
              totalRecords: locked.total_records,
              validRecords,
              invalidRecords,
              batchValid,
              batchInvalid,
              complete,
            };
          }),
        );
      });
    /**
     * Bounded apply core shared by the legacy single-call `applyImport` and
     * the cursor-driven `applyImportBatch`. One call applies at most `limit`
     * `valid` rows, persists per-batch outcomes on the job row, and reports
     * whether more work remains — so every call fits the server-function
     * budget and a crash resumes from stored row statuses, never by
     * replaying applied rows.
     *
     * Concurrency: mutual exclusion is a non-blocking try-lock on the job
     * row. A concurrent apply colliding with a live batch fails fast with
     * a typed conflict (exactly one winner), while sequential batches,
     * crash resumes, and post-completion repeats never contend and proceed.
     * Only `valid` rows are ever selected, so even racing workers could
     * never double-apply the same record — but races are rejected before
     * selection, not after.
     */

    const runApplyBatch = (input: ImportApplyInput & { readonly limit: number }) =>
      Effect.gen(function* () {
        if (!isDbIdString(input.jobId)) {
          return yield* new InvalidDishData({ reason: "job id must be a decimal id string" });
        }

        const actor = input.actorUserId.trim();

        if (actor.length === 0) {
          return yield* new InvalidDishData({ reason: "approving actor is required" });
        }

        const job = yield* curation.findImportJobForApply(BigInt(input.jobId));

        if (job === null) {
          return yield* new DishNotFound({ dishId: input.jobId });
        }

        if (job.status !== "validated" && job.status !== "applying") {
          return yield* new CatalogConflict({
            reason: `import job ${input.jobId} is ${job.status}, only validated jobs can be applied`,
          });
        }

        const licenseRaw = job.license ?? "";
        const separator = licenseRaw.indexOf(":");
        const sourceId = separator === -1 ? "" : licenseRaw.slice(0, separator);
        const licensePart = separator === -1 ? licenseRaw : licenseRaw.slice(separator + 1);
        const reviewRequired = licenseRaw.length === 0 || needsLicenseReview(sourceId, licensePart);

        if (reviewRequired && !input.approvals.licenseAck) {
          return yield* new InvalidDishData({
            reason: "license review acknowledgement is required before applying this import",
          });
        }

        if (!input.approvals.reviewAck) {
          return yield* new InvalidDishData({
            reason: "review acknowledgement is required before applying this import",
          });
        }

        // Guarded apply: the whole claim-and-finish sequence runs in one
        // short guard transaction. Mutual exclusion is a non-blocking
        // try-lock (SELECT ... FOR UPDATE NOWAIT): a concurrent apply
        // colliding with a live batch fails fast with a typed conflict
        // naming the running apply, instead of queueing behind the winner
        // and double-reporting success. Sequential batches, crash resumes,
        // and post-completion repeats never contend, so they proceed. Row
        // selection is always rebuilt from current row statuses, so a
        // guard-transaction retry never replays an already-applied record.
        return yield* withTransaction(
          "import/apply",
          Effect.gen(function* () {
            const attempt = yield* curation.tryLockImportJobForApply(job.id);

            const locked = yield* Option.match(attempt, {
              onNone: () =>
                Effect.fail(
                  new CatalogConflict({
                    reason: `another apply is already running for import job ${input.jobId}`,
                  }),
                ),
              onSome: (row) =>
                row === null
                  ? Effect.fail(new DishNotFound({ dishId: input.jobId }))
                  : Effect.succeed(row),
            });

            if (locked.status !== "validated" && locked.status !== "applying") {
              return yield* new CatalogConflict({
                reason: `import job ${input.jobId} is ${locked.status}, only validated jobs can be applied`,
              });
            }

            // Bounded pending window in original dataset order: only `valid`
            // rows are ever selected, so applied/skipped/failed rows are
            // never replayed after a crash or a budget timeout. The caller
            // drives the cursor forward call by call until done.
            const limit = Math.min(Math.max(Math.floor(input.limit), 1), IMPORT_APPLY_BATCH_SIZE);
            const rows = yield* curation.pendingRecordsByJobId(locked.id, limit);
            const acknowledged = new Set(input.approvals.duplicateRefs);

            const pending: Array<{
              readonly rowId: bigint;
              readonly externalRef: string;
              readonly record: AuthoringDish;
              readonly duplicateOf: string | null;
            }> = [];

            // Ack pre-scan BEFORE any write in this batch: unlike the legacy
            // all-at-once apply (which could commit early rows then fail on a
            // later unacknowledged duplicate), a batch never leaves a
            // half-applied window behind an acknowledgement failure.
            for (const row of rows) {
              const raw: unknown = JSON.parse(row.payload);

              const stored = yield* Option.match(
                Schema.decodeUnknownOption(StoredImportRecord)(raw),
                {
                  onNone: () =>
                    Effect.fail(new InvalidDishData({ reason: "stored import record is corrupt" })),
                  onSome: (value) => Effect.succeed(value),
                },
              );

              if (stored.duplicateOf !== null && !acknowledged.has(row.external_ref)) {
                return yield* new InvalidDishData({
                  reason: `duplicate "${row.external_ref}" requires acknowledgement before apply`,
                });
              }

              pending.push({
                rowId: row.id,
                externalRef: row.external_ref,
                record: stored.record,
                duplicateOf: stored.duplicateOf,
              });
            }

            // Atomic apply claim: one conditional UPDATE moves validated ->
            // applying (and re-admits applying for crash resume) while
            // clearing dry_run. Under the guard lock above this always
            // matches; a zero-row result is reported with the current state.
            const claimed = yield* curation.claimImportJobForApply(job.id);

            if (claimed === null) {
              const current = yield* curation.findImportJobForApply(job.id);

              if (current === null) {
                return yield* new DishNotFound({ dishId: input.jobId });
              }

              return yield* new CatalogConflict({
                reason: `import job ${input.jobId} is ${current.status}, only validated jobs can be applied`,
              });
            }

            const provenance: ApplyJobProvenance = {
              id: claimed.id,
              sourceName: claimed.source_name,
              sourceUrl: claimed.source_url,
              sourceVersion: claimed.source_version,
              license: claimed.license,
              attribution: claimed.attribution,
            };

            let applied = 0;
            let skippedDuplicate = 0;
            let failed = 0;

            for (const entry of pending) {
              const outcome = yield* applyRecord(
                provenance,
                entry.rowId,
                entry.externalRef,
                entry.record,
                entry.duplicateOf,
              ).pipe(
                Effect.matchEffect({
                  onFailure: () =>
                    Effect.succeed({ applied: false as const, skipped: false as const }),
                  onSuccess: (result) =>
                    Effect.succeed({ applied: result.applied, skipped: !result.applied }),
                }),
              );

              if (outcome.applied) {
                applied += 1;
              } else if (outcome.skipped) {
                skippedDuplicate += 1;
              } else {
                failed += 1;

                yield* curation.updateImportRecord({
                  id: entry.rowId,
                  status: "invalid",
                  errors: JSON.stringify(["apply failed"]),
                  dishId: null,
                });
              }
            }

            yield* curation.approveImportJob({
              id: claimed.id,
              approvedBy: actor,
              approvedAt: new Date().toISOString(),
              licenseAck: input.approvals.licenseAck,
              reviewAck: input.approvals.reviewAck,
              duplicateRefs: [...input.approvals.duplicateRefs],
            });

            // Job counters keep validation semantics: valid_records/invalid_records
            // stay frozen at their validation values (so total == valid + invalid
            // still holds for the dashboard, and valid >= applied), while apply
            // outcomes accumulate in applied/skipped/failed counters plus the
            // per-record rows. The job flips to applied only when no `valid`
            // rows remain — checked AFTER this batch commits its row writes,
            // so `done: false` honestly means "call again".
            const counts = yield* curation.recordCountsByJobId(claimed.id);
            let pendingValid = 0;

            for (const entry of counts) {
              if (entry.status === "valid") {
                pendingValid = entry.total;
              }
            }

            const done = pendingValid === 0;

            yield* curation.updateImportJobApply({
              id: claimed.id,
              appliedCount: claimed.applied_count + applied,
              skippedCount: claimed.skipped_count + skippedDuplicate,
              applyFailedCount: claimed.apply_failed_count + failed,
              status: done ? "applied" : "applying",
              completedAt: done ? new Date().toISOString() : null,
            });

            return {
              jobId: input.jobId,
              applied,
              skippedDuplicate,
              failed,
              done,
              pending: pendingValid,
            };
          }),
        );
      });

    /**
     * Legacy single-call apply: one bounded batch (default
     * IMPORT_APPLY_BATCH_SIZE). Small jobs finish in one call with
     * `done: true`; large jobs report `done: false` plus the remaining
     * `pending` count and the client repeats the call. Use
     * `applyImportBatch` explicitly for cursor-driven loops.
     */
    const applyImport = (input: ImportApplyInput) =>
      runApplyBatch({ ...input, limit: input.limit ?? IMPORT_APPLY_BATCH_SIZE });

    const applyImportBatch = (input: ImportApplyInput) =>
      runApplyBatch({ ...input, limit: input.limit ?? IMPORT_APPLY_BATCH_SIZE });

    /**
     * Paginated review surface for large jobs: keyset page over staged
     * records with an optional status filter, plus per-status totals for
     * progress display. Never loads the whole staged set at once.
     * `duplicateOf` is read from the stored payload envelope (best effort:
     * corrupt payloads surface as null and fail loudly at apply time, never
     * silently), so the review UI can offer duplicate acknowledgement
     * without loading every payload.
     */
    const importJobIssues = (input: ImportJobIssuesInput) =>
      Effect.gen(function* () {
        if (!isDbIdString(input.jobId)) {
          return yield* new InvalidDishData({ reason: "job id must be a decimal id string" });
        }

        const jobId = BigInt(input.jobId);
        const job = yield* curation.adminFindImportJob(jobId);

        if (job === null) {
          return yield* new DishNotFound({ dishId: input.jobId });
        }

        const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 200);

        let cursor = 0n;

        if (input.cursor !== undefined && input.cursor !== "0") {
          if (!isDbIdString(input.cursor)) {
            return yield* new InvalidDishData({ reason: "cursor must be a decimal id string" });
          }

          cursor = BigInt(input.cursor);
        }

        const status = input.status ?? null;

        const page = yield* curation.recordsPageByJobId({
          jobId,
          cursor,
          status,
          limit: limit + 1,
        });

        const counts = yield* curation.recordCountsByJobId(jobId);

        const totals = {
          total: 0,
          pending: 0,
          valid: 0,
          invalid: 0,
          applied: 0,
          skippedDuplicate: 0,
        };

        for (const entry of counts) {
          totals.total += entry.total;

          if (entry.status === "pending") {
            totals.pending = entry.total;
          } else if (entry.status === "valid") {
            totals.valid = entry.total;
          } else if (entry.status === "invalid") {
            totals.invalid = entry.total;
          } else if (entry.status === "applied") {
            totals.applied = entry.total;
          } else if (entry.status === "skipped_duplicate") {
            totals.skippedDuplicate = entry.total;
          }
        }

        const hasMore = page.length > limit;
        const window = hasMore ? page.slice(0, limit) : page;

        return {
          job: {
            id: job.id,
            sourceName: job.source_name,
            status: job.status,
            totalRecords: job.total_records,
            validRecords: job.valid_records,
            invalidRecords: job.invalid_records,
          },
          records: window.map((row) => ({
            id: row.id,
            jobId: row.job_id,
            externalRef: row.external_ref,
            status: row.status,
            errors: row.errors,
            dishId: row.dish_id,
            recordIndex: row.record_index,
            recordSlug: row.record_slug,
            duplicateOf: storedDuplicateOf(row.payload),
            createdAt: String(row.created_at),
          })),
          nextCursor: hasMore ? (window[window.length - 1]?.id ?? null) : null,
          totals,
        };
      });

    return CatalogImportService.of({
      validateImport,
      applyImport,
      beginImport,
      stageImportBatch,
      applyImportBatch,
      importJobIssues,
    });
  }),
);
