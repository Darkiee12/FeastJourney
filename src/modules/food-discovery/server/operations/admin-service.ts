import { Context, Effect, Layer } from "effect";

import {
  type CatalogConflict,
  ConflictingDish,
  DishNotFound,
  InvalidDishData,
  InvalidLocale,
  InvalidRelationship,
  InvalidSearchFilter,
  UnknownPlace,
} from "@/modules/food-discovery/server/domain/errors";
import {
  type DishStatus,
  encodeDbId,
  isDbIdString,
  isLanguageTag,
  isSlug,
  slugifyName,
} from "@/modules/food-discovery/server/domain/ids";
import {
  normalizeSearchKey,
  toContainsKey,
  toPrefixKey,
} from "@/modules/food-discovery/server/domain/search";
import { CurationService } from "@/modules/food-discovery/server/operations/curation-service";
import {
  AmbiguousPlace,
  type AmbiguousPlaceCandidate,
} from "@/modules/food-discovery/server/operations/place-admin-service";
import { DishRelationsRepository } from "@/modules/food-discovery/server/repository/dish-relations-repository";
import { DishRepository } from "@/modules/food-discovery/server/repository/dish-repository";
import { IngredientRepository } from "@/modules/food-discovery/server/repository/ingredient-repository";
import { PlaceRepository } from "@/modules/food-discovery/server/repository/place-repository";
import { TaxonomyRepository } from "@/modules/food-discovery/server/repository/taxonomy-repository";
import type { Database } from "@/server/database/client";
import { withTransaction } from "@/server/database/client";
import {
  type DatabaseUnavailable,
  type PersistenceConflict,
  type PersistenceError,
  type TransactionConflict,
  type TransactionFailed,
} from "@/server/database/errors";

const STATUSES: ReadonlySet<string> = new Set(["draft", "review", "published", "archived"]);

const NAME_KINDS: ReadonlySet<string> = new Set([
  "native",
  "localized",
  "alias",
  "transliteration",
]);

const ROLES: ReadonlySet<string> = new Set(["core", "common", "optional", "garnish"]);
const ASSOCIATIONS: ReadonlySet<string> = new Set(["origin", "associated", "popular"]);
const MAX_SLUG_ATTEMPTS = 20;

// Single-parent dish-family trees stay shallow (seed data uses depth 1).
// The ancestor walk below is bounded so a crafted or legacy deep chain
// cannot turn parent assignment into an unbounded traversal: chains longer
// than this fail closed with InvalidRelationship.
const MAX_PARENT_CHAIN_DEPTH = 25;

export type AdminServiceError =
  | AmbiguousPlace
  | CatalogConflict
  | ConflictingDish
  | DishNotFound
  | InvalidDishData
  | InvalidLocale
  | InvalidRelationship
  | InvalidSearchFilter
  | UnknownPlace
  | DatabaseUnavailable
  | PersistenceError
  | PersistenceConflict
  | TransactionConflict
  | TransactionFailed;

export interface CreateDishNameInput {
  readonly languageTag: string;
  readonly name: string;
  readonly nameKind: string;
}

export interface CreateDishInput {
  readonly slug?: string | undefined;
  readonly status?: DishStatus | undefined;
  readonly parentSlug?: string | undefined;
  readonly names: ReadonlyArray<CreateDishNameInput>;
}

export interface UpdateDishInput {
  readonly slug?: string | undefined;
  readonly status?: DishStatus | undefined;
  readonly parentSlug?: string | undefined;
}

/**
 * Field-level dish edit: slug, status, and parent reassignment in one
 * operation. `parentSlug: null` clears the parent (root dish);
 * `undefined` keeps the current parent. Publication rules apply when the
 * status transitions to `published`, exactly like `updateDish`.
 */
export interface UpdateDishFieldsInput {
  readonly slug?: string | undefined;
  readonly status?: DishStatus | undefined;
  readonly parentSlug?: string | null | undefined;
}

export interface UpdateDishNameEntry {
  /** Present for in-place edits; absent for inserts. Never reuses an id. */
  readonly id?: string | undefined;
  readonly languageTag: string;
  readonly name: string;
  readonly nameKind: string;
  /** Absent keeps the stored flag (edits) or the lang-default (inserts). */
  readonly isPreferred?: boolean | undefined;
}

export interface UpdateDishNamesInput {
  readonly upsert: ReadonlyArray<UpdateDishNameEntry>;
  readonly removeIds: ReadonlyArray<string>;
}

export interface UpdateDishDescriptionEntry {
  readonly languageTag: string;
  readonly description: string;
  readonly summary: string | null;
}

export interface UpdateDishDescriptionsInput {
  readonly upsert: ReadonlyArray<UpdateDishDescriptionEntry>;
  readonly removeLanguageTags: ReadonlyArray<string>;
}

export interface UpdateDishIngredientEntry {
  readonly ingredientId: string;
  readonly role: string;
}

export interface UpdateDishIngredientsInput {
  readonly upsert: ReadonlyArray<UpdateDishIngredientEntry>;
  readonly removeIngredientIds: ReadonlyArray<string>;
}

export interface UpdateDishTaxonomyInput {
  readonly cuisineUpsert: ReadonlyArray<string>;
  readonly cuisineRemove: ReadonlyArray<string>;
  readonly categoryUpsert: ReadonlyArray<string>;
  readonly categoryRemove: ReadonlyArray<string>;
}

/**
 * Place targeting for dish links. Mirrors the canonical `PlaceRef` contract
 * from the place workstream (`place-admin-service.ts`): `{ placeId }` is a
 * decimal registry id, `{ iso }` is an ISO 3166 code, `{ city, parentIso }`
 * is a city display name optionally scoped by a parent ISO. City links never
 * accept free-text matching beyond the registry's own name resolution, and
 * ambiguous city names are rejected with the candidate list.
 *
 * LOCAL seam: `resolvePlaceRefLocal` implements these semantics directly on
 * `PlaceRepository` because `PlaceAdminServiceLive` is provided per-call in
 * `place.functions.ts`, not in `AppLive` — depending on it from
 * `AdminServiceLive` would require shared `layers.ts` changes owned by the
 * coordinator. The resolution rules (preferred-first, exact search key,
 * parent-ISO scoping, ambiguity rejection) match the canonical
 * `resolvePlaceRef`; the coordinator can swap the implementation to delegate
 * once layer wiring allows. `placeId` stays a decimal string (transport
 * shape) instead of the canonical number; both denote the same registry id.
 */
export type DishPlaceRef =
  | { readonly placeId: string }
  | { readonly iso: string }
  | { readonly city: string; readonly parentIso?: string | undefined };

export interface UpdateDishPlaceEntry {
  readonly place: DishPlaceRef;
  /** Defaults to `associated`; origin claims must be explicit. */
  readonly association?: string | undefined;
  readonly isDisputed?: boolean | undefined;
  readonly note?: string | null | undefined;
}

export interface UpdateDishPlacesInput {
  readonly upsert: ReadonlyArray<UpdateDishPlaceEntry>;
  readonly removePlaceIds: ReadonlyArray<string>;
}

/**
 * Editor refresh payloads: every dish update returns the counts plus the
 * resulting rows, so the curator UI re-renders from the save response
 * without a second fetch. Ids are decimal strings; all values are the
 * stored state after the transaction commits.
 */
export interface UpdatedDishName {
  readonly id: string;
  readonly languageTag: string;
  readonly name: string;
  readonly nameKind: string;
  readonly isPreferred: boolean;
}

export interface UpdatedDishDescription {
  readonly languageTag: string;
  readonly description: string;
  readonly summary: string | null;
}

export interface UpdatedDishIngredient {
  readonly ingredientId: string;
  readonly role: string;
}

export interface UpdatedDishPlace {
  readonly placeId: string;
  readonly association: string;
  readonly isDisputed: boolean;
  readonly note: string | null;
}

