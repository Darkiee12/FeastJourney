import { Context, Data, Effect, Layer } from "effect";

import {
  InvalidLocale,
  type InvalidSearchFilter,
} from "@/modules/food-discovery/server/domain/errors";
import {
  encodeDbId,
  isLanguageTag,
  isSlug,
  slugifyName,
} from "@/modules/food-discovery/server/domain/ids";
import {
  normalizeSearchKey,
  toContainsKey,
  toPrefixKey,
} from "@/modules/food-discovery/server/domain/search";
import { DishRelationsRepository } from "@/modules/food-discovery/server/repository/dish-relations-repository";
import { IngredientRepository } from "@/modules/food-discovery/server/repository/ingredient-repository";
import { TaxonomyRepository } from "@/modules/food-discovery/server/repository/taxonomy-repository";
import { type AuditContext, recordAuditEvent } from "@/modules/user/server/operations/audit";
import { Authorization } from "@/modules/user/server/operations/authorization";
import type { RoleRepository } from "@/modules/user/server/repository/role-repository";
import type { UserRepository } from "@/modules/user/server/repository/user-repository";
import { Actor } from "@/server/auth/actor";
import { CurrentActor } from "@/server/auth/current-actor";
import { type InsufficientPermissions } from "@/server/auth/errors";
import { type Database, withTransaction } from "@/server/database/client";
import { type TransactionFailed } from "@/server/database/errors";
import type { DatabaseError } from "@/server/database/query";

/**
 * Curator-managed taxonomy administration: cuisines and ingredients can be
 * added without code deploys. Reads are policy-free (the transport owns the
 * `food:import` gate for every taxonomy function); every mutation resolves
 * the per-request `CurrentActor` and enforces `food:import` inside the
 * operation, so a missing transport check still fails closed.
 *
 * Each created row writes one `security_audit_events` record in the same
 * transaction as the mutation (mirrors the user-module role audit pattern).
 * The dish-bound `catalog_revisions` table cannot audit taxonomy rows
 * (its `dish_id` is NOT NULL), and no new tables are introduced.
 */

export class InvalidTaxonomyData extends Data.TaggedError("InvalidTaxonomyData")<{
  readonly reason: string;
}> {}

export class ConflictingTaxonomy extends Data.TaggedError("ConflictingTaxonomy")<{
  readonly reason: string;
}> {}

export type TaxonomyAdminError =
  | ConflictingTaxonomy
  | InvalidLocale
  | InvalidSearchFilter
  | InvalidTaxonomyData
  | InsufficientPermissions
  | DatabaseError
  | TransactionFailed;

export type TaxonomyAdminEnv =
  | Database
  | TaxonomyRepository
  | IngredientRepository
  | Authorization
  | RoleRepository
  | CurrentActor
  | UserRepository;

export interface CuisineSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface IngredientSummary {
  readonly id: string;
  readonly name: string;
}

