import * as AdminFns from "@/modules/food-discovery/admin.functions";

/**
 * Fixed client-side contracts for the dish-edit server functions.
 *
 * A parallel workstream owns the server side; the functions below are
 * resolved at runtime through `resolveDishEditFn` (never a static import of
 * a possibly-missing export), so this file — and every editor built on it —
 * compiles and renders even if a function is absent. Editors render no Edit
 * affordance while their function is missing; see `section-editor.tsx`.
 *
 * The edit functions have landed in `admin.functions.ts`; the runtime probe
 * stays as forward/backward compatibility (mixed-branch checkouts keep
 * rendering read-only instead of crashing).
 */

export const DISH_EDIT_FN_NAMES = [
  "adminUpdateDishFieldsFn",
  "adminUpdateDishNamesFn",
  "adminUpdateDishDescriptionsFn",
  "adminUpdateDishIngredientsFn",
  "adminUpdateDishTaxonomyFn",
  "adminUpdateDishPlacesFn",
] as const;

export type DishEditFnName = (typeof DISH_EDIT_FN_NAMES)[number];

export interface DishNameUpsert {
  readonly id?: string;
  readonly languageTag: string;
  readonly name: string;
  readonly nameKind: string;
  readonly isPreferred: boolean;
}

export interface DishUpdatePayload {
  readonly dishId: string;
  readonly slug?: string;
  readonly parentSlug?: string | null;
  readonly status?: string;
}

export interface DishUpdateNamesPayload {
  readonly dishId: string;
  readonly upsert: ReadonlyArray<DishNameUpsert>;
  readonly removeIds: ReadonlyArray<string>;
}

export interface DishDescriptionUpsert {
  readonly languageTag: string;
  readonly description: string;
  readonly summary: string | null;
}

export interface DishUpdateDescriptionsPayload {
  readonly dishId: string;
  readonly upsert: ReadonlyArray<DishDescriptionUpsert>;
  readonly removeLanguageTags: ReadonlyArray<string>;
}

export interface DishIngredientUpsert {
  readonly ingredientId: string;
  readonly role: string;
}

export interface DishUpdateIngredientsPayload {
  readonly dishId: string;
  readonly upsert: ReadonlyArray<DishIngredientUpsert>;
  readonly removeIngredientIds: ReadonlyArray<string>;
}

export interface DishUpdateTaxonomyPayload {
  readonly dishId: string;
  readonly cuisineUpsert: ReadonlyArray<string>;
  readonly cuisineRemove: ReadonlyArray<string>;
  readonly categoryUpsert: ReadonlyArray<string>;
  readonly categoryRemove: ReadonlyArray<string>;
}

export type DishPlaceRef =
  | { readonly placeId: string }
  | { readonly iso: string }
  | { readonly city: string; readonly parentIso: string };

export type DishPlaceAssociation = "origin" | "associated" | "popular";

export interface DishPlaceUpsert {
  readonly place: DishPlaceRef;
  readonly association?: DishPlaceAssociation;
  readonly disputed?: boolean;
  readonly note?: string | null;
}

export interface DishUpdatePlacesPayload {
  readonly dishId: string;
  readonly upsert: ReadonlyArray<DishPlaceUpsert>;
  readonly removePlaceIds: ReadonlyArray<string>;
}

export type DishEditPayload =
  | DishUpdatePayload
  | DishUpdateNamesPayload
  | DishUpdateDescriptionsPayload
  | DishUpdateIngredientsPayload
  | DishUpdateTaxonomyPayload
  | DishUpdatePlacesPayload;

type ServerFnCaller = (input: { readonly data: DishEditPayload }) => Promise<void>;

export const resolveDishEditFn = (name: DishEditFnName): ServerFnCaller | null => {
  // SAFETY: AdminFns is a static import of a committed module — the object
  // always exists; members are server functions or absent until the parallel
  // workstream lands. Indexing by the fixed name union cannot invent keys.
  // oxlint-disable-next-line anti-slop/no-unknown-returns, anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type, typescript/no-unsafe-type-assertion
  const table = AdminFns as unknown as Record<string, unknown>;
  const candidate = table[name];

  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof candidate !== "function") {
    return null;
  }

  // SAFETY: a function-typed member shares the server-function transport
  // shape `({ data }) => Promise<...>`; payloads are re-validated by zod on
  // the server boundary and callers only branch on success/failure.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return candidate as ServerFnCaller;
};

export const dishEditFnAvailable = (name: DishEditFnName): boolean =>
  resolveDishEditFn(name) !== null;

export class DishEditUnavailableError extends Error {
  readonly fnName: DishEditFnName;

  constructor(fnName: DishEditFnName) {
    super(`Dish edit function is not available yet: ${fnName}`);
    this.name = "DishEditUnavailableError";
    this.fnName = fnName;
  }
}

export const invokeDishEdit = async (
  name: DishEditFnName,
  data: DishEditPayload,
): Promise<void> => {
  const fn = resolveDishEditFn(name);

  if (fn === null) {
    throw new DishEditUnavailableError(name);
  }

  await fn({ data });
};