export interface UpdateDishFieldsResult {
  readonly id: string;
  readonly slug: string;
  readonly parentDishId: string | null;
  readonly status: DishStatus;
}

export interface UpdateDishNamesResult {
  readonly upserted: number;
  readonly removed: number;
  readonly names: ReadonlyArray<UpdatedDishName>;
}

export interface UpdateDishDescriptionsResult {
  readonly upserted: number;
  readonly removed: number;
  readonly descriptions: ReadonlyArray<UpdatedDishDescription>;
}

export interface UpdateDishIngredientsResult {
  readonly upserted: number;
  readonly removed: number;
  readonly ingredients: ReadonlyArray<UpdatedDishIngredient>;
}

export interface UpdateDishTaxonomyResult {
  readonly cuisinesLinked: number;
  readonly cuisinesUnlinked: number;
  readonly categoriesLinked: number;
  readonly categoriesUnlinked: number;
  readonly cuisines: ReadonlyArray<string>;
  readonly categories: ReadonlyArray<string>;
}

export interface UpdateDishPlacesResult {
  readonly upserted: number;
  readonly removed: number;
  readonly places: ReadonlyArray<UpdatedDishPlace>;
}

export interface AdminServiceApi {
  readonly createDish: (
    actor: string,
    input: CreateDishInput,
  ) => Effect.Effect<{ readonly id: string; readonly slug: string }, AdminServiceError, Database>;
  readonly updateDish: (
    actor: string,
    id: string,
    input: UpdateDishInput,
  ) => Effect.Effect<{ readonly id: string; readonly slug: string }, AdminServiceError, Database>;
  readonly updateDishStatus: (
    actor: string,
    id: string,
    status: DishStatus,
  ) => Effect.Effect<
    { readonly id: string; readonly status: DishStatus },
    AdminServiceError,
    Database
  >;
  readonly addDishName: (
    actor: string,
    dishId: string,
    input: CreateDishNameInput,
  ) => Effect.Effect<{ readonly name: string }, AdminServiceError, Database>;
  readonly upsertDishDescription: (
    actor: string,
    dishId: string,
    languageTag: string,
    description: string,
    summary: string | null,
  ) => Effect.Effect<void, AdminServiceError, Database>;
  readonly linkDishIngredient: (
    actor: string,
    dishId: string,
    ingredientId: string,
    role: string,
  ) => Effect.Effect<void, AdminServiceError, Database>;
  readonly linkDishPlace: (
    actor: string,
    dishId: string,
    placeId: string,
    association: string,
    isDisputed: boolean,
  ) => Effect.Effect<void, AdminServiceError, Database>;
  readonly linkDishCategory: (
    actor: string,
    dishId: string,
    categorySlug: string,
  ) => Effect.Effect<void, AdminServiceError, Database>;
  readonly linkDishCuisine: (
    actor: string,
    dishId: string,
    cuisineSlug: string,
  ) => Effect.Effect<void, AdminServiceError, Database>;
  readonly updateDishFields: (
    actor: string,
    id: string,
    input: UpdateDishFieldsInput,
  ) => Effect.Effect<UpdateDishFieldsResult, AdminServiceError, Database>;
  readonly updateDishNames: (
    actor: string,
    dishId: string,
    input: UpdateDishNamesInput,
  ) => Effect.Effect<UpdateDishNamesResult, AdminServiceError, Database>;
  readonly updateDishDescriptions: (
    actor: string,
    dishId: string,
    input: UpdateDishDescriptionsInput,
  ) => Effect.Effect<UpdateDishDescriptionsResult, AdminServiceError, Database>;
  readonly updateDishIngredients: (
    actor: string,
    dishId: string,
    input: UpdateDishIngredientsInput,
  ) => Effect.Effect<UpdateDishIngredientsResult, AdminServiceError, Database>;
  readonly updateDishTaxonomy: (
    actor: string,
    dishId: string,
    input: UpdateDishTaxonomyInput,
  ) => Effect.Effect<UpdateDishTaxonomyResult, AdminServiceError, Database>;
  readonly updateDishPlaces: (
    actor: string,
    dishId: string,
    input: UpdateDishPlacesInput,
  ) => Effect.Effect<UpdateDishPlacesResult, AdminServiceError, Database>;
  /**
   * LOCAL seam: implements the canonical `PlaceRef` resolution semantics
   * (see `DishPlaceRef`) directly on `PlaceRepository`. The coordinator
   * replaces this with delegation to `PlaceAdminService.resolvePlaceRef`
   * once layer wiring allows; behavior is identical by construction.
   */
  readonly resolvePlaceRefLocal: (
    ref: DishPlaceRef,
  ) => Effect.Effect<bigint, AdminServiceError, Database>;
}

export class AdminService extends Context.Service<AdminService, AdminServiceApi>()(
  "feastjourney/food-discovery/AdminService",
) {}

const checkDishId = (id: string): Effect.Effect<bigint, InvalidSearchFilter> =>
  isDbIdString(id)
    ? Effect.succeed(BigInt(id))
    : Effect.fail(new InvalidSearchFilter({ reason: "dish id must be a decimal id string" }));

const isDishStatus = (status: string): status is DishStatus => STATUSES.has(status);

const checkStatus = (status: string): Effect.Effect<DishStatus, InvalidSearchFilter> =>
  isDishStatus(status)
    ? Effect.succeed(status)
    : Effect.fail(new InvalidSearchFilter({ reason: "unknown dish status" }));

const checkNameKind = (kind: string): Effect.Effect<string, InvalidSearchFilter> =>
  NAME_KINDS.has(kind)
    ? Effect.succeed(kind)
    : Effect.fail(new InvalidSearchFilter({ reason: "unknown name kind" }));

const checkSlug = (slug: string): Effect.Effect<string, InvalidDishData> =>
  isSlug(slug) && slug.length <= 120
    ? Effect.succeed(slug)
    : Effect.fail(new InvalidDishData({ reason: `invalid slug "${slug}"` }));

const checkDecimalId = (value: string, what: string): Effect.Effect<bigint, InvalidSearchFilter> =>
  isDbIdString(value)
    ? Effect.succeed(BigInt(value))
    : Effect.fail(new InvalidSearchFilter({ reason: `${what} must be a decimal id string` }));

const checkAssociation = (association: string): Effect.Effect<string, InvalidSearchFilter> =>
  ASSOCIATIONS.has(association)
    ? Effect.succeed(association)
    : Effect.fail(new InvalidSearchFilter({ reason: "unknown place association" }));

const checkRole = (role: string): Effect.Effect<string, InvalidSearchFilter> =>
  ROLES.has(role)
    ? Effect.succeed(role)
    : Effect.fail(new InvalidSearchFilter({ reason: "unknown ingredient role" }));

const prepareNameEntry = (entry: {
  readonly languageTag: string;
  readonly name: string;
  readonly nameKind: string;
}) =>
  Effect.gen(function* () {
    if (!isLanguageTag(entry.languageTag)) {
      return yield* new InvalidLocale({ locale: entry.languageTag });
    }

    yield* checkNameKind(entry.nameKind);

    const trimmed = entry.name.trim();

    if (trimmed.length === 0 || trimmed.length > 300) {
      return yield* new InvalidSearchFilter({ reason: "name must be 1-300 characters" });
    }

    const key = normalizeSearchKey(trimmed);

    if (key.length === 0) {
      return yield* new InvalidSearchFilter({ reason: "name has no searchable text" });
    }

    return {
      languageTag: entry.languageTag,
      name: trimmed,
      nameKind: entry.nameKind,
      searchKey: key,
    };
  });