export interface TaxonomyListInput {
  readonly query?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface CreateCuisineInput {
  readonly slug?: string | undefined;
  readonly name: string;
}

export interface CreateIngredientInput {
  readonly name: string;
  readonly languageTag?: string | undefined;
}

export interface BulkCuisineEntry {
  readonly slug?: string | undefined;
  readonly name: string;
}

export interface BulkIngredientEntry {
  readonly name: string;
  readonly languageTag?: string | undefined;
}

export interface SkippedTaxonomyRow<Entry> {
  readonly entry: Entry;
  readonly reason: string;
}

export interface InvalidTaxonomyRow<Entry> {
  readonly entry: Entry;
  readonly reason: string;
}

export interface BulkCuisineReport {
  readonly created: ReadonlyArray<CuisineSummary>;
  readonly skipped: ReadonlyArray<SkippedTaxonomyRow<BulkCuisineEntry>>;
  readonly invalid: ReadonlyArray<InvalidTaxonomyRow<BulkCuisineEntry>>;
}

export interface BulkIngredientReport {
  readonly created: ReadonlyArray<IngredientSummary>;
  readonly skipped: ReadonlyArray<SkippedTaxonomyRow<BulkIngredientEntry>>;
  readonly invalid: ReadonlyArray<InvalidTaxonomyRow<BulkIngredientEntry>>;
}

export interface TaxonomyAdminServiceApi {
  readonly listCuisines: (
    input: TaxonomyListInput,
  ) => Effect.Effect<{ readonly cuisines: ReadonlyArray<CuisineSummary> }, DatabaseError, Database>;
  readonly createCuisine: (
    input: CreateCuisineInput,
    audit: AuditContext,
  ) => Effect.Effect<CuisineSummary, TaxonomyAdminError, TaxonomyAdminEnv>;
  readonly bulkCreateCuisines: (
    input: { readonly entries: ReadonlyArray<BulkCuisineEntry> },
    audit: AuditContext,
  ) => Effect.Effect<BulkCuisineReport, TaxonomyAdminError, TaxonomyAdminEnv>;
  readonly listIngredients: (
    input: TaxonomyListInput,
  ) => Effect.Effect<
    { readonly ingredients: ReadonlyArray<IngredientSummary> },
    DatabaseError,
    Database
  >;
  readonly createIngredient: (
    input: CreateIngredientInput,
    audit: AuditContext,
  ) => Effect.Effect<IngredientSummary, TaxonomyAdminError, TaxonomyAdminEnv>;
  readonly bulkCreateIngredients: (
    input: { readonly entries: ReadonlyArray<BulkIngredientEntry> },
    audit: AuditContext,
  ) => Effect.Effect<BulkIngredientReport, TaxonomyAdminError, TaxonomyAdminEnv>;
}

export class TaxonomyAdminService extends Context.Service<
  TaxonomyAdminService,
  TaxonomyAdminServiceApi
>()("feastjourney/food-discovery/TaxonomyAdminService") {}

export const MAX_TAXONOMY_NAME_LENGTH = 300;

export const MAX_TAXONOMY_SLUG_LENGTH = 120;

export const MAX_TAXONOMY_LIST_LIMIT = 100;

export const MAX_TAXONOMY_BULK_ENTRIES = 100;

export const DEFAULT_TAXONOMY_LANGUAGE_TAG = "en";

/**
 * Registry ingredient names require a `name_kind`; curator-added names
 * default to `localized`, matching the majority seed kind. The taxonomy
 * contract carries no name-kind field, so this default is structural.
 */
export const NEW_INGREDIENT_NAME_KIND = "localized";

export interface CleanTaxonomyName {
  readonly name: string;
  readonly searchKey: string;
}

/**
 * Pure name validation shared by cuisines and ingredients: trims, enforces
 * the 1-300 character bound, and requires searchable text after the shared
 * `normalizeSearchKey` fold. Returns null when the name is unusable.
 */
export const cleanTaxonomyName = (name: string): CleanTaxonomyName | null => {
  const trimmed = name.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_TAXONOMY_NAME_LENGTH) {
    return null;
  }

  const searchKey = normalizeSearchKey(trimmed);

  if (searchKey.length === 0) {
    return null;
  }

  return { name: trimmed, searchKey };
};

/**
 * Pure cuisine slug resolution: an explicit slug is validated against the
 * canonical slug pattern (never normalized — an explicit `Pho` is rejected,
 * not lowercased); an omitted slug derives from the display name via the
 * shared `slugifyName`. Returns null only for an invalid explicit slug.
 */
export const cleanCuisineSlug = (slug: string | null | undefined, name: string): string | null => {
  if (slug === null || slug === undefined) {
    return slugifyName(name.trim());
  }

  const trimmed = slug.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_TAXONOMY_SLUG_LENGTH || !isSlug(trimmed)) {
    return null;
  }

  return trimmed;
};

/**
 * Pure language-tag resolution for ingredient names: omitted or blank tags
 * fall back to English; anything else must match the canonical locale
 * pattern. Returns null for a malformed explicit tag.
 */
