/**
 * Admin taxonomy client contract (frontend workstream).
 *
 * TODO(contract): the six server functions below are owned by the backend
 * workstream on `feat/admin-taxonomy` (`@/modules/food-discovery/admin.functions.ts`).
 * That branch has not landed yet, so this file declares the exact
 * coordinator-approved shapes and exposes them through `TaxonomyClient`.
 * When the backend lands, delete `unimplementedTaxonomyClient` and pass the
 * real `*Fn` imports at the route boundary — the panel components already
 * speak only this interface, so no panel changes are needed.
 *
 * Coordinator-approved contract (consume exactly, do not redefine):
 * - `listCuisinesFn({data: {query?, limit, offset}}) -> {cuisines: [{id, slug, name}]}`
 * - `createCuisineFn({data: {slug?, name}}) -> {cuisine}`
 * - `bulkCreateCuisinesFn({data: {entries: [{slug?, name}]}}) -> {created, skipped, invalid}`
 * - `listIngredientsFn({data: {query?, limit, offset}}) -> {ingredients: [{id, name}]}`
 * - `createIngredientFn({data: {name, languageTag?}}) -> {ingredient}`
 * - `bulkCreateIngredientsFn({data: {entries: [{name, languageTag?}]}}) -> {created, skipped, invalid}`
 * where `skipped`/`invalid` are `[{entry, reason}]` rows.
 */