const checkDescriptionFields = (entry: {
  readonly description: string;
  readonly summary: string | null;
}) =>
  Effect.gen(function* () {
    if (entry.description.trim().length === 0 || entry.description.length > 20000) {
      return yield* new InvalidSearchFilter({
        reason: "description must be 1-20000 characters",
      });
    }

    if (
      entry.summary !== null &&
      (entry.summary.trim().length === 0 || entry.summary.length > 1000)
    ) {
      return yield* new InvalidSearchFilter({
        reason: "summary must be 1-1000 characters",
      });
    }

    return yield* Effect.void;
  });

const preparedNames = (names: ReadonlyArray<CreateDishNameInput>) =>
  Effect.gen(function* () {
    if (names.length === 0) {
      return yield* new InvalidSearchFilter({ reason: "at least one name is required" });
    }

    const prepared: Array<{
      readonly languageTag: string;
      readonly name: string;
      readonly nameKind: string;
      readonly searchKey: string;
    }> = [];

    const seen = new Set<string>();

    for (const entry of names) {
      if (!isLanguageTag(entry.languageTag)) {
        return yield* new InvalidLocale({ locale: entry.languageTag });
      }

      yield* checkNameKind(entry.nameKind);

      const trimmed = entry.name.trim();

      if (trimmed.length === 0 || trimmed.length > 300) {
        return yield* new InvalidSearchFilter({ reason: "name must be 1-300 characters" });
      }

      const key = normalizeSearchKey(trimmed);

      if (key.length === 0) {
        return yield* new InvalidSearchFilter({ reason: "name has no searchable text" });
      }

      const dedupe = `${entry.languageTag} ${trimmed}`;

      if (seen.has(dedupe)) {
        return yield* new InvalidSearchFilter({ reason: "duplicate name in request" });
      }

      seen.add(dedupe);
      prepared.push({
        languageTag: entry.languageTag,
        name: trimmed,
        nameKind: entry.nameKind,
        searchKey: key,
      });
    }

    return prepared;
  });

const dedupeSlugs = (slugs: ReadonlyArray<string>, what: string) =>
  Effect.gen(function* () {
    const cleaned: Array<string> = [];

    for (const slug of slugs) {
      const trimmed = slug.trim();

      if (trimmed.length > 0) {
        cleaned.push(trimmed);
      }
    }

    if (cleaned.length !== slugs.length) {
      return yield* new InvalidSearchFilter({ reason: `${what} slugs must not be blank` });
    }

    if (new Set(cleaned).size !== cleaned.length) {
      return yield* new InvalidDishData({ reason: `duplicate ${what} slug in request` });
    }

    return cleaned;
  });