export const cleanLanguageTag = (tag: string | null | undefined): string | null => {
  if (tag === null || tag === undefined || tag.trim().length === 0) {
    return DEFAULT_TAXONOMY_LANGUAGE_TAG;
  }

  const trimmed = tag.trim();

  if (!isLanguageTag(trimmed)) {
    return null;
  }

  return trimmed;
};

interface DisplayName {
  readonly languageTag: string;
  readonly name: string;
  readonly isPreferred: boolean;
}

const pickDisplayName = (names: ReadonlyArray<DisplayName>): string | null => {
  if (names.length === 0) {
    return null;
  }

  const english = names.filter((entry) => entry.languageTag === DEFAULT_TAXONOMY_LANGUAGE_TAG);
  const preferredEnglish = english.find((entry) => entry.isPreferred);

  if (preferredEnglish !== undefined) {
    return preferredEnglish.name;
  }

  if (english.length > 0) {
    return english[0]?.name ?? null;
  }

  return names.find((entry) => entry.isPreferred)?.name ?? names[0]?.name ?? null;
};

const actorUserId = (actor: Actor): string | null =>
  Actor.$match(actor, {
    Guest: () => null,
    Member: ({ userId }) => userId,
  });

export const TaxonomyAdminServiceLive = Layer.effect(
  TaxonomyAdminService,
  Effect.gen(function* () {
    const taxonomy = yield* TaxonomyRepository;
    const ingredients = yield* IngredientRepository;
    const relations = yield* DishRelationsRepository;

    const requireFoodImport = Effect.gen(function* () {
      const actor = yield* CurrentActor;
      const authorization = yield* Authorization;

      yield* authorization.require(actor, { resource: "food", actions: ["import"] });

      return actor;
    });

    const createCuisineRow = (
      entry: BulkCuisineEntry,
      seenSlugs: Set<string>,
      audit: AuditContext,
      actor: Actor,
    ): Effect.Effect<
      CuisineSummary,
      InvalidTaxonomyData | ConflictingTaxonomy | DatabaseError | TransactionFailed,
      Database | TaxonomyRepository | UserRepository
    > =>
      Effect.gen(function* () {
        const cleaned = cleanTaxonomyName(entry.name);

        if (cleaned === null) {
          return yield* new InvalidTaxonomyData({
            reason: `cuisine name must be 1-${MAX_TAXONOMY_NAME_LENGTH} characters with searchable text`,
          });
        }

        const slug = cleanCuisineSlug(entry.slug, cleaned.name);

        if (slug === null) {
          return yield* new InvalidTaxonomyData({
            reason: `invalid cuisine slug "${entry.slug ?? ""}": use lowercase alphanumeric words joined by single hyphens`,
          });
        }

        if (seenSlugs.has(slug)) {
          return yield* new ConflictingTaxonomy({
            reason: `duplicate cuisine slug "${slug}" in request`,
          });
        }

        seenSlugs.add(slug);

        const existing = yield* taxonomy.cuisineBySlug(slug);

        if (existing !== null) {
          return yield* new ConflictingTaxonomy({
            reason: `cuisine slug "${slug}" already exists`,
          });
        }

        return yield* withTransaction(
          "taxonomy/cuisine-create",
          Effect.gen(function* () {
            const row = yield* Effect.catchTag(
              taxonomy.insertCuisine(slug),
              "PersistenceConflict",
              () =>
                Effect.fail(
                  new ConflictingTaxonomy({ reason: `cuisine slug "${slug}" already exists` }),
                ),
            );

            yield* Effect.catchTag(
              taxonomy.insertCuisineName({
                cuisineId: row.id,
                languageTag: DEFAULT_TAXONOMY_LANGUAGE_TAG,
                name: cleaned.name,
                isPreferred: true,
                searchKey: cleaned.searchKey,
              }),
              "PersistenceConflict",
              () =>
                Effect.fail(
                  new ConflictingTaxonomy({
                    reason: `cuisine slug "${slug}" already exists`,
                  }),
                ),
            );

            yield* recordAuditEvent({
              actorUserId: actorUserId(actor),
              sessionId: audit.sessionId,
              requestId: audit.requestId,
              event: "food.taxonomy.cuisine.created",
              outcome: "succeeded",
              resource: `cuisine:${row.slug}`,
              metadata: { slug: row.slug, name: cleaned.name },
            });

            return {
              id: encodeDbId(row.id),
              slug: row.slug,
              name: cleaned.name,
            };
          }),
        );
      });

    const createIngredientRow = (
      entry: BulkIngredientEntry,
      seenKeys: Set<string>,
      audit: AuditContext,
      actor: Actor,
    ): Effect.Effect<
      IngredientSummary,
      InvalidTaxonomyData | InvalidLocale | ConflictingTaxonomy | DatabaseError | TransactionFailed,
      Database | TaxonomyRepository | IngredientRepository | UserRepository
    > =>
      Effect.gen(function* () {
        const cleaned = cleanTaxonomyName(entry.name);

        if (cleaned === null) {
          return yield* new InvalidTaxonomyData({
            reason: `ingredient name must be 1-${MAX_TAXONOMY_NAME_LENGTH} characters with searchable text`,
          });
        }

        const languageTag = cleanLanguageTag(entry.languageTag);

        if (languageTag === null) {
          return yield* new InvalidLocale({ locale: entry.languageTag ?? "" });
        }

        const dedupeKey = `${languageTag} ${cleaned.searchKey}`;

        if (seenKeys.has(dedupeKey)) {
          return yield* new ConflictingTaxonomy({
            reason: `duplicate ingredient "${cleaned.name}" in request`,
          });
        }

        seenKeys.add(dedupeKey);

        const matches = yield* ingredients.resolveByKey(cleaned.searchKey, languageTag, 1);

        if (matches.length > 0) {
          return yield* new ConflictingTaxonomy({
            reason: `ingredient "${cleaned.name}" already exists`,
          });
        }

        return yield* withTransaction(
          "taxonomy/ingredient-create",
          Effect.gen(function* () {
            const row = yield* ingredients.insert();

            yield* relations.insertIngredientName({
              ingredientId: row.id,
              languageTag,
              name: cleaned.name,
              nameKind: NEW_INGREDIENT_NAME_KIND,
              isPreferred: true,
              searchKey: cleaned.searchKey,
            });

            yield* recordAuditEvent({
              actorUserId: actorUserId(actor),
              sessionId: audit.sessionId,
              requestId: audit.requestId,
              event: "food.taxonomy.ingredient.created",
              outcome: "succeeded",
              resource: `ingredient:${row.id.toString()}`,
              metadata: {
                ingredient_id: row.id.toString(),
                name: cleaned.name,
                language_tag: languageTag,
              },
            });

            return {
              id: encodeDbId(row.id),
              name: cleaned.name,
            };
          }),
        );
      });

    const listCuisines: TaxonomyAdminServiceApi["listCuisines"] = (input) =>
      Effect.gen(function* () {
        const rows = yield* taxonomy.cuisines();
        const grouped = new Map<string, { slug: string; names: Array<DisplayName> }>();

        for (const row of rows) {
          const key = row.id.toString();
          const group = grouped.get(key);

          if (group === undefined) {
            grouped.set(key, {
              slug: row.slug,
              names: [
                {
                  languageTag: row.language_tag,
                  name: row.name,
                  isPreferred: row.is_preferred,
                },
              ],
            });
          } else {
            group.names.push({
              languageTag: row.language_tag,
              name: row.name,
              isPreferred: row.is_preferred,
            });
          }
        }

        const query = (input.query ?? "").trim();
        const key = query.length === 0 ? "" : normalizeSearchKey(query);

        if (query.length > 0 && key.length === 0) {
          return { cuisines: [] };
        }

        const summaries: Array<CuisineSummary> = [];

        for (const [id, group] of grouped) {
          if (key.length > 0) {
            const matches = group.names.some((entry) =>
              normalizeSearchKey(entry.name).includes(key),
            );

            if (!matches && !group.slug.includes(key)) {
              continue;
            }
          }

          const display = pickDisplayName(group.names);

          summaries.push({ id, slug: group.slug, name: display ?? group.slug });
        }

        const offset = Math.max(input.offset, 0);
        const limit = Math.min(Math.max(input.limit, 1), MAX_TAXONOMY_LIST_LIMIT);

        return { cuisines: summaries.slice(offset, offset + limit) };
      });

    const createCuisine: TaxonomyAdminServiceApi["createCuisine"] = (input, audit) =>
      Effect.gen(function* () {
        const actor = yield* requireFoodImport;

        return yield* createCuisineRow(
          { slug: input.slug, name: input.name },
          new Set<string>(),
          audit,
          actor,
        );
      });

    const bulkCreateCuisines: TaxonomyAdminServiceApi["bulkCreateCuisines"] = (input, audit) =>
      Effect.gen(function* () {
        const actor = yield* requireFoodImport;

        if (input.entries.length > MAX_TAXONOMY_BULK_ENTRIES) {
          return yield* new InvalidTaxonomyData({
            reason: `bulk create holds at most ${MAX_TAXONOMY_BULK_ENTRIES} entries per call`,
          });
        }

        const seenSlugs = new Set<string>();
        const created: Array<CuisineSummary> = [];
        const skipped: Array<SkippedTaxonomyRow<BulkCuisineEntry>> = [];
        const invalid: Array<InvalidTaxonomyRow<BulkCuisineEntry>> = [];

        for (const entry of input.entries) {
          const outcome = yield* createCuisineRow(entry, seenSlugs, audit, actor).pipe(
            Effect.map((summary) => ({ status: "created", summary }) as const),
            Effect.catchTags({
              ConflictingTaxonomy: (failure) =>
                Effect.succeed({ status: "skipped", reason: failure.reason } as const),
              InvalidTaxonomyData: (failure) =>
                Effect.succeed({ status: "invalid", reason: failure.reason } as const),
              DatabaseUnavailable: () =>
                Effect.succeed({
                  status: "invalid",
                  reason: "could not save this entry; try again",
                } as const),
              PersistenceError: () =>
                Effect.succeed({
                  status: "invalid",
                  reason: "could not save this entry; try again",
                } as const),
              PersistenceConflict: () =>
                Effect.succeed({
                  status: "invalid",
                  reason: "could not save this entry; try again",
                } as const),
              TransactionConflict: () =>
                Effect.succeed({
                  status: "invalid",
                  reason: "could not save this entry; try again",
                } as const),
              TransactionFailed: () =>
                Effect.succeed({
                  status: "invalid",
                  reason: "could not save this entry; try again",
                } as const),
            }),
          );

          if (outcome.status === "created") {
            created.push(outcome.summary);
          } else if (outcome.status === "skipped") {
            skipped.push({ entry, reason: outcome.reason });
          } else {
            invalid.push({ entry, reason: outcome.reason });
          }
        }

        return { created, skipped, invalid };
      });

    const listIngredients: TaxonomyAdminServiceApi["listIngredients"] = (input) =>
      Effect.gen(function* () {
        const query = (input.query ?? "").trim();

        if (query.length > 0 && normalizeSearchKey(query).length === 0) {
          return { ingredients: [] };
        }

        const offset = Math.max(input.offset, 0);
        const limit = Math.min(Math.max(input.limit, 1), MAX_TAXONOMY_LIST_LIMIT);
        const key = query.length === 0 ? "" : normalizeSearchKey(query);

        const ids = yield* ingredients.searchIds(
          query.length === 0
            ? { q: "", prefix: "%", contains: "%%", limit: offset + limit }
            : {
                q: key,
                prefix: toPrefixKey(key),
                contains: toContainsKey(key),
                limit: offset + limit,
              },
        );

        const page = ids.slice(offset, offset + limit);

        if (page.length === 0) {
          return { ingredients: [] };
        }

        const names = yield* ingredients.namesByIngredientIds(page.map((entry) => entry.id));
        const byIngredient = new Map<string, Array<DisplayName>>();

        for (const row of names) {
          const list = byIngredient.get(row.ingredient_id.toString()) ?? [];

          list.push({
            languageTag: row.language_tag,
            name: row.name,
            isPreferred: row.is_preferred,
          });
          byIngredient.set(row.ingredient_id.toString(), list);
        }

        return {
          ingredients: page.map((entry) => {
            const id = encodeDbId(entry.id);
            const display = pickDisplayName(byIngredient.get(entry.id.toString()) ?? []);

            return { id, name: display ?? `#${id}` };
          }),
        };
      });

    const createIngredient: TaxonomyAdminServiceApi["createIngredient"] = (input, audit) =>
      Effect.gen(function* () {
        const actor = yield* requireFoodImport;

        return yield* createIngredientRow(
          { name: input.name, languageTag: input.languageTag },
          new Set<string>(),
          audit,
          actor,
        );
      });

    const bulkCreateIngredients: TaxonomyAdminServiceApi["bulkCreateIngredients"] = (
      input,
      audit,
    ) =>
      Effect.gen(function* () {
        const actor = yield* requireFoodImport;

        if (input.entries.length > MAX_TAXONOMY_BULK_ENTRIES) {
          return yield* new InvalidTaxonomyData({
            reason: `bulk create holds at most ${MAX_TAXONOMY_BULK_ENTRIES} entries per call`,
          });
        }

        const seenKeys = new Set<string>();
        const created: Array<IngredientSummary> = [];
        const skipped: Array<SkippedTaxonomyRow<BulkIngredientEntry>> = [];
        const invalid: Array<InvalidTaxonomyRow<BulkIngredientEntry>> = [];

        for (const entry of input.entries) {
          const outcome = yield* createIngredientRow(entry, seenKeys, audit, actor).pipe(
            Effect.map((summary) => ({ status: "created", summary }) as const),
            Effect.catchTags({
              ConflictingTaxonomy: (failure) =>
                Effect.succeed({ status: "skipped", reason: failure.reason } as const),
              InvalidTaxonomyData: (failure) =>
                Effect.succeed({ status: "invalid", reason: failure.reason } as const),
              InvalidLocale: () =>
                Effect.succeed({
                  status: "invalid",
                  reason: `invalid language tag "${entry.languageTag ?? ""}"`,
                } as const),
              DatabaseUnavailable: () =>
                Effect.succeed({
                  status: "invalid",
                  reason: "could not save this entry; try again",
                } as const),
              PersistenceError: () =>
                Effect.succeed({
                  status: "invalid",
                  reason: "could not save this entry; try again",
                } as const),
              PersistenceConflict: () =>
                Effect.succeed({
                  status: "invalid",
                  reason: "could not save this entry; try again",
                } as const),
              TransactionConflict: () =>
                Effect.succeed({
                  status: "invalid",
                  reason: "could not save this entry; try again",
                } as const),
              TransactionFailed: () =>
                Effect.succeed({
                  status: "invalid",
                  reason: "could not save this entry; try again",
                } as const),
            }),
          );

          if (outcome.status === "created") {
            created.push(outcome.summary);
          } else if (outcome.status === "skipped") {
            skipped.push({ entry, reason: outcome.reason });
          } else {
            invalid.push({ entry, reason: outcome.reason });
          }
        }

        return { created, skipped, invalid };
      });

    return TaxonomyAdminService.of({
      listCuisines,
      createCuisine,
      bulkCreateCuisines,
      listIngredients,
      createIngredient,
      bulkCreateIngredients,
    });
  }),
);