export interface CuisineEntry {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface IngredientEntry {
  readonly id: string;
  readonly name: string;
}

export interface CreateCuisineInput {
  readonly slug?: string;
  readonly name: string;
}

export interface CreateIngredientInput {
  readonly name: string;
  readonly languageTag?: string;
}

export interface BulkCuisineEntry {
  readonly slug?: string;
  readonly name: string;
}

export interface BulkIngredientEntry {
  readonly name: string;
  readonly languageTag?: string;
}

export interface BulkRow<Entry> {
  readonly entry: Entry;
  readonly reason: string;
}

export interface BulkCuisineResult {
  readonly created: number;
  readonly skipped: ReadonlyArray<BulkRow<BulkCuisineEntry>>;
  readonly invalid: ReadonlyArray<BulkRow<BulkCuisineEntry>>;
}

export interface BulkIngredientResult {
  readonly created: number;
  readonly skipped: ReadonlyArray<BulkRow<BulkIngredientEntry>>;
  readonly invalid: ReadonlyArray<BulkRow<BulkIngredientEntry>>;
}

/**
 * Narrow client surface the taxonomy panels depend on. Each method mirrors
 * one backend server function one-to-one: same input shape, same output
 * shape, promise rejection on failure. Panels never import server functions
 * directly so tests can inject fakes and the merge can swap the wiring.
 */
export interface TaxonomyClient {
  readonly listCuisines: (input: {
    readonly query?: string;
    readonly limit: number;
    readonly offset: number;
  }) => Promise<{ readonly cuisines: ReadonlyArray<CuisineEntry> }>;
  readonly createCuisine: (
    input: CreateCuisineInput,
  ) => Promise<{ readonly cuisine: CuisineEntry }>;
  readonly bulkCreateCuisines: (input: {
    readonly entries: ReadonlyArray<BulkCuisineEntry>;
  }) => Promise<BulkCuisineResult>;
  readonly listIngredients: (input: {
    readonly query?: string;
    readonly limit: number;
    readonly offset: number;
  }) => Promise<{ readonly ingredients: ReadonlyArray<IngredientEntry> }>;
  readonly createIngredient: (
    input: CreateIngredientInput,
  ) => Promise<{ readonly ingredient: IngredientEntry }>;
  readonly bulkCreateIngredients: (input: {
    readonly entries: ReadonlyArray<BulkIngredientEntry>;
  }) => Promise<BulkIngredientResult>;
}

const missingBackend = (fnName: string): never => {
  throw new Error(
    `TODO(contract): ${fnName} is not implemented yet — waiting on feat/admin-taxonomy.`,
  );
};

/** Placeholder wiring used until the backend workstream lands. Never ships silently: every call throws. */
export const unimplementedTaxonomyClient: TaxonomyClient = {
  listCuisines: () => Promise.reject(missingBackend("listCuisinesFn")),
  createCuisine: () => Promise.reject(missingBackend("createCuisineFn")),
  bulkCreateCuisines: () => Promise.reject(missingBackend("bulkCreateCuisinesFn")),
  listIngredients: () => Promise.reject(missingBackend("listIngredientsFn")),
  createIngredient: () => Promise.reject(missingBackend("createIngredientFn")),
  bulkCreateIngredients: () => Promise.reject(missingBackend("bulkCreateIngredientsFn")),
};

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Server slug rule mirror (`taxonomySlugSchema` in `admin.schema.ts`): lowercase alphanumeric runs joined by single hyphens. */
export const isValidSlug = (slug: string): boolean => SLUG_PATTERN.test(slug);

/**
 * Derive a URL slug from a display name the same way the server does when
 * `slug` is omitted: NFKD-normalize, drop diacritics, lowercase, map every
 * non-alphanumeric run to one hyphen, trim edge hyphens. Returns "" when
 * nothing usable remains (caller then omits `slug` and lets the server decide).
 */
export const deriveSlug = (name: string): string => {
  const ascii = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

  return ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

export type BulkLine =
  | { readonly kind: "empty" }
  | { readonly kind: "cuisine"; readonly entry: BulkCuisineEntry }
  | { readonly kind: "cuisine-invalid"; readonly raw: string; readonly reason: string }
  | { readonly kind: "ingredient"; readonly entry: BulkIngredientEntry }
  | { readonly kind: "ingredient-invalid"; readonly raw: string; readonly reason: string };

const splitBulkLine = (line: string): { readonly left: string; readonly right: string } | null => {
  const separator = line.indexOf("|");

  if (separator === -1) {
    return null;
  }

  return {
    left: line.slice(0, separator).trim(),
    right: line.slice(separator + 1).trim(),
  };
};

/**
 * Parse one bulk-add line for the cuisines tab.
 * Grammar: `Display Name` or `slug | Display Name`. An invalid slug is a
 * caller-visible `cuisine-invalid` row, never a silent drop.
 */
export const parseCuisineBulkLine = (line: string): BulkLine => {
  const trimmed = line.trim();

  if (trimmed === "") {
    return { kind: "empty" };
  }

  const parts = splitBulkLine(trimmed);

  if (parts === null) {
    return { kind: "cuisine", entry: { name: trimmed } };
  }

  if (parts.right === "") {
    return { kind: "cuisine-invalid", raw: trimmed, reason: "Missing display name after “|”." };
  }

  if (parts.left === "") {
    return { kind: "cuisine", entry: { name: parts.right } };
  }

  if (!isValidSlug(parts.left)) {
    return {
      kind: "cuisine-invalid",
      raw: trimmed,
      reason: `“${parts.left}” is not a valid slug (lowercase letters, digits, single hyphens).`,
    };
  }

  return { kind: "cuisine", entry: { slug: parts.left, name: parts.right } };
};

const LANGUAGE_TAG_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

/**
 * Parse one bulk-add line for the ingredients tab.
 * Grammar: `Display Name` or `languageTag | Display Name` (e.g. `vi | Rau muống`).
 */
export const parseIngredientBulkLine = (line: string): BulkLine => {
  const trimmed = line.trim();

  if (trimmed === "") {
    return { kind: "empty" };
  }

  const parts = splitBulkLine(trimmed);

  if (parts === null) {
    return { kind: "ingredient", entry: { name: trimmed } };
  }

  if (parts.right === "") {
    return { kind: "ingredient-invalid", raw: trimmed, reason: "Missing display name after “|”." };
  }

  if (parts.left === "") {
    return { kind: "ingredient", entry: { name: parts.right } };
  }

  if (!LANGUAGE_TAG_PATTERN.test(parts.left)) {
    return {
      kind: "ingredient-invalid",
      raw: trimmed,
      reason: `“${parts.left}” is not a valid language tag (e.g. en, vi).`,
    };
  }

  return { kind: "ingredient", entry: { languageTag: parts.left, name: parts.right } };
};

export type BulkRowStatus = "created" | "skipped" | "invalid";

export interface BulkRowDisplay {
  readonly key: string;
  readonly label: string;
  readonly status: BulkRowStatus;
  readonly reason: string | null;
}

/**
 * Resolve per-row bulk outcomes for display. The bulk endpoints report only
 * `skipped` and `invalid` rows with reasons plus a `created` count, so a
 * submitted row absent from both lists was created. Matching is by the
 * echoed entry's display name (cuisines fall back to slug when names collide
 * is impossible — names are unique per row key below).
 */
export const resolveCuisineRowStatuses = (
  entries: ReadonlyArray<BulkCuisineEntry>,
  result: BulkCuisineResult,
): ReadonlyArray<BulkRowDisplay> =>
  entries.map((entry, index) => {
    const skipped = result.skipped.find((row) => row.entry.name === entry.name);

    if (skipped !== undefined) {
      return {
        key: `${index}:${entry.slug ?? ""}:${entry.name}`,
        label: entry.slug === undefined ? entry.name : `${entry.slug} | ${entry.name}`,
        status: "skipped" as const,
        reason: skipped.reason,
      };
    }

    const invalid = result.invalid.find((row) => row.entry.name === entry.name);

    if (invalid !== undefined) {
      return {
        key: `${index}:${entry.slug ?? ""}:${entry.name}`,
        label: entry.slug === undefined ? entry.name : `${entry.slug} | ${entry.name}`,
        status: "invalid" as const,
        reason: invalid.reason,
      };
    }

    return {
      key: `${index}:${entry.slug ?? ""}:${entry.name}`,
      label: entry.slug === undefined ? entry.name : `${entry.slug} | ${entry.name}`,
      status: "created" as const,
      reason: null,
    };
  });

export const resolveIngredientRowStatuses = (
  entries: ReadonlyArray<BulkIngredientEntry>,
  result: BulkIngredientResult,
): ReadonlyArray<BulkRowDisplay> =>
  entries.map((entry, index) => {
    const label =
      entry.languageTag === undefined ? entry.name : `${entry.languageTag} | ${entry.name}`;

    const key = `${index}:${entry.languageTag ?? ""}:${entry.name}`;

    const invalid = result.invalid.find((row) => row.entry.name === entry.name);

    if (invalid !== undefined) {
      return { key, label, status: "invalid" as const, reason: invalid.reason };
    }

    const skipped = result.skipped.find((row) => row.entry.name === entry.name);

    if (skipped !== undefined) {
      return { key, label, status: "skipped" as const, reason: skipped.reason };
    }

    return { key, label, status: "created" as const, reason: null };
  });