export const AdminServiceLive = Layer.effect(
  AdminService,
  Effect.gen(function* () {
    const dishes = yield* DishRepository;
    const relations = yield* DishRelationsRepository;
    const ingredientRepository = yield* IngredientRepository;
    const placeRepository = yield* PlaceRepository;
    const taxonomy = yield* TaxonomyRepository;
    const curation = yield* CurationService;

    const requireDish = (id: bigint) =>
      Effect.gen(function* () {
        const record = yield* dishes.findById(id);

        if (record === null) {
          return yield* new DishNotFound({ dishId: id.toString() });
        }

        return record;
      });

    const uniqueSlug = (base: string, ignoreId?: bigint) =>
      Effect.gen(function* () {
        const taken = yield* dishes.findBySlug(base);

        if (taken === null || (ignoreId !== undefined && taken.id === ignoreId)) {
          return base;
        }

        for (let attempt = 2; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
          const candidate = `${base}-${attempt}`;
          const clash = yield* dishes.findBySlug(candidate);

          if (clash === null || (ignoreId !== undefined && clash.id === ignoreId)) {
            return candidate;
          }
        }

        return yield* new ConflictingDish({
          reason: `could not allocate a unique slug for "${base}"`,
        });
      });

    const resolveParent = (parentSlug: string | undefined) =>
      Effect.gen(function* () {
        if (parentSlug === undefined) {
          return null;
        }

        const checked = yield* checkSlug(parentSlug);
        const parent = yield* dishes.findBySlug(checked);

        if (parent === null) {
          return yield* new InvalidSearchFilter({
            reason: `unknown parent slug "${parentSlug}"`,
          });
        }

        return parent.id;
      });

    // Rejects any parent assignment that would place the dish inside its own
    // ancestor chain (two-node and longer cycles, not just self-parenting).
    // A null childId covers freshly created dishes, which cannot appear in an
    // existing chain yet; the walk then only enforces the depth bound.
    const assertNoParentCycle = (childId: bigint | null, parentDishId: bigint | null) =>
      Effect.gen(function* () {
        let current = parentDishId;

        for (let depth = 0; depth <= MAX_PARENT_CHAIN_DEPTH; depth += 1) {
          if (current === null) {
            return;
          }

          if (childId !== null && current === childId) {
            yield* new InvalidRelationship({
              reason: "dish parent assignment would create a cycle",
            });

            return;
          }

          if (depth === MAX_PARENT_CHAIN_DEPTH) {
            yield* new InvalidRelationship({
              reason: `dish parent chain exceeds maximum depth of ${MAX_PARENT_CHAIN_DEPTH}`,
            });

            return;
          }

          const ancestor = yield* dishes.findById(current);

          if (ancestor === null) {
            return;
          }

          current = ancestor.parentDishId;
        }
      });

    const createDish = (actor: string, input: CreateDishInput) =>
      Effect.gen(function* () {
        const status = yield* checkStatus(input.status ?? "draft");
        const names = yield* preparedNames(input.names);
        const parentDishId = yield* resolveParent(input.parentSlug);
        yield* assertNoParentCycle(null, parentDishId);

        const baseSlug =
          input.slug !== undefined
            ? yield* checkSlug(input.slug)
            : slugifyName(names[0]?.name ?? "dish");

        const created = yield* withTransaction(
          "admin/create-dish",
          Effect.gen(function* () {
            const slug = yield* uniqueSlug(baseSlug);
            const record = yield* dishes.insert({ slug, parentDishId, status });
            const preferredByLocale = new Map<string, boolean>();

            for (const entry of names) {
              const isPreferred = !preferredByLocale.has(entry.languageTag);
              preferredByLocale.set(entry.languageTag, true);

              yield* relations.insertName({
                dishId: record.id,
                languageTag: entry.languageTag,
                name: entry.name,
                nameKind: entry.nameKind,
                isPreferred,
                searchKey: entry.searchKey,
              });
            }

            yield* curation.recordRevision(
              record.id,
              actor,
              "created",
              `created dish ${record.slug}`,
            );

            return record;
          }),
        ).pipe(
          Effect.catchTag("PersistenceConflict", (failure) =>
            Effect.fail(
              new ConflictingDish({
                reason: `slug conflict (${failure.constraint ?? "unique constraint"})`,
              }),
            ),
          ),
        );

        return { id: encodeDbId(created.id), slug: created.slug };
      });

    const updateDish = (actor: string, id: string, input: UpdateDishInput) =>
      Effect.gen(function* () {
        const dishId = yield* checkDishId(id);
        const record = yield* requireDish(dishId);
        const slug = input.slug !== undefined ? yield* checkSlug(input.slug) : record.slug;

        const status =
          input.status !== undefined ? yield* checkStatus(input.status) : record.status;

        const parentDishId =
          input.parentSlug !== undefined
            ? yield* resolveParent(input.parentSlug)
            : record.parentDishId;

        if (parentDishId !== null && parentDishId === record.id) {
          return yield* new InvalidDishData({ reason: "a dish cannot be its own parent" });
        }

        if (input.parentSlug !== undefined) {
          yield* assertNoParentCycle(record.id, parentDishId);
        }

        if (status === "published" && record.status !== "published") {
          const check = yield* curation.validatePublication(record.id);

          if (!check.publishable) {
            return yield* new InvalidDishData({
              reason: `publication blocked: ${check.reasons.join("; ")}`,
            });
          }
        }

        const updated = yield* withTransaction(
          "admin/update-dish",
          Effect.gen(function* () {
            const result = yield* dishes.update({
              id: record.id,
              slug,
              parentDishId,
              status,
            });

            if (result === null) {
              return yield* new DishNotFound({ dishId: id });
            }

            if (status !== record.status) {
              yield* curation.recordRevision(
                record.id,
                actor,
                "status_changed",
                `status ${record.status} -> ${status}`,
              );
            }

            return result;
          }),
        ).pipe(
          Effect.catchTag("PersistenceConflict", (failure) =>
            Effect.fail(
              new ConflictingDish({
                reason: `slug conflict (${failure.constraint ?? "unique constraint"})`,
              }),
            ),
          ),
        );

        return { id: encodeDbId(updated.id), slug: updated.slug };
      });

    const updateDishStatus = (actor: string, id: string, status: DishStatus) =>
      Effect.gen(function* () {
        const updated = yield* updateDish(actor, id, { status });

        return { id: updated.id, status };
      });

    const addDishName = (actor: string, dishId: string, input: CreateDishNameInput) =>
      Effect.gen(function* () {
        const id = yield* checkDishId(dishId);
        yield* requireDish(id);

        if (!isLanguageTag(input.languageTag)) {
          return yield* new InvalidLocale({ locale: input.languageTag });
        }

        yield* checkNameKind(input.nameKind);

        const trimmed = input.name.trim();

        if (trimmed.length === 0 || trimmed.length > 300) {
          return yield* new InvalidSearchFilter({ reason: "name must be 1-300 characters" });
        }

        const key = normalizeSearchKey(trimmed);

        if (key.length === 0) {
          return yield* new InvalidSearchFilter({ reason: "name has no searchable text" });
        }

        const created = yield* withTransaction(
          "admin/add-dish-name",
          Effect.gen(function* () {
            const existing = yield* relations.namesByDishIds([id]);

            const preferredExists = existing.some(
              (entry) => entry.language_tag === input.languageTag && entry.is_preferred,
            );

            const row = yield* relations.insertName({
              dishId: id,
              languageTag: input.languageTag,
              name: trimmed,
              nameKind: input.nameKind,
              isPreferred: !preferredExists,
              searchKey: key,
            });

            yield* curation.recordRevision(
              id,
              actor,
              "name_added",
              `added ${input.languageTag} name "${trimmed}"`,
            );

            return row;
          }),
        ).pipe(
          Effect.catchTag("PersistenceConflict", (failure) =>
            Effect.fail(
              new ConflictingDish({
                reason: `name conflict (${failure.constraint ?? "unique constraint"})`,
              }),
            ),
          ),
        );

        return { name: created.name };
      });

    const upsertDishDescription = (
      actor: string,
      dishId: string,
      languageTag: string,
      description: string,
      summary: string | null,
    ) =>
      Effect.gen(function* () {
        const id = yield* checkDishId(dishId);
        yield* requireDish(id);

        if (!isLanguageTag(languageTag)) {
          return yield* new InvalidLocale({ locale: languageTag });
        }

        if (description.trim().length === 0 || description.length > 20000) {
          return yield* new InvalidSearchFilter({
            reason: "description must be 1-20000 characters",
          });
        }

        if (summary !== null && (summary.trim().length === 0 || summary.length > 1000)) {
          return yield* new InvalidSearchFilter({
            reason: "summary must be 1-1000 characters",
          });
        }

        return yield* withTransaction(
          "admin/upsert-description",
          Effect.gen(function* () {
            yield* relations.upsertDescription({ dishId: id, languageTag, description, summary });
            yield* curation.recordRevision(
              id,
              actor,
              "description_updated",
              `updated ${languageTag} description`,
            );
          }),
        );
      });

    const linkDishIngredient = (
      actor: string,
      dishId: string,
      ingredientId: string,
      role: string,
    ) =>
      Effect.gen(function* () {
        const id = yield* checkDishId(dishId);
        yield* requireDish(id);

        if (!isDbIdString(ingredientId)) {
          return yield* new InvalidSearchFilter({ reason: "ingredient id must be decimal" });
        }

        if (!ROLES.has(role)) {
          return yield* new InvalidSearchFilter({ reason: "unknown ingredient role" });
        }

        const ingredient = yield* ingredientRepository.findById(BigInt(ingredientId));

        if (ingredient === null) {
          return yield* new InvalidSearchFilter({ reason: "unknown ingredient id" });
        }

        return yield* withTransaction(
          "admin/link-ingredient",
          Effect.gen(function* () {
            yield* relations.linkIngredient(id, ingredient.id, role);
            yield* curation.recordRevision(
              id,
              actor,
              "ingredient_linked",
              `linked ingredient ${ingredient.id.toString()} (${role})`,
            );
          }),
        );
      });

    const linkDishPlace = (
      actor: string,
      dishId: string,
      placeId: string,
      association: string,
      isDisputed: boolean,
    ) =>
      Effect.gen(function* () {
        const id = yield* checkDishId(dishId);
        yield* requireDish(id);

        if (!isDbIdString(placeId)) {
          return yield* new InvalidSearchFilter({ reason: "place id must be decimal" });
        }

        if (!ASSOCIATIONS.has(association)) {
          return yield* new InvalidSearchFilter({ reason: "unknown place association" });
        }

        const place = yield* placeRepository.findById(BigInt(placeId));

        if (place === null) {
          return yield* new InvalidSearchFilter({ reason: "unknown place id" });
        }

        return yield* withTransaction(
          "admin/link-place",
          Effect.gen(function* () {
            yield* relations.linkPlace({
              dishId: id,
              placeId: place.id,
              association,
              isDisputed,
              note: null,
            });
            yield* curation.recordRevision(
              id,
              actor,
              "place_linked",
              `linked place ${place.id.toString()} (${association})`,
            );
          }),
        );
      });

    const linkDishCategory = (actor: string, dishId: string, categorySlug: string) =>
      Effect.gen(function* () {
        const id = yield* checkDishId(dishId);
        yield* requireDish(id);
        const rows = yield* taxonomy.categoriesBySlugs([categorySlug]);
        const category = rows[0];

        if (category === undefined) {
          return yield* new InvalidSearchFilter({ reason: "unknown category slug" });
        }

        return yield* withTransaction(
          "admin/link-category",
          Effect.gen(function* () {
            yield* relations.linkCategory(id, category.id);
            yield* curation.recordRevision(
              id,
              actor,
              "category_linked",
              `linked category ${category.slug}`,
            );
          }),
        );
      });

    const linkDishCuisine = (actor: string, dishId: string, cuisineSlug: string) =>
      Effect.gen(function* () {
        const id = yield* checkDishId(dishId);
        yield* requireDish(id);
        const cuisine = yield* taxonomy.cuisineBySlug(cuisineSlug);

        if (cuisine === null) {
          return yield* new InvalidSearchFilter({ reason: "unknown cuisine slug" });
        }

        return yield* withTransaction(
          "admin/link-cuisine",
          Effect.gen(function* () {
            yield* relations.linkCuisine(id, cuisine.id);
            yield* curation.recordRevision(
              id,
              actor,
              "cuisine_linked",
              `linked cuisine ${cuisine.slug}`,
            );
          }),
        );
      });

    const resolvePlaceRefLocal = (ref: DishPlaceRef) =>
      Effect.gen(function* () {
        // Local implementation of the canonical `PlaceRef` semantics from
        // `PlaceAdminService.resolvePlaceRef`: registry id, ISO code, or
        // city display name with preferred-first exact matching, optional
        // parent-ISO scoping, and ambiguity rejection. Reads only, so no
        // `CurrentActor`/authorization requirement beyond the caller's
        // `food:update` transport check.
        if ("placeId" in ref) {
          const id = yield* checkDecimalId(ref.placeId, "place id");
          const place = yield* placeRepository.findById(id);

          if (place === null) {
            return yield* new UnknownPlace({ reason: "unknown place id" });
          }

          return place.id;
        }

        if ("iso" in ref) {
          const iso = ref.iso.trim().toUpperCase();

          if (!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(iso)) {
            return yield* new InvalidSearchFilter({ reason: `invalid place iso "${ref.iso}"` });
          }

          const place = yield* placeRepository.findByIso(iso);

          if (place === null) {
            return yield* new UnknownPlace({ reason: `unknown place iso "${iso}"` });
          }

          return place.id;
        }

        const key = normalizeSearchKey(ref.city);

        if (key.length === 0) {
          return yield* new InvalidSearchFilter({ reason: "city name has no searchable text" });
        }

        const scope = ref.parentIso === undefined ? null : ref.parentIso.trim().toUpperCase();

        if (scope !== null && !/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(scope)) {
          return yield* new InvalidSearchFilter({
            reason: `invalid parent iso "${ref.parentIso ?? ""}"`,
          });
        }

        const query = scope === null ? ref.city : `${ref.city} in ${scope}`;

        const ids = yield* placeRepository.searchIds({
          q: key,
          prefix: toPrefixKey(key),
          contains: toContainsKey(key),
          limit: 25,
        });

        if (ids.length === 0) {
          return yield* new UnknownPlace({ reason: `unknown place "${query}"` });
        }

        const allNames = yield* placeRepository.namesByPlaceIds(ids.map((entry) => entry.id));
        const exact = allNames.filter((row) => row.search_key === key);

        if (exact.length === 0) {
          return yield* new UnknownPlace({ reason: `unknown place "${query}"` });
        }

        const preferred = exact.filter((row) => row.is_preferred);
        const tier = preferred.length > 0 ? preferred : exact;

        const candidateIds = [...new Set(tier.map((row) => row.place_id.toString()))].map((raw) =>
          BigInt(raw),
        );

        let scoped = candidateIds;

        if (scope !== null) {
          scoped = [];

          for (const candidate of candidateIds) {
            const chain = yield* placeRepository.ancestors(candidate);

            if (chain.some((row) => (row.iso3166 ?? "").toUpperCase() === scope)) {
              scoped.push(candidate);
            }
          }

          if (scoped.length === 0) {
            return yield* new UnknownPlace({ reason: `unknown place "${query}"` });
          }
        }

        if (scoped.length === 1) {
          const only = scoped[0];

          if (only === undefined) {
            return yield* new UnknownPlace({ reason: `unknown place "${query}"` });
          }

          return only;
        }

        const poolNames = yield* placeRepository.namesByPlaceIds(scoped);
        const preferredByPlace = new Map<string, string>();

        for (const row of poolNames) {
          if (row.is_preferred && !preferredByPlace.has(row.place_id.toString())) {
            preferredByPlace.set(row.place_id.toString(), row.name);
          }
        }

        const candidates: Array<AmbiguousPlaceCandidate> = [];

        for (const candidate of scoped) {
          const placeKey = candidate.toString();
          const name = preferredByPlace.get(placeKey) ?? placeKey;
          const chain = yield* placeRepository.ancestors(candidate);
          const scopeRow = chain.find((row) => row.iso3166 !== null);
          const scopeIso = scopeRow?.iso3166 ?? null;

          candidates.push({
            id: encodeDbId(candidate),
            name,
            context: scopeIso === null ? `${name} (place:${placeKey})` : `${name}, ${scopeIso}`,
          });
        }

        return yield* new AmbiguousPlace({ query, candidates });
      });

    const updateDishFields = (actor: string, id: string, input: UpdateDishFieldsInput) =>
      Effect.gen(function* () {
        const dishId = yield* checkDishId(id);
        const record = yield* requireDish(dishId);
        const slug = input.slug !== undefined ? yield* checkSlug(input.slug) : record.slug;

        const status =
          input.status !== undefined ? yield* checkStatus(input.status) : record.status;

        let parentDishId: bigint | null = record.parentDishId;

        if (input.parentSlug !== undefined) {
          parentDishId = input.parentSlug === null ? null : yield* resolveParent(input.parentSlug);
        }

        if (parentDishId !== null && parentDishId === record.id) {
          return yield* new InvalidDishData({ reason: "a dish cannot be its own parent" });
        }

        if (input.parentSlug !== undefined) {
          yield* assertNoParentCycle(record.id, parentDishId);
        }

        if (status === "published" && record.status !== "published") {
          const check = yield* curation.validatePublication(record.id);

          if (!check.publishable) {
            return yield* new InvalidDishData({
              reason: `publication blocked: ${check.reasons.join("; ")}`,
            });
          }
        }

        const changes: Array<string> = [];

        if (slug !== record.slug) {
          changes.push(`slug ${record.slug} -> ${slug}`);
        }

        if (parentDishId !== record.parentDishId) {
          changes.push(
            `parent ${record.parentDishId?.toString() ?? "none"} -> ${parentDishId?.toString() ?? "none"}`,
          );
        }

        if (status !== record.status) {
          changes.push(`status ${record.status} -> ${status}`);
        }

        const summary =
          changes.length > 0
            ? `updated dish fields: ${changes.join("; ")}`
            : "dish fields unchanged";

        const updated = yield* withTransaction(
          "admin/update-dish-fields",
          Effect.gen(function* () {
            const result = yield* dishes.update({
              id: record.id,
              slug,
              parentDishId,
              status,
            });

            if (result === null) {
              return yield* new DishNotFound({ dishId: id });
            }

            // Seam: the revision vocabulary has no field-edit operation yet;
            // the coordinator adds one. Until then the change lands under
            // `status_changed` with an exact summary of what changed.
            yield* curation.recordRevision(record.id, actor, "status_changed", summary);

            return result;
          }),
        ).pipe(
          Effect.catchTag("PersistenceConflict", (failure) =>
            Effect.fail(
              new ConflictingDish({
                reason: `slug conflict (${failure.constraint ?? "unique constraint"})`,
              }),
            ),
          ),
        );

        return {
          id: encodeDbId(updated.id),
          slug: updated.slug,
          parentDishId: updated.parentDishId?.toString() ?? null,
          status,
        };
      });

    const updateDishNames = (actor: string, dishId: string, input: UpdateDishNamesInput) =>
      Effect.gen(function* () {
        const id = yield* checkDishId(dishId);
        const record = yield* requireDish(id);

        const removeIds: Array<bigint> = [];

        for (const raw of input.removeIds) {
          removeIds.push(yield* checkDecimalId(raw, "name id"));
        }

        if (new Set(removeIds.map((value) => value.toString())).size !== removeIds.length) {
          return yield* new InvalidDishData({ reason: "duplicate name id in removeIds" });
        }

        const prepared: Array<{
          readonly nameId: bigint | null;
          readonly languageTag: string;
          readonly name: string;
          readonly nameKind: string;
          readonly searchKey: string;
          readonly isPreferred: boolean | undefined;
        }> = [];

        const seenIds = new Set<string>();
        const seenNew = new Set<string>();

        for (const entry of input.upsert) {
          const nameId = entry.id !== undefined ? yield* checkDecimalId(entry.id, "name id") : null;

          if (nameId !== null) {
            const key = nameId.toString();

            if (seenIds.has(key) || removeIds.some((candidate) => candidate === nameId)) {
              return yield* new InvalidDishData({ reason: "duplicate name id in request" });
            }

            seenIds.add(key);
          } else {
            const dedupe = `${entry.languageTag} ${entry.name.trim()}`;

            if (seenNew.has(dedupe)) {
              return yield* new InvalidDishData({ reason: "duplicate name in request" });
            }

            seenNew.add(dedupe);
          }

          const validated = yield* prepareNameEntry(entry);

          prepared.push({ nameId, ...validated, isPreferred: entry.isPreferred });
        }

        const explicitCount = new Map<string, number>();

        for (const entry of prepared) {
          if (entry.isPreferred === true) {
            explicitCount.set(entry.languageTag, (explicitCount.get(entry.languageTag) ?? 0) + 1);
          }
        }

        for (const [languageTag, count] of explicitCount) {
          if (count > 1) {
            return yield* new InvalidDishData({
              reason: `language "${languageTag}" marks more than one preferred name`,
            });
          }
        }

        return yield* withTransaction(
          "admin/update-dish-names",
          Effect.gen(function* () {
            const current = yield* relations.adminNamesByDishIds([id]);
            const byId = new Map(current.map((row) => [row.id.toString(), row] as const));

            for (const nameId of removeIds) {
              if (!byId.has(nameId.toString())) {
                return yield* new InvalidDishData({
                  reason: `unknown dish name id "${nameId.toString()}"`,
                });
              }
            }

            for (const entry of prepared) {
              if (entry.nameId !== null) {
                const row = byId.get(entry.nameId.toString());

                if (row === undefined || row.dish_id !== id) {
                  return yield* new InvalidDishData({
                    reason: `unknown dish name id "${entry.nameId.toString()}"`,
                  });
                }
              }
            }

            const removedNames = new Set(removeIds.map((value) => value.toString()));
            const survivors = current.filter((row) => !removedNames.has(row.id.toString()));

            if (
              survivors.length === 0 &&
              prepared.filter((entry) => entry.nameId === null).length === 0
            ) {
              return yield* new InvalidDishData({ reason: "dish must keep at least one name" });
            }

            const upsertWinner = new Map<string, (typeof prepared)[number]>();

            for (const entry of prepared) {
              if (entry.isPreferred === true) {
                upsertWinner.set(entry.languageTag, entry);
              }
            }

            // R3: removing the preferred name of a language that keeps
            // siblings requires a replacement marked preferred in this request.
            for (const nameId of removeIds) {
              const row = byId.get(nameId.toString());

              if (row !== undefined && row.is_preferred) {
                const siblings = survivors.filter(
                  (candidate) => candidate.language_tag === row.language_tag,
                );

                if (siblings.length > 0 && upsertWinner.get(row.language_tag) === undefined) {
                  return yield* new InvalidDishData({
                    reason: `cannot remove the preferred "${row.language_tag}" name while siblings remain; mark a replacement preferred in the same request`,
                  });
                }
              }
            }

            // R2: demoting a preferred row requires a same-language
            // replacement marked preferred in this request.
            for (const entry of prepared) {
              if (entry.isPreferred === false && entry.nameId !== null) {
                const row = byId.get(entry.nameId.toString());

                if (row !== undefined && row.is_preferred) {
                  const replacement = upsertWinner.get(entry.languageTag);

                  if (replacement === undefined || replacement === entry) {
                    return yield* new InvalidDishData({
                      reason: `language "${entry.languageTag}" would lose its preferred name; mark a replacement preferred in the same request`,
                    });
                  }
                }
              }
            }

            // Every surviving language needs a preferred winner: an explicit
            // request mark, the untouched stored preferred, or — for a brand
            // new language with a single insert — that insert.
            const finalLanguages = new Set<string>();

            for (const row of survivors) {
              finalLanguages.add(row.language_tag);
            }

            for (const entry of prepared) {
              finalLanguages.add(entry.languageTag);
            }

            const storedPreferred = new Map<string, bigint>();

            for (const row of survivors) {
              if (row.is_preferred && !storedPreferred.has(row.language_tag)) {
                storedPreferred.set(row.language_tag, row.id);
              }
            }

            const newByLanguage = new Map<string, Array<(typeof prepared)[number]>>();

            for (const entry of prepared) {
              if (entry.nameId === null) {
                const list = newByLanguage.get(entry.languageTag) ?? [];

                list.push(entry);
                newByLanguage.set(entry.languageTag, list);
              }
            }

            for (const languageTag of finalLanguages) {
              if (upsertWinner.has(languageTag)) {
                continue;
              }

              const stored = storedPreferred.get(languageTag);

              const survivorsOfLang = survivors.filter((row) => row.language_tag === languageTag);

              if (stored !== undefined && survivorsOfLang.some((row) => row.id === stored)) {
                continue;
              }

              const inserts = newByLanguage.get(languageTag) ?? [];

              if (survivorsOfLang.length === 0 && inserts.length === 1) {
                for (const only of inserts) {
                  upsertWinner.set(languageTag, only);
                }

                continue;
              }

              if (survivorsOfLang.length === 0 && inserts.length > 1) {
                return yield* new InvalidDishData({
                  reason: `language "${languageTag}" adds several names; mark one preferred in the same request`,
                });
              }

              return yield* new InvalidDishData({
                reason: `language "${languageTag}" would lose its preferred name; mark a replacement preferred in the same request`,
              });
            }

            let upserted = 0;

            // Existing-row winners clear their language first so the partial
            // unique index never sees two preferred rows mid-transaction.
            const cleared = new Set<string>();

            for (const entry of upsertWinner.values()) {
              if (entry.nameId !== null && !cleared.has(entry.languageTag)) {
                cleared.add(entry.languageTag);
                yield* relations.clearPreferredNames(id, entry.languageTag, entry.nameId);
              }
            }

            for (const entry of prepared) {
              if (entry.nameId !== null) {
                const row = byId.get(entry.nameId.toString());

                if (row === undefined) {
                  return yield* new InvalidDishData({
                    reason: `unknown dish name id "${entry.nameId.toString()}"`,
                  });
                }

                const winner = upsertWinner.get(entry.languageTag);

                let isPreferred: boolean;

                if (winner === entry) {
                  isPreferred = true;
                } else if (winner !== undefined) {
                  isPreferred = false;
                } else {
                  isPreferred = entry.isPreferred ?? row.is_preferred;
                }

                yield* relations.updateName({
                  id: entry.nameId,
                  dishId: id,
                  languageTag: entry.languageTag,
                  name: entry.name,
                  nameKind: entry.nameKind,
                  isPreferred,
                  searchKey: entry.searchKey,
                });

                upserted += 1;
              }
            }

            for (const entry of prepared) {
              if (entry.nameId === null) {
                const winner = upsertWinner.get(entry.languageTag);

                if (winner === entry) {
                  const inserted = yield* relations.insertName({
                    dishId: id,
                    languageTag: entry.languageTag,
                    name: entry.name,
                    nameKind: entry.nameKind,
                    isPreferred: false,
                    searchKey: entry.searchKey,
                  });

                  const insertedId = inserted.id;

                  yield* relations.clearPreferredNames(id, entry.languageTag, insertedId);
                  yield* relations.updateName({
                    id: insertedId,
                    dishId: id,
                    languageTag: entry.languageTag,
                    name: entry.name,
                    nameKind: entry.nameKind,
                    isPreferred: true,
                    searchKey: entry.searchKey,
                  });
                } else {
                  yield* relations.insertName({
                    dishId: id,
                    languageTag: entry.languageTag,
                    name: entry.name,
                    nameKind: entry.nameKind,
                    isPreferred: entry.isPreferred ?? false,
                    searchKey: entry.searchKey,
                  });
                }

                upserted += 1;
              }
            }

            let removed = 0;

            for (const nameId of removeIds) {
              const deleted = yield* relations.deleteName(nameId, id);

              removed += deleted === null ? 0 : 1;
            }

            const finalNames = yield* relations.adminNamesByDishIds([id]);

            if (record.status === "published") {
              const englishPreferred = finalNames.some(
                (row) => row.language_tag === "en" && row.is_preferred,
              );

              if (!englishPreferred) {
                return yield* new InvalidDishData({
                  reason: "published dishes require a preferred English name",
                });
              }
            }

            yield* curation.recordRevision(
              id,
              actor,
              "name_added",
              `updated names: ${upserted} upserted, ${removed} removed`,
            );

            return {
              upserted,
              removed,
              names: finalNames.map((row) => ({
                id: encodeDbId(row.id),
                languageTag: row.language_tag,
                name: row.name,
                nameKind: row.name_kind,
                isPreferred: row.is_preferred,
              })),
            };
          }),
        ).pipe(
          Effect.catchTag("PersistenceConflict", (failure) =>
            Effect.fail(
              new ConflictingDish({
                reason: `name conflict (${failure.constraint ?? "unique constraint"})`,
              }),
            ),
          ),
        );
      });

    const updateDishDescriptions = (
      actor: string,
      dishId: string,
      input: UpdateDishDescriptionsInput,
    ) =>
      Effect.gen(function* () {
        const id = yield* checkDishId(dishId);
        const record = yield* requireDish(id);

        for (const languageTag of input.removeLanguageTags) {
          if (!isLanguageTag(languageTag)) {
            return yield* new InvalidLocale({ locale: languageTag });
          }
        }

        if (new Set(input.removeLanguageTags).size !== input.removeLanguageTags.length) {
          return yield* new InvalidDishData({
            reason: "duplicate language tag in removeLanguageTags",
          });
        }

        const prepared: Array<{
          readonly languageTag: string;
          readonly description: string;
          readonly summary: string | null;
        }> = [];

        const seen = new Set<string>();

        for (const entry of input.upsert) {
          if (!isLanguageTag(entry.languageTag)) {
            return yield* new InvalidLocale({ locale: entry.languageTag });
          }

          if (seen.has(entry.languageTag)) {
            return yield* new InvalidDishData({ reason: "duplicate language tag in request" });
          }

          seen.add(entry.languageTag);
          yield* checkDescriptionFields(entry);
          prepared.push({
            languageTag: entry.languageTag,
            description: entry.description,
            summary: entry.summary,
          });
        }

        return yield* withTransaction(
          "admin/update-dish-descriptions",
          Effect.gen(function* () {
            const current = yield* relations.descriptionsByDishIds([id]);
            const currentTags = new Set(current.map((row) => row.language_tag));

            for (const languageTag of input.removeLanguageTags) {
              if (
                !currentTags.has(languageTag) &&
                !prepared.some((entry) => entry.languageTag === languageTag)
              ) {
                return yield* new InvalidDishData({
                  reason: `unknown dish description language "${languageTag}"`,
                });
              }
            }

            let removed = 0;

            for (const languageTag of input.removeLanguageTags) {
              if (prepared.some((entry) => entry.languageTag === languageTag)) {
                continue;
              }

              const deleted = yield* relations.deleteDescription(id, languageTag);

              removed += deleted === null ? 0 : 1;
            }

            for (const entry of prepared) {
              yield* relations.upsertDescription({
                dishId: id,
                languageTag: entry.languageTag,
                description: entry.description,
                summary: entry.summary,
              });
            }

            const finalDescriptions = yield* relations.descriptionsByDishIds([id]);

            if (record.status === "published") {
              const hasDescription = finalDescriptions.some(
                (row) => row.description.trim().length > 0 || (row.summary ?? "").trim().length > 0,
              );

              if (!hasDescription) {
                return yield* new InvalidDishData({
                  reason: "published dishes require a description or summary",
                });
              }
            }

            yield* curation.recordRevision(
              id,
              actor,
              "description_updated",
              `updated descriptions: ${prepared.length} upserted, ${removed} removed`,
            );

            return {
              upserted: prepared.length,
              removed,
              descriptions: finalDescriptions.map((row) => ({
                languageTag: row.language_tag,
                description: row.description,
                summary: row.summary,
              })),
            };
          }),
        );
      });

    const updateDishIngredients = (
      actor: string,
      dishId: string,
      input: UpdateDishIngredientsInput,
    ) =>
      Effect.gen(function* () {
        const id = yield* checkDishId(dishId);
        yield* requireDish(id);

        const upsertIds: Array<bigint> = [];
        const preparedRoles = new Map<string, string>();

        for (const entry of input.upsert) {
          const ingredientId = yield* checkDecimalId(entry.ingredientId, "ingredient id");
          const role = yield* checkRole(entry.role);
          const key = ingredientId.toString();

          if (preparedRoles.has(key)) {
            return yield* new InvalidDishData({ reason: "duplicate ingredient in request" });
          }

          preparedRoles.set(key, role);
          upsertIds.push(ingredientId);
        }

        const removeIds: Array<bigint> = [];

        for (const raw of input.removeIngredientIds) {
          removeIds.push(yield* checkDecimalId(raw, "ingredient id"));
        }

        if (new Set(removeIds.map((value) => value.toString())).size !== removeIds.length) {
          return yield* new InvalidDishData({
            reason: "duplicate ingredient id in removeIngredientIds",
          });
        }

        for (const ingredientId of removeIds) {
          if (preparedRoles.has(ingredientId.toString())) {
            return yield* new InvalidDishData({ reason: "duplicate ingredient in request" });
          }
        }

        return yield* withTransaction(
          "admin/update-dish-ingredients",
          Effect.gen(function* () {
            const current = yield* relations.ingredientsByDishIds([id]);
            const linked = new Set(current.map((row) => row.ingredient_id.toString()));

            for (const ingredientId of removeIds) {
              if (!linked.has(ingredientId.toString())) {
                return yield* new InvalidDishData({
                  reason: `ingredient ${ingredientId.toString()} is not linked to this dish`,
                });
              }
            }

            for (const ingredientId of upsertIds) {
              const ingredient = yield* ingredientRepository.findById(ingredientId);

              if (ingredient === null) {
                return yield* new InvalidSearchFilter({ reason: "unknown ingredient id" });
              }
            }

            let removed = 0;

            for (const ingredientId of removeIds) {
              const deleted = yield* relations.deleteIngredient(id, ingredientId);

              removed += deleted === null ? 0 : 1;
            }

            let upserted = 0;

            for (const ingredientId of upsertIds) {
              const role = preparedRoles.get(ingredientId.toString()) ?? "common";
              const updated = yield* relations.updateIngredientRole(id, ingredientId, role);

              if (updated === null) {
                yield* relations.linkIngredient(id, ingredientId, role);
              }

              upserted += 1;
            }

            const finalIngredients = yield* relations.ingredientsByDishIds([id]);

            yield* curation.recordRevision(
              id,
              actor,
              "ingredient_linked",
              `updated ingredients: ${upserted} upserted, ${removed} removed`,
            );

            return {
              upserted,
              removed,
              ingredients: finalIngredients.map((row) => ({
                ingredientId: encodeDbId(row.ingredient_id),
                role: row.role,
              })),
            };
          }),
        );
      });

    const updateDishTaxonomy = (actor: string, dishId: string, input: UpdateDishTaxonomyInput) =>
      Effect.gen(function* () {
        const id = yield* checkDishId(dishId);
        const record = yield* requireDish(id);

        const cuisineUpsert = yield* dedupeSlugs(input.cuisineUpsert, "cuisine");
        const cuisineRemove = yield* dedupeSlugs(input.cuisineRemove, "cuisine");
        const categoryUpsert = yield* dedupeSlugs(input.categoryUpsert, "category");
        const categoryRemove = yield* dedupeSlugs(input.categoryRemove, "category");

        for (const slug of [...cuisineUpsert, ...cuisineRemove]) {
          if (!isSlug(slug)) {
            return yield* new InvalidSearchFilter({ reason: `invalid cuisine slug "${slug}"` });
          }
        }

        for (const slug of [...categoryUpsert, ...categoryRemove]) {
          if (!isSlug(slug)) {
            return yield* new InvalidSearchFilter({ reason: `invalid category slug "${slug}"` });
          }
        }

        const removeSlugs = new Set([...cuisineRemove, ...categoryRemove]);
        let overlap: string | null = null;

        for (const slug of [...cuisineUpsert, ...categoryUpsert]) {
          if (removeSlugs.has(slug)) {
            overlap = slug;
            break;
          }
        }

        if (overlap !== null) {
          return yield* new InvalidDishData({
            reason: `slug "${overlap}" appears in both upsert and remove`,
          });
        }

        return yield* withTransaction(
          "admin/update-dish-taxonomy",
          Effect.gen(function* () {
            let cuisinesLinked = 0;
            let cuisinesUnlinked = 0;
            let categoriesLinked = 0;
            let categoriesUnlinked = 0;

            for (const slug of cuisineUpsert) {
              const cuisine = yield* taxonomy.cuisineBySlug(slug);

              if (cuisine === null) {
                return yield* new InvalidSearchFilter({ reason: "unknown cuisine slug" });
              }

              yield* relations.linkCuisine(id, cuisine.id);
              cuisinesLinked += 1;
            }

            for (const slug of cuisineRemove) {
              const cuisine = yield* taxonomy.cuisineBySlug(slug);

              if (cuisine === null) {
                return yield* new InvalidSearchFilter({ reason: "unknown cuisine slug" });
              }

              const deleted = yield* relations.unlinkCuisine(id, cuisine.id);

              if (deleted === 0) {
                return yield* new InvalidDishData({
                  reason: `cuisine "${slug}" is not linked to this dish`,
                });
              }

              cuisinesUnlinked += 1;
            }

            if (categoryUpsert.length > 0 || categoryRemove.length > 0) {
              const wanted = [...new Set([...categoryUpsert, ...categoryRemove])];
              const rows = yield* taxonomy.categoriesBySlugs(wanted);
              const found = new Set(rows.map((row) => row.slug));

              for (const slug of wanted) {
                if (!found.has(slug)) {
                  return yield* new InvalidSearchFilter({ reason: "unknown category slug" });
                }
              }

              const bySlug = new Map(rows.map((row) => [row.slug, row.id] as const));

              for (const slug of categoryUpsert) {
                const categoryId = bySlug.get(slug);

                if (categoryId === undefined) {
                  return yield* new InvalidSearchFilter({ reason: "unknown category slug" });
                }

                yield* relations.linkCategory(id, categoryId);
                categoriesLinked += 1;
              }

              for (const slug of categoryRemove) {
                const categoryId = bySlug.get(slug);

                if (categoryId === undefined) {
                  return yield* new InvalidSearchFilter({ reason: "unknown category slug" });
                }

                const deleted = yield* relations.unlinkCategory(id, categoryId);

                if (deleted === 0) {
                  return yield* new InvalidDishData({
                    reason: `category "${slug}" is not linked to this dish`,
                  });
                }

                categoriesUnlinked += 1;
              }
            }

            const finalCuisines = yield* relations.cuisinesByDishIds([id]);
            const finalCategories = yield* relations.categoriesByDishIds([id]);

            if (record.status === "published" && finalCategories.length === 0) {
              return yield* new InvalidDishData({
                reason: "published dishes require at least one category",
              });
            }

            if (cuisinesLinked + cuisinesUnlinked > 0) {
              yield* curation.recordRevision(
                id,
                actor,
                "cuisine_linked",
                `updated cuisines: ${cuisinesLinked} linked, ${cuisinesUnlinked} unlinked`,
              );
            }

            if (categoriesLinked + categoriesUnlinked > 0) {
              yield* curation.recordRevision(
                id,
                actor,
                "category_linked",
                `updated categories: ${categoriesLinked} linked, ${categoriesUnlinked} unlinked`,
              );
            }

            return {
              cuisinesLinked,
              cuisinesUnlinked,
              categoriesLinked,
              categoriesUnlinked,
              cuisines: finalCuisines.map((row) => row.slug),
              categories: finalCategories.map((row) => row.slug),
            };
          }),
        );
      });

    const updateDishPlaces = (actor: string, dishId: string, input: UpdateDishPlacesInput) =>
      Effect.gen(function* () {
        const id = yield* checkDishId(dishId);
        yield* requireDish(id);

        const prepared: Array<{
          readonly placeId: bigint;
          readonly association: string;
          readonly isDisputed: boolean;
          readonly note: string | null;
        }> = [];

        const seenPlaces = new Set<string>();

        for (const entry of input.upsert) {
          const placeId = yield* resolvePlaceRefLocal(entry.place);
          const key = placeId.toString();

          if (seenPlaces.has(key)) {
            return yield* new InvalidDishData({ reason: "duplicate place in request" });
          }

          seenPlaces.add(key);

          const association =
            entry.association !== undefined
              ? yield* checkAssociation(entry.association)
              : "associated";

          if (entry.note !== undefined && entry.note !== null && entry.note.length > 2000) {
            return yield* new InvalidSearchFilter({
              reason: "place note must be at most 2000 characters",
            });
          }

          prepared.push({
            placeId,
            association,
            isDisputed: entry.isDisputed ?? false,
            note: entry.note ?? null,
          });
        }

        const removeIds: Array<bigint> = [];

        for (const raw of input.removePlaceIds) {
          removeIds.push(yield* checkDecimalId(raw, "place id"));
        }

        if (new Set(removeIds.map((value) => value.toString())).size !== removeIds.length) {
          return yield* new InvalidDishData({ reason: "duplicate place id in removePlaceIds" });
        }

        for (const placeId of removeIds) {
          if (seenPlaces.has(placeId.toString())) {
            return yield* new InvalidDishData({ reason: "duplicate place in request" });
          }
        }

        return yield* withTransaction(
          "admin/update-dish-places",
          Effect.gen(function* () {
            const current = yield* relations.placesByDishIds([id]);
            const linked = new Set(current.map((row) => row.place_id.toString()));

            for (const placeId of removeIds) {
              if (!linked.has(placeId.toString())) {
                return yield* new InvalidDishData({
                  reason: `place ${placeId.toString()} is not linked to this dish`,
                });
              }
            }

            let removed = 0;

            for (const placeId of removeIds) {
              removed += yield* relations.deletePlaceLink(id, placeId);
            }

            let upserted = 0;

            for (const entry of prepared) {
              // (dish_id, place_id) is the link key: an existing row updates
              // in place (association/disputed/note), a missing pair inserts.
              // Never deletes and recreates the dish; never duplicates.
              const updated = yield* relations.updatePlaceLink({
                dishId: id,
                placeId: entry.placeId,
                association: entry.association,
                isDisputed: entry.isDisputed,
                note: entry.note,
              });

              if (updated.length === 0) {
                yield* relations.linkPlace({
                  dishId: id,
                  placeId: entry.placeId,
                  association: entry.association,
                  isDisputed: entry.isDisputed,
                  note: entry.note,
                });
              }

              upserted += 1;
            }

            const finalPlaces = yield* relations.placesByDishIds([id]);

            yield* curation.recordRevision(
              id,
              actor,
              "place_linked",
              `updated places: ${upserted} upserted, ${removed} removed`,
            );

            return {
              upserted,
              removed,
              places: finalPlaces.map((row) => ({
                placeId: encodeDbId(row.place_id),
                association: row.association,
                isDisputed: row.is_disputed,
                note: row.note,
              })),
            };
          }),
        );
      });

    return AdminService.of({
      createDish,
      updateDish,
      updateDishStatus,
      addDishName,
      upsertDishDescription,
      linkDishIngredient,
      linkDishPlace,
      linkDishCategory,
      linkDishCuisine,
      updateDishFields,
      updateDishNames,
      updateDishDescriptions,
      updateDishIngredients,
      updateDishTaxonomy,
      updateDishPlaces,
      resolvePlaceRefLocal,
    });
  }),
);
