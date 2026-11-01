import { z } from "zod";

import * as PlaceFns from "@/modules/food-discovery/place.functions";
import type { PlaceKind } from "@/modules/food-discovery/place.schema";

/**
 * Client-side contracts for the Places backend (`place.functions.ts`).
 *
 * Availability is resolved at runtime through `placeFnAvailable`,
 * mirroring the dish-edit seam in `../dish/edit-contracts.ts`, so the UI
 * degrades to read-only honesty if a function is ever absent (mixed-branch
 * checkouts included). UI-side permission gating uses `food:update` for
 * mutations and `food:read` for reads; the server fns enforce both
 * independently.
 */

export type { PlaceKind };

export const PLACE_KINDS: ReadonlyArray<PlaceKind> = [
  "continent",
  "region",
  "country",
  "subnational",
  "province",
  "locality",
];

export const PLACE_FN_NAMES = [
  "adminPlacesListFn",
  "adminPlaceDetailFn",
  "adminCreatePlaceFn",
  "adminUpdatePlaceFn",
  "adminPlaceNamesFn",
  "adminPlaceParentFn",
] as const;

export type PlaceFnName = (typeof PLACE_FN_NAMES)[number];

export const placeFnAvailable = (name: PlaceFnName): boolean => {
  // SAFETY: static import of a committed module; indexing by the fixed name
  // union cannot invent keys. Only existence is reported — calls go through
  // the statically imported fns so payloads stay fully typed.
  // oxlint-disable-next-line anti-slop/no-unknown-returns, anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type, typescript/no-unsafe-type-assertion
  const table = PlaceFns as unknown as Record<string, unknown>;
  const candidate = table[name];

  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  return typeof candidate === "function";
};

export interface PlaceNameRow {
  readonly id: string;
  readonly languageTag: string;
  readonly name: string;
  readonly isPreferred: boolean;
}

export interface PlaceHierarchyEntry {
  readonly id: string;
  readonly displayName: string | null;
  readonly kind: string;
  readonly iso3166: string | null;
}

export interface PlaceDishCounts {
  readonly origin: number;
  readonly associated: number;
  readonly popular: number;
  readonly total: number;
}

export interface PlaceListItem {
  readonly id: string;
  readonly displayName: string | null;
  readonly kind: string;
  readonly iso3166: string | null;
  readonly displayLatitude: number | null;
  readonly displayLongitude: number | null;
  readonly displayNote: string | null;
}

export interface PlaceDetail {
  readonly id: string;
  readonly displayName: string | null;
  readonly kind: PlaceKind;
  readonly iso3166: string | null;
  readonly displayLatitude: number | null;
  readonly displayLongitude: number | null;
  readonly displayNote: string | null;
  readonly names: ReadonlyArray<PlaceNameRow>;
  /** Direct parents (nearest first). */
  readonly parents: ReadonlyArray<PlaceHierarchyEntry>;
  /** Full ancestor chain plus direct children for the hierarchy view. */
  readonly ancestors: ReadonlyArray<PlaceHierarchyEntry>;
  readonly children: ReadonlyArray<PlaceHierarchyEntry>;
  readonly dishCounts: PlaceDishCounts;
}

export interface PlaceSearchHit {
  readonly id: string;
  readonly name: string | null;
  readonly parentName: string | null;
  readonly iso: string | null;
  readonly kind: string;
}

export interface PlaceListQuery {
  readonly query: string;
  readonly kind: string | null;
  readonly parentId: string | null;
  readonly page: number;
}

export type PlaceMutationFailure = {
  readonly ok: false;
  readonly reason: string;
};

const placeMutationSchema = z
  .object({ ok: z.boolean(), reason: z.string().optional() })
  .passthrough();

/**
 * Boundary parser for place-mutation outcomes. Server functions cross
 * without a static result type, so `safeParse` narrows the outcome into
 * the documented `{ok, reason?}` contract here; anything else (including a
 * transport failure shaped differently) falls back to the generic message.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary parser: the only untyped input in this module, narrowed by safeParse into the documented contract below.
export const readMutationFailure = (outcome: unknown, fallback: string): string | null => {
  const parsed = placeMutationSchema.safeParse(outcome);

  if (!parsed.success) {
    return fallback;
  }

  if (parsed.data.ok) {
    return null;
  }

  const reason = parsed.data.reason;

  if (reason === undefined || reason === "") {
    return fallback;
  }

  return reason;
};

const placeSearchPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      displayName: z.string().nullable(),
      iso3166: z.string().nullable(),
      kind: z.string(),
    }),
  ),
});

/** Boundary parser for registry search pages; unparseable pages read as empty. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary parser: same untyped transport as above, narrowed by safeParse into the search-hit contract.
export const parseSearchHits = (page: unknown): ReadonlyArray<PlaceSearchHit> => {
  const parsed = placeSearchPageSchema.safeParse(page);

  if (!parsed.success) {
    return [];
  }

  return parsed.data.items.map((entry) => ({
    id: entry.id,
    name: entry.displayName,
    parentName: null,
    iso: entry.iso3166,
    kind: entry.kind,
  }));
};

const createdPlaceSchema = z.object({
  ok: z.literal(true),
  place: z.object({ id: z.string() }),
});

/** Boundary parser for the create-place outcome; null when unparseable. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary parser: same untyped transport, narrowed by safeParse into the created-place contract.
export const parseCreatedPlaceId = (outcome: unknown): string | null => {
  const parsed = createdPlaceSchema.safeParse(outcome);

  if (!parsed.success) {
    return null;
  }

  return parsed.data.place.id;
};
