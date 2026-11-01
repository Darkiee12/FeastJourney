import { Context, Data, Effect, Layer } from "effect";

import {
  InvalidRelationship,
  InvalidSearchFilter,
  PlaceNotFound,
} from "@/modules/food-discovery/server/domain/errors";
import {
  encodeDbId,
  isDbIdString,
  isLanguageTag,
} from "@/modules/food-discovery/server/domain/ids";
import {
  normalizeSearchKey,
  toContainsKey,
  toPrefixKey,
} from "@/modules/food-discovery/server/domain/search";
import {
  PlaceRepository,
  type PlaceAncestorRow,
  type PlaceNameRow,
  type PlaceNameWithIdRow,
  type PlaceRow,
} from "@/modules/food-discovery/server/repository/place-repository";
import { Authorization } from "@/modules/user/server/operations/authorization";
import type { RoleRepository } from "@/modules/user/server/repository/role-repository";
import { type Actor, describeActor } from "@/server/auth/actor";
import { CurrentActor } from "@/server/auth/current-actor";
import { type InsufficientPermissions } from "@/server/auth/errors";
import { type Database, withTransaction } from "@/server/database/client";
import {
  type DatabaseUnavailable,
  type PersistenceConflict,
  type PersistenceError,
  type TransactionConflict,
  type TransactionFailed,
} from "@/server/database/errors";
import type { DatabaseError } from "@/server/database/query";

/**
 * Place registry administration: full CRUD for `feastjourney.places`,
 * `place_names`, and `place_parents` with hierarchy cycle guards.
 *
 * Authorization model (mirrors dish-media-service, not admin-service):
 * every mutation resolves the per-request `CurrentActor` and enforces
 * `food:update` against current database grants inside the operation.
 * Transports enforce the same permission at the server boundary, so a
 * missing check in either layer still fails closed. Reads are policy-free
 * (the transport owns `food:read`); `resolvePlaceRef` is intentionally
 * callable from import workflows that enforce their own permission.
 *
 * Every mutation records one `place_revisions` row in the same transaction
 * as the mutation. The dish-bound `catalog_revisions`/`curation_notes`
 * tables cannot audit places (their `dish_id` is NOT NULL), which is why
 * the place_revisions table exists — see V20261101_001.
 */

export class ConflictingPlace extends Data.TaggedError("ConflictingPlace")<{
  readonly reason: string;
}> {}

export class PlaceHasChildren extends Data.TaggedError("PlaceHasChildren")<{
  readonly placeId: string;
  readonly childCount: number;
}> {}

export class PlaceHasDishLinks extends Data.TaggedError("PlaceHasDishLinks")<{
  readonly placeId: string;
  readonly dishCount: number;
}> {}

export interface AmbiguousPlaceCandidate {
  readonly id: string;
  readonly name: string;
  readonly context: string;
}

export class AmbiguousPlace extends Data.TaggedError("AmbiguousPlace")<{
  readonly query: string;
  readonly candidates: ReadonlyArray<AmbiguousPlaceCandidate>;
}> {}

export class InvalidPlaceData extends Data.TaggedError("InvalidPlaceData")<{
  readonly reason: string;
}> {}

export type PlaceAdminError =
  | AmbiguousPlace
  | ConflictingPlace
  | InvalidPlaceData
  | InvalidRelationship
  | InvalidSearchFilter
  | PlaceHasChildren
  | PlaceHasDishLinks
  | PlaceNotFound
  | InsufficientPermissions
  | DatabaseUnavailable
  | PersistenceError
  | PersistenceConflict
  | TransactionConflict
  | TransactionFailed;

/**
 * Error channel of the seven mutating operations. Resolvers fail only with
 * `PlaceResolverError`; mutations never produce `AmbiguousPlace`, so the
 * transport maps exactly this union to client-safe outcomes and lets the
 * infrastructure tail propagate as server-function errors.
 */
export type PlaceMutationError =
  | ConflictingPlace
  | InvalidPlaceData
  | InvalidRelationship
  | InvalidSearchFilter
  | PlaceHasChildren
  | PlaceHasDishLinks
  | PlaceNotFound
  | InsufficientPermissions
  | DatabaseUnavailable
  | PersistenceError
  | PersistenceConflict
  | TransactionConflict
  | TransactionFailed;

export type PlaceResolverError =
  | AmbiguousPlace
  | PlaceNotFound
  | DatabaseUnavailable
  | PersistenceError
  | PersistenceConflict
  | TransactionConflict;

/** Transport-ready place projection: decimal-string id, raw row otherwise. */
export interface PlaceView {
  readonly id: string;
  readonly kind: string;
  readonly iso3166: string | null;
  readonly displayLatitude: number | null;
  readonly displayLongitude: number | null;
  readonly displayNote: string | null;
}

export interface PlaceNameView {
  readonly id: string;
  readonly languageTag: string;
  readonly name: string;
  readonly isPreferred: boolean;
  readonly searchKey: string;
}

export type PlaceDetailName = PlaceNameView;

export interface PlaceHierarchyEntry extends PlaceView {
  readonly displayName: string | null;
}

export interface PlaceAncestorEntry extends PlaceHierarchyEntry {
  readonly depth: number;
}

export interface PlaceDishCounts {
  readonly origin: number;
  readonly associated: number;
  readonly popular: number;
  readonly total: number;
}

export interface PlaceDetail {
  readonly place: PlaceView;
  readonly names: ReadonlyArray<PlaceDetailName>;
  readonly parents: ReadonlyArray<PlaceHierarchyEntry>;
  readonly ancestors: ReadonlyArray<PlaceAncestorEntry>;
  readonly children: ReadonlyArray<PlaceHierarchyEntry>;
  readonly dishCounts: PlaceDishCounts;
}

export interface PlaceListItem extends PlaceView {
  readonly displayName: string | null;
}

export interface PlaceListPage {
  readonly items: ReadonlyArray<PlaceListItem>;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface PlaceNameInput {
  readonly languageTag: string;
  readonly name: string;
  readonly isPreferred?: boolean | undefined;
}

export interface CreatePlaceInput {
  readonly kind: string;
  readonly iso3166?: string | null | undefined;
  readonly displayLatitude?: number | null | undefined;
  readonly displayLongitude?: number | null | undefined;
  readonly displayNote?: string | null | undefined;
  readonly names: ReadonlyArray<PlaceNameInput>;
  readonly parentIds?: ReadonlyArray<string> | undefined;
}

export interface UpdatePlaceInput {
  readonly kind?: string | undefined;
  readonly iso3166?: string | null | undefined;
  readonly displayLatitude?: number | null | undefined;
  readonly displayLongitude?: number | null | undefined;
  readonly displayNote?: string | null | undefined;
}

/**
 * One entry of an atomic place-name save: `id` present renames that name
 * row in place (row and place ids never change); absent inserts a new row.
 * `isPreferred` absent keeps the stored flag for edits, or the
 * first-per-language default for inserts.
 */
export interface PlaceNameSaveEntry {
  readonly id?: string | undefined;
  readonly languageTag: string;
  readonly name: string;
  readonly isPreferred?: boolean | undefined;
}

/**
 * Atomic multi-row name save: renames (by id), inserts (no id), and
 * deletes (by id) apply in one transaction or all roll back. Deleting a
 * preferred name while same-language siblings survive auto-promotes the
 * oldest sibling; no language is ever left without exactly one preferred
 * row unless the request marks a replacement preferred.
 */
export interface SavePlaceNamesInput {
  readonly upsert: ReadonlyArray<PlaceNameSaveEntry>;
  readonly removeIds: ReadonlyArray<string>;
}

/**
 * Portable place reference resolver input, shared by every workstream that
 * links dishes to places (admin UI, import studio, dish editor). Exactly one
 * variant is set: a registry id, an ISO 3166 code, or a city display name
 * optionally scoped by a parent ISO/country code. The default association
 * for a resolved link is decided by the caller (`associated`, never
 * `origin`).
 */
export type PlaceRef =
  | { readonly placeId: number }
  | { readonly iso: string }
  | { readonly city: string; readonly parentIso?: string | undefined };

const PLACE_KINDS: ReadonlySet<string> = new Set([
  "continent",
  "region",
  "country",
  "subnational",
  "province",
  "locality",
]);

const ISO_PATTERN = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

const PLACE_ADMIN_PAGE_SIZE = 20;

const MAX_RESOLVER_CANDIDATES = 25;

export const placeAdminPageSize = PLACE_ADMIN_PAGE_SIZE;

/**
 * Renders a PlaceNotFound from place resolution as the actionable
 * client-safe message every workstream shows: it names the Place Manager
 * role that owns registry additions. The error itself carries only the
 * query (domain errors have no message channel); callers use this helper
 * instead of inventing their own wording.
 */
export const placeNotFoundReason = (failure: PlaceNotFound): string =>
  `No place found for "${failure.placeId}". Ask the Place Manager to register it in the admin place catalog before linking.`;

const checkPlaceId = (id: string): Effect.Effect<bigint, InvalidSearchFilter> =>
  isDbIdString(id)
    ? Effect.succeed(BigInt(id))
    : Effect.fail(new InvalidSearchFilter({ reason: "place id must be a decimal id string" }));

const checkKind = (kind: string): Effect.Effect<string, InvalidSearchFilter> =>
  PLACE_KINDS.has(kind)
    ? Effect.succeed(kind)
    : Effect.fail(
        new InvalidSearchFilter({
          reason: `unknown place kind "${kind}"; expected one of ${[...PLACE_KINDS].join(", ")}`,
        }),
      );

const canonicalIso = (
  iso: string | null,
  kind: string,
): Effect.Effect<string | null, InvalidSearchFilter> => {
  if (iso === null) {
    return Effect.succeed(null);
  }

  const upper = iso.trim().toUpperCase();

  if (!ISO_PATTERN.test(upper)) {
    return Effect.fail(new InvalidSearchFilter({ reason: `invalid ISO 3166 code "${iso}"` }));
  }

  if (kind === "locality") {
    return Effect.fail(
      new InvalidSearchFilter({
        reason: "localities carry no ISO code of their own; leave iso3166 empty",
      }),
    );
  }

  return Effect.succeed(upper);
};

const checkCoordinates = (
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): Effect.Effect<
  { readonly latitude: number | null; readonly longitude: number | null },
  InvalidSearchFilter
> => {
  const lat = latitude === undefined ? null : latitude;
  const lon = longitude === undefined ? null : longitude;

  if (lat === null && lon === null) {
    return Effect.succeed({ latitude: null, longitude: null });
  }

  if (lat === null || lon === null) {
    return Effect.fail(
      new InvalidSearchFilter({
        reason: "latitude and longitude must be set together or both empty",
      }),
    );
  }

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return Effect.fail(new InvalidSearchFilter({ reason: "latitude must be between -90 and 90" }));
  }

  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return Effect.fail(
      new InvalidSearchFilter({ reason: "longitude must be between -180 and 180" }),
    );
  }

  return Effect.succeed({ latitude: lat, longitude: lon });
};

const toPlaceView = (row: PlaceRow): PlaceView => ({
  id: encodeDbId(row.id),
  kind: row.kind,
  iso3166: row.iso3166,
  displayLatitude: row.displayLatitude,
  displayLongitude: row.displayLongitude,
  displayNote: row.displayNote,
});

const toNameView = (row: PlaceNameWithIdRow): PlaceNameView => ({
  id: encodeDbId(row.id),
  languageTag: row.language_tag,
  name: row.name,
  isPreferred: row.is_preferred,
  searchKey: row.search_key,
});

const oldestNameRowOf = (
  rows: ReadonlyArray<PlaceNameRow | PlaceNameWithIdRow>,
): PlaceNameRow | PlaceNameWithIdRow | undefined => {
  const [first, ...rest] = rows;

  if (first === undefined) {
    return undefined;
  }

  let oldest = first;

  for (const entry of rest) {
    if ("id" in entry && "id" in oldest && entry.id < oldest.id) {
      oldest = entry;
    }
  }

  return oldest;
};

const pickDisplayName = (
  names: ReadonlyArray<PlaceNameRow | PlaceNameWithIdRow>,
): string | null => {
  // Per-language election: callers (detail, resolver, delete summary) show
  // one name, and every language keeps at most one preferred row (partial
  // unique index). English preferred wins; when English has rows but no
  // preferred row, the oldest English row wins — never a preferred alias
  // from another language. Otherwise any preferred row, else the oldest
  // row. "Oldest" is the smallest name-row id; id-less read projections
  // keep database order as the tiebreak.
  const english = names.filter((entry) => entry.language_tag === "en");
  const englishPreferred = english.find((entry) => entry.is_preferred);

  if (englishPreferred !== undefined) {
    return englishPreferred.name;
  }

  const oldestEnglish = oldestNameRowOf(english);

  if (oldestEnglish !== undefined) {
    return oldestEnglish.name;
  }

  const preferred = names.find((entry) => entry.is_preferred);

  if (preferred !== undefined) {
    return preferred.name;
  }

  const oldest = oldestNameRowOf(names);

  return oldest === undefined ? null : oldest.name;
};

const actorLabel = (actor: Actor): string => describeActor(actor).slice(0, 200);

const parentIdSetKey = (ids: ReadonlyArray<bigint>): string =>
  [...ids]
    .map((id) => id.toString())
    .toSorted()
    .join(",");

const comparePlaceNameRowsById = (
  a: { readonly id: bigint },
  b: { readonly id: bigint },
): number => {
  if (a.id < b.id) {
    return -1;
  }

  if (a.id > b.id) {
    return 1;
  }

  return 0;
};

const preparedNames = (names: ReadonlyArray<PlaceNameInput>) =>
  Effect.gen(function* () {
    if (names.length === 0) {
      return yield* new InvalidSearchFilter({ reason: "at least one name is required" });
    }

    const prepared: Array<{
      readonly languageTag: string;
      readonly name: string;
      readonly searchKey: string;
      readonly preferredRequested: boolean;
    }> = [];

    const seen = new Set<string>();

    for (const entry of names) {
      if (!isLanguageTag(entry.languageTag)) {
        return yield* new InvalidPlaceData({
          reason: `invalid language tag "${entry.languageTag}"`,
        });
      }

      const trimmed = entry.name.trim();

      if (trimmed.length === 0 || trimmed.length > 300) {
        return yield* new InvalidSearchFilter({ reason: "name must be 1-300 characters" });
      }

      const key = normalizeSearchKey(trimmed);

      if (key.length === 0) {
        return yield* new InvalidSearchFilter({ reason: "name has no searchable text" });
      }

      const dedupe = `${entry.languageTag} ${key}`;

      if (seen.has(dedupe)) {
        return yield* new InvalidSearchFilter({ reason: "duplicate name in request" });
      }

      seen.add(dedupe);
      prepared.push({
        languageTag: entry.languageTag,
        name: trimmed,
        searchKey: key,
        preferredRequested: entry.isPreferred ?? false,
      });
    }

    const preferredCountByLang = new Map<string, number>();

    for (const entry of prepared) {
      if (entry.preferredRequested) {
        preferredCountByLang.set(
          entry.languageTag,
          (preferredCountByLang.get(entry.languageTag) ?? 0) + 1,
        );
      }
    }

    for (const [languageTag, count] of preferredCountByLang) {
      if (count > 1) {
        return yield* new InvalidSearchFilter({
          reason: `multiple preferred names for language "${languageTag}"`,
        });
      }
    }

    const preferredSeen = new Set<string>();

    return prepared.map((entry) => {
      let isPreferred = entry.preferredRequested;

      if (
        !isPreferred &&
        !preferredSeen.has(entry.languageTag) &&
        !preferredCountByLang.has(entry.languageTag)
      ) {
        isPreferred = true;
      }

      if (isPreferred) {
        preferredSeen.add(entry.languageTag);
      }

      return {
        languageTag: entry.languageTag,
        name: entry.name,
        searchKey: entry.searchKey,
        isPreferred,
      };
    });
  });

export class PlaceAdminService extends Context.Service<PlaceAdminService, PlaceAdminApi>()(
  "feastjourney/food-discovery/PlaceAdminService",
) {}

export interface PlaceAdminApi {
  readonly listPlaces: (input: {
    readonly query?: string | undefined;
    readonly kind?: string | undefined;
    readonly parentId?: string | undefined;
    readonly page?: number | undefined;
  }) => Effect.Effect<PlaceListPage, InvalidSearchFilter | DatabaseError, Database>;
  readonly placeDetail: (
    placeId: string,
  ) => Effect.Effect<PlaceDetail, PlaceNotFound | InvalidSearchFilter | DatabaseError, Database>;
  readonly createPlace: (
    input: CreatePlaceInput,
  ) => Effect.Effect<
    PlaceView,
    PlaceMutationError,
    Database | Authorization | CurrentActor | RoleRepository
  >;
  readonly updatePlace: (
    placeId: string,
    input: UpdatePlaceInput,
  ) => Effect.Effect<
    PlaceView,
    PlaceMutationError,
    Database | Authorization | CurrentActor | RoleRepository
  >;
  readonly deletePlace: (
    placeId: string,
  ) => Effect.Effect<
    { readonly id: string },
    PlaceMutationError,
    Database | Authorization | CurrentActor | RoleRepository
  >;
  readonly upsertPlaceNames: (
    placeId: string,
    names: ReadonlyArray<PlaceNameInput>,
  ) => Effect.Effect<
    ReadonlyArray<PlaceNameView>,
    PlaceMutationError,
    Database | Authorization | CurrentActor | RoleRepository
  >;
  readonly removePlaceName: (
    placeId: string,
    nameId: string,
  ) => Effect.Effect<
    { readonly removedNameId: string; readonly promotedNameId: string | null },
    PlaceMutationError,
    Database | Authorization | CurrentActor | RoleRepository
  >;
  /**
   * Atomic rename/insert/delete of a place's names in a single
   * transaction. Preferred-name handling is per language: every final
   * language keeps exactly one preferred row; explicit `isPreferred: true`
   * wins, otherwise the kept stored preferred, otherwise the oldest
   * surviving row (auto-promotion). Any validation failure rolls back all
   * rows and the revision write.
   */
  readonly savePlaceNames: (
    placeId: string,
    input: SavePlaceNamesInput,
  ) => Effect.Effect<
    ReadonlyArray<PlaceNameView>,
    PlaceMutationError,
    Database | Authorization | CurrentActor | RoleRepository
  >;
  readonly setPlaceParent: (
    placeId: string,
    parentPlaceId: string,
  ) => Effect.Effect<
    { readonly linked: boolean },
    PlaceMutationError,
    Database | Authorization | CurrentActor | RoleRepository
  >;
  readonly removePlaceParent: (
    placeId: string,
    parentPlaceId: string,
  ) => Effect.Effect<
    { readonly removed: boolean },
    PlaceMutationError,
    Database | Authorization | CurrentActor | RoleRepository
  >;
  readonly resolvePlaceRef: (
    ref: PlaceRef,
  ) => Effect.Effect<PlaceView, PlaceResolverError, Database>;
}

export const PlaceAdminServiceLive = Layer.effect(
  PlaceAdminService,
  Effect.gen(function* () {
    const places = yield* PlaceRepository;

    const requireFoodUpdate = Effect.gen(function* () {
      const actor = yield* CurrentActor;
      const authorization = yield* Authorization;

      yield* authorization.require(actor, { resource: "food", actions: ["update"] });

      return actor;
    });

    const requirePlace = (id: bigint, raw: string) =>
      Effect.gen(function* () {
        const record = yield* places.findById(id);

        if (record === null) {
          return yield* new PlaceNotFound({ placeId: raw });
        }

        return record;
      });

    /**
     * Duplicate-identity refusal: no two places may share (kind, name,
     * parent set). Compares exact search keys (not fuzzy tiers) so
     * distinct names never collide, and compares full parent sets so
     * same-named places under different parents (two Springfields) stay
     * legal.
     */
    const assertUniqueIdentity = (
      excludePlaceId: bigint | null,
      kind: string,
      nameKeys: ReadonlyArray<string>,
      parentIds: ReadonlyArray<bigint>,
    ) =>
      Effect.gen(function* () {
        if (nameKeys.length === 0) {
          return;
        }

        const rows = yield* places.findByNameKeys(nameKeys);
        const wanted = parentIdSetKey(parentIds);
        const clashingIds = new Set<bigint>();

        for (const row of rows) {
          if (excludePlaceId !== null && row.id === excludePlaceId) {
            continue;
          }

          if (row.kind !== kind) {
            continue;
          }

          clashingIds.add(row.id);
        }

        if (clashingIds.size === 0) {
          return;
        }

        const edges = yield* places.parentsByPlaceIds([...clashingIds]);
        const parentsByPlace = new Map<string, Array<bigint>>();

        for (const edge of edges) {
          const key = edge.place_id.toString();
          const list = parentsByPlace.get(key) ?? [];

          list.push(edge.parent_place_id);
          parentsByPlace.set(key, list);
        }

        for (const id of clashingIds) {
          const actual = parentIdSetKey(parentsByPlace.get(id.toString()) ?? []);

          if (actual === wanted) {
            const clash = rows.find((row) => row.id === id);

            yield* new ConflictingPlace({
              reason: `place "${clash?.name ?? id.toString()}" (${kind}) already exists under the same parent (id ${encodeDbId(id)})`,
            });

            return;
          }
        }
      });

    /**
     * DAG cycle guard: the proposed parent must not already be reachable
     * from the child (i.e. the parent must not be the child itself or one
     * of its descendants). Reachability in the other direction is the
     * normal case — re-linking an existing ancestor, or linking a
     * grandchild directly under its grandparent, stays acyclic. The
     * `place_parents_no_cycle` trigger remains as defense-in-depth; a
     * trigger firing despite this check means a concurrent hierarchy edit
     * won the race and surfaces as PersistenceError, never a silent cycle.
     */
    const assertNoPlaceCycle = (childId: bigint, parentId: bigint) =>
      Effect.gen(function* () {
        if (childId === parentId) {
          yield* new InvalidRelationship({ reason: "a place cannot parent itself" });

          return;
        }

        const subtree = yield* places.descendants(childId);

        if (subtree.some((row) => row.id === parentId)) {
          yield* new InvalidRelationship({
            reason: "place parent assignment would create a cycle",
          });

          return;
        }
      });

    const listPlaces: PlaceAdminApi["listPlaces"] = (input) =>
      Effect.gen(function* () {
        const kind = input.kind === undefined ? null : yield* checkKind(input.kind);

        let parentId: bigint | null = null;

        if (input.parentId !== undefined) {
          parentId = yield* checkPlaceId(input.parentId);
        }

        const page = input.page ?? 0;

        if (!Number.isInteger(page) || page < 0) {
          return yield* new InvalidSearchFilter({ reason: "page must be a non-negative integer" });
        }

        const key = normalizeSearchKey(input.query ?? "");
        const tokens = key.split(" ").filter((token) => token.length > 0);

        const rows = yield* places.listAdmin({
          tokens,
          kind,
          parentId,
          limit: PLACE_ADMIN_PAGE_SIZE,
          offset: page * PLACE_ADMIN_PAGE_SIZE,
        });

        const first = rows[0];

        return {
          items: rows.map((row) => ({
            id: encodeDbId(row.id),
            kind: row.kind,
            iso3166: row.iso3166,
            displayLatitude: row.displayLatitude,
            displayLongitude: row.displayLongitude,
            displayNote: row.displayNote,
            displayName: row.displayName,
          })),
          page,
          pageSize: PLACE_ADMIN_PAGE_SIZE,
          total: first === undefined ? 0 : first.total,
        };
      });

    const placeDetail: PlaceAdminApi["placeDetail"] = (placeId) =>
      Effect.gen(function* () {
        const id = yield* checkPlaceId(placeId);
        const record = yield* requirePlace(id, placeId);

        const [names, ancestors, children, counts, directEdges] = yield* Effect.all(
          [
            places.namesWithIdsByPlaceIds([id]),
            places.ancestors(id),
            places.childrenOf(id),
            places.dishLinkCounts(id),
            places.parentsByPlaceIds([id]),
          ],
          { concurrency: 5 },
        );

        const relatedIds = [...ancestors.map((row) => row.id), ...children.map((row) => row.id)];

        const relatedNames =
          relatedIds.length === 0 ? [] : yield* places.namesWithIdsByPlaceIds(relatedIds);

        const namesByPlace = new Map<string, Array<PlaceNameRow | PlaceNameWithIdRow>>();

        for (const row of [...names, ...relatedNames]) {
          const key = row.place_id.toString();
          const list = namesByPlace.get(key) ?? [];

          list.push(row);
          namesByPlace.set(key, list);
        }

        const nameOf = (pid: bigint): string | null =>
          pickDisplayName(namesByPlace.get(pid.toString()) ?? []);

        const countsByAssociation = new Map<string, number>();
        let dishTotal = 0;

        for (const row of counts) {
          countsByAssociation.set(row.association, row.total);
          dishTotal += row.total;
        }

        const dishCounts: PlaceDishCounts = {
          origin: countsByAssociation.get("origin") ?? 0,
          associated: countsByAssociation.get("associated") ?? 0,
          popular: countsByAssociation.get("popular") ?? 0,
          total: dishTotal,
        };

        const ancestorEntries: ReadonlyArray<PlaceAncestorEntry> = ancestors
          .filter((row) => row.depth > 0)
          .map((row: PlaceAncestorRow) => ({
            id: encodeDbId(row.id),
            kind: row.kind,
            iso3166: row.iso3166,
            displayLatitude: row.displayLatitude,
            displayLongitude: row.displayLongitude,
            displayNote: row.displayNote,
            displayName: nameOf(row.id),
            depth: row.depth,
          }));

        return {
          place: toPlaceView(record),
          names: names.map(toNameView),
          parents: directEdges.map((edge) => {
            const parent = ancestors.find((row) => row.id === edge.parent_place_id);

            return {
              id: encodeDbId(edge.parent_place_id),
              kind: parent?.kind ?? "unknown",
              iso3166: parent?.iso3166 ?? null,
              displayLatitude: parent?.displayLatitude ?? null,
              displayLongitude: parent?.displayLongitude ?? null,
              displayNote: parent?.displayNote ?? null,
              displayName: nameOf(edge.parent_place_id),
            };
          }),
          ancestors: ancestorEntries,
          children: children.map((row) => ({
            id: encodeDbId(row.id),
            kind: row.kind,
            iso3166: row.iso3166,
            displayLatitude: row.displayLatitude,
            displayLongitude: row.displayLongitude,
            displayNote: row.displayNote,
            displayName: nameOf(row.id),
          })),
          dishCounts,
        };
      });

    const createPlace: PlaceAdminApi["createPlace"] = (input) =>
      Effect.gen(function* () {
        const actor = yield* requireFoodUpdate;
        const kind = yield* checkKind(input.kind);

        const iso3166 =
          input.iso3166 === undefined || input.iso3166 === null
            ? yield* canonicalIso(null, kind)
            : yield* canonicalIso(input.iso3166, kind);

        const coords = yield* checkCoordinates(input.displayLatitude, input.displayLongitude);

        const note =
          input.displayNote === undefined || input.displayNote === null
            ? null
            : input.displayNote.trim().slice(0, 2000);

        const prepared = yield* preparedNames(input.names);

        const parentIds: Array<bigint> = [];

        for (const raw of input.parentIds ?? []) {
          const pid = yield* checkPlaceId(raw);
          const parent = yield* places.findById(pid);

          if (parent === null) {
            return yield* new InvalidSearchFilter({ reason: `unknown parent place id "${raw}"` });
          }

          if (!parentIds.some((known) => known === pid)) {
            parentIds.push(pid);
          }
        }

        yield* assertUniqueIdentity(
          null,
          kind,
          prepared.map((entry) => entry.searchKey),
          parentIds,
        );

        const created = yield* withTransaction(
          "place-admin/create-place",
          Effect.gen(function* () {
            const record = yield* places.insert({
              kind,
              iso3166,
              displayLatitude: coords.latitude,
              displayLongitude: coords.longitude,
              displayNote: note === "" ? null : note,
            });

            for (const entry of prepared) {
              yield* places.insertName({
                placeId: record.id,
                languageTag: entry.languageTag,
                name: entry.name,
                isPreferred: entry.isPreferred,
                searchKey: entry.searchKey,
              });
            }

            for (const pid of parentIds) {
              yield* places.insertParent({ placeId: record.id, parentPlaceId: pid });
            }

            yield* places.insertRevision({
              placeId: record.id,
              actor: actorLabel(actor),
              operation: "created",
              summary: `created place ${kind} "${prepared[0]?.name ?? record.id.toString()}"`,
            });

            return record;
          }),
        ).pipe(
          Effect.catchTag("PersistenceConflict", (failure) =>
            Effect.fail(
              new ConflictingPlace({
                reason: `place conflicts with an existing record (${failure.constraint ?? "unique constraint"})`,
              }),
            ),
          ),
        );

        return toPlaceView(created);
      });

    const updatePlace: PlaceAdminApi["updatePlace"] = (placeId, input) =>
      Effect.gen(function* () {
        const actor = yield* requireFoodUpdate;
        const id = yield* checkPlaceId(placeId);
        const record = yield* requirePlace(id, placeId);

        const kind = input.kind === undefined ? record.kind : yield* checkKind(input.kind);

        const iso3166 =
          input.iso3166 === undefined ? record.iso3166 : yield* canonicalIso(input.iso3166, kind);

        const coords = yield* checkCoordinates(
          input.displayLatitude === undefined ? record.displayLatitude : input.displayLatitude,
          input.displayLongitude === undefined ? record.displayLongitude : input.displayLongitude,
        );

        let note: string | null;

        if (input.displayNote === undefined) {
          note = record.displayNote;
        } else if (input.displayNote === null) {
          note = null;
        } else {
          note = input.displayNote.trim().slice(0, 2000);
        }

        if (kind !== record.kind) {
          const [existingNames, existingEdges] = yield* Effect.all(
            [places.namesByPlaceIds([id]), places.parentsByPlaceIds([id])],
            { concurrency: 2 },
          );

          yield* assertUniqueIdentity(
            id,
            kind,
            existingNames.map((row) => row.search_key),
            existingEdges.map((edge) => edge.parent_place_id),
          );
        }

        const updated = yield* withTransaction(
          "place-admin/update-place",
          Effect.gen(function* () {
            const result = yield* places.update({
              id,
              kind,
              iso3166,
              displayLatitude: coords.latitude,
              displayLongitude: coords.longitude,
              displayNote: note === "" ? null : note,
            });

            if (result === null) {
              return yield* new PlaceNotFound({ placeId });
            }

            yield* places.insertRevision({
              placeId: id,
              actor: actorLabel(actor),
              operation: "updated",
              summary: `updated place ${encodeDbId(id)} (${kind})`,
            });

            return result;
          }),
        ).pipe(
          Effect.catchTag("PersistenceConflict", (failure) =>
            Effect.fail(
              new ConflictingPlace({
                reason: `place conflicts with an existing record (${failure.constraint ?? "unique constraint"})`,
              }),
            ),
          ),
        );

        return toPlaceView(updated);
      });

    const deletePlace: PlaceAdminApi["deletePlace"] = (placeId) =>
      Effect.gen(function* () {
        const actor = yield* requireFoodUpdate;
        const id = yield* checkPlaceId(placeId);
        const record = yield* requirePlace(id, placeId);
        const names = yield* places.namesByPlaceIds([id]);

        const refuseInUse = Effect.gen(function* () {
          const [children, counts] = yield* Effect.all(
            [places.childrenOf(id), places.dishLinkCounts(id)],
            { concurrency: 2 },
          );

          if (children.length > 0) {
            yield* new PlaceHasChildren({ placeId, childCount: children.length });

            return;
          }

          const total = counts.reduce((sum, row) => sum + row.total, 0);

          if (total > 0) {
            yield* new PlaceHasDishLinks({ placeId, dishCount: total });

            return;
          }
        });

        yield* refuseInUse;

        const displayName = pickDisplayName(names) ?? record.kind;

        yield* withTransaction(
          "place-admin/delete-place",
          Effect.gen(function* () {
            const deleted = yield* places.deletePlace(id);

            if (deleted === null) {
              yield* new PlaceNotFound({ placeId });

              return;
            }

            // The revision carries a NULL place_id: the row it describes is
            // gone, and older history rows cascade away with the place
            // (mirroring catalog_revisions). The summary names the deleted
            // place so the trail stays readable.
            yield* places.insertRevision({
              placeId: null,
              actor: actorLabel(actor),
              operation: "deleted",
              summary: `deleted place ${placeId} ("${displayName}")`,
            });
          }),
        ).pipe(
          Effect.catchTag("PersistenceConflict", () =>
            Effect.flatMap(refuseInUse, () =>
              Effect.fail(
                new InvalidPlaceData({
                  reason: `place ${placeId} changed during deletion; retry the request`,
                }),
              ),
            ),
          ),
        );

        return { id: placeId };
      });

    const upsertPlaceNames: PlaceAdminApi["upsertPlaceNames"] = (placeId, names) =>
      Effect.gen(function* () {
        const actor = yield* requireFoodUpdate;
        const id = yield* checkPlaceId(placeId);

        yield* requirePlace(id, placeId);

        if (names.length === 0) {
          return yield* new InvalidSearchFilter({ reason: "at least one name is required" });
        }

        const validated: Array<{
          readonly languageTag: string;
          readonly name: string;
          readonly searchKey: string;
          readonly isPreferred: boolean;
        }> = [];

        for (const entry of names) {
          if (!isLanguageTag(entry.languageTag)) {
            return yield* new InvalidPlaceData({
              reason: `invalid language tag "${entry.languageTag}"`,
            });
          }

          const trimmed = entry.name.trim();

          if (trimmed.length === 0 || trimmed.length > 300) {
            return yield* new InvalidSearchFilter({ reason: "name must be 1-300 characters" });
          }

          const key = normalizeSearchKey(trimmed);

          if (key.length === 0) {
            return yield* new InvalidSearchFilter({ reason: "name has no searchable text" });
          }

          validated.push({
            languageTag: entry.languageTag,
            name: trimmed,
            searchKey: key,
            isPreferred: entry.isPreferred ?? false,
          });
        }

        const result = yield* withTransaction(
          "place-admin/upsert-names",
          Effect.gen(function* () {
            const working = [...(yield* places.namesWithIdsByPlaceIds([id]))];

            // demoteNames clears the whole language in the database; mirror
            // it in the in-memory working copy so the returned views never
            // report two preferred names for one language.
            const demoteWorking = (languageTag: string): void => {
              for (const [index, row] of working.entries()) {
                if (row.language_tag === languageTag && row.is_preferred) {
                  working[index] = { ...row, is_preferred: false };
                }
              }
            };

            for (const entry of validated) {
              const match = working.find(
                (row) => row.language_tag === entry.languageTag && row.name === entry.name,
              );

              if (match !== undefined) {
                if (entry.isPreferred && !match.is_preferred) {
                  yield* places.demoteNames({ placeId: id, languageTag: entry.languageTag });
                  demoteWorking(entry.languageTag);

                  const promoted = yield* places.promoteName({ id: match.id, placeId: id });

                  if (promoted === null) {
                    return yield* new InvalidPlaceData({
                      reason: `place name "${entry.name}" changed during the request; retry`,
                    });
                  }

                  const index = working.findIndex((row) => row.id === match.id);

                  if (index !== -1) {
                    working[index] = promoted;
                  }
                }

                continue;
              }

              if (entry.isPreferred) {
                yield* places.demoteNames({ placeId: id, languageTag: entry.languageTag });
                demoteWorking(entry.languageTag);
              }

              const created = yield* places.insertName({
                placeId: id,
                languageTag: entry.languageTag,
                name: entry.name,
                isPreferred: entry.isPreferred,
                searchKey: entry.searchKey,
              });

              working.push(created);
            }

            yield* places.insertRevision({
              placeId: id,
              actor: actorLabel(actor),
              operation: "name_upserted",
              summary: `upserted ${validated.length} place name(s) on ${placeId}`,
            });

            return working.map(toNameView);
          }),
        ).pipe(
          Effect.catchTag("PersistenceConflict", (failure) =>
            Effect.fail(
              new ConflictingPlace({
                reason: `place name conflicts with an existing record (${failure.constraint ?? "unique constraint"})`,
              }),
            ),
          ),
        );

        return result;
      });

    const removePlaceName: PlaceAdminApi["removePlaceName"] = (placeId, nameId) =>
      Effect.gen(function* () {
        const actor = yield* requireFoodUpdate;
        const id = yield* checkPlaceId(placeId);
        const nid = yield* checkPlaceId(nameId);

        yield* requirePlace(id, placeId);

        const existing = yield* places.namesWithIdsByPlaceIds([id]);
        const target = existing.find((row) => row.id === nid);

        if (target === undefined) {
          return yield* new InvalidSearchFilter({ reason: `unknown place name id "${nameId}"` });
        }

        if (existing.length === 1) {
          return yield* new InvalidSearchFilter({ reason: "a place must keep at least one name" });
        }

        // Deleting a preferred name must not strand its language without one:
        // promote the oldest surviving name in that language first.
        const sibling = target.is_preferred
          ? existing
              .filter((row) => row.id !== nid && row.language_tag === target.language_tag)
              .toSorted(comparePlaceNameRowsById)[0]
          : undefined;

        if (target.is_preferred && sibling === undefined) {
          return yield* new InvalidSearchFilter({
            reason: `cannot remove the only "${target.language_tag}" name "${target.name}" without a replacement`,
          });
        }

        const promoted = yield* withTransaction(
          "place-admin/remove-name",
          Effect.gen(function* () {
            let promotedId: bigint | null = null;

            if (sibling !== undefined) {
              yield* places.demoteNames({ placeId: id, languageTag: target.language_tag });

              const row = yield* places.promoteName({ id: sibling.id, placeId: id });

              if (row === null) {
                return yield* new InvalidPlaceData({
                  reason: `place name "${sibling.name}" changed during the request; retry`,
                });
              }

              promotedId = row.id;
            }

            const deleted = yield* places.deleteName({ id: nid, placeId: id });

            if (deleted === null) {
              return yield* new InvalidPlaceData({
                reason: `place name "${target.name}" changed during the request; retry`,
              });
            }

            yield* places.insertRevision({
              placeId: id,
              actor: actorLabel(actor),
              operation: "name_removed",
              summary: `removed place name "${target.name}" (${target.language_tag}) from ${placeId}`,
            });

            return promotedId;
          }),
        );

        return {
          removedNameId: nameId,
          promotedNameId: promoted === null ? null : encodeDbId(promoted),
        };
      });

    const savePlaceNames: PlaceAdminApi["savePlaceNames"] = (placeId, input) =>
      Effect.gen(function* () {
        const actor = yield* requireFoodUpdate;
        const id = yield* checkPlaceId(placeId);

        yield* requirePlace(id, placeId);

        const removeIds: Array<bigint> = [];

        for (const raw of input.removeIds) {
          removeIds.push(yield* checkPlaceId(raw));
        }

        if (new Set(removeIds.map((value) => value.toString())).size !== removeIds.length) {
          return yield* new InvalidSearchFilter({ reason: "duplicate name id in removeIds" });
        }

        const prepared: Array<{
          readonly nameId: bigint | null;
          readonly languageTag: string;
          readonly name: string;
          readonly searchKey: string;
          readonly isPreferred: boolean | undefined;
        }> = [];

        const seenIds = new Set<string>();
        const seenNew = new Set<string>();

        for (const entry of input.upsert) {
          const nameId = entry.id !== undefined ? yield* checkPlaceId(entry.id) : null;

          if (nameId !== null) {
            const key = nameId.toString();

            if (seenIds.has(key) || removeIds.some((candidate) => candidate === nameId)) {
              return yield* new InvalidSearchFilter({ reason: "duplicate name id in request" });
            }

            seenIds.add(key);
          } else {
            const dedupe = `${entry.languageTag} ${entry.name.trim()}`;

            if (seenNew.has(dedupe)) {
              return yield* new InvalidSearchFilter({ reason: "duplicate name in request" });
            }

            seenNew.add(dedupe);
          }

          if (!isLanguageTag(entry.languageTag)) {
            return yield* new InvalidPlaceData({
              reason: `invalid language tag "${entry.languageTag}"`,
            });
          }

          const trimmed = entry.name.trim();

          if (trimmed.length === 0 || trimmed.length > 300) {
            return yield* new InvalidSearchFilter({ reason: "name must be 1-300 characters" });
          }

          const key = normalizeSearchKey(trimmed);

          if (key.length === 0) {
            return yield* new InvalidSearchFilter({ reason: "name has no searchable text" });
          }

          prepared.push({
            nameId,
            languageTag: entry.languageTag,
            name: trimmed,
            searchKey: key,
            isPreferred: entry.isPreferred,
          });
        }

        const explicitCount = new Map<string, number>();

        for (const entry of prepared) {
          if (entry.isPreferred === true) {
            explicitCount.set(entry.languageTag, (explicitCount.get(entry.languageTag) ?? 0) + 1);
          }
        }

        for (const [languageTag, count] of explicitCount) {
          if (count > 1) {
            return yield* new InvalidSearchFilter({
              reason: `multiple preferred names for language "${languageTag}"`,
            });
          }
        }

        const result = yield* withTransaction(
          "place-admin/save-names",
          Effect.gen(function* () {
            const current = yield* places.namesWithIdsByPlaceIds([id]);
            const byId = new Map(current.map((row) => [row.id.toString(), row] as const));

            for (const nameId of removeIds) {
              if (!byId.has(nameId.toString())) {
                return yield* new InvalidSearchFilter({
                  reason: `unknown place name id "${nameId.toString()}"`,
                });
              }
            }

            for (const entry of prepared) {
              if (entry.nameId !== null) {
                const row = byId.get(entry.nameId.toString());

                if (row === undefined || row.place_id !== id) {
                  return yield* new InvalidSearchFilter({
                    reason: `unknown place name id "${entry.nameId.toString()}"`,
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
              return yield* new InvalidSearchFilter({
                reason: "a place must keep at least one name",
              });
            }

            // Final-state identity, renames included: (language_tag,
            // search_key) is unique per place across surviving and
            // inserted rows. Cross-place duplicate-identity refusal (same
            // kind + name + parent set) stays with create/updatePlace, which
            // own kind and parent edges; this save owns only the name rows.
            const editsById = new Map(
              prepared.flatMap((entry) =>
                entry.nameId === null ? [] : [[entry.nameId.toString(), entry] as const],
              ),
            );

            const finalKeys = new Set<string>();

            for (const row of survivors) {
              const edit = editsById.get(row.id.toString());
              const dedupe = `${edit?.languageTag ?? row.language_tag} ${edit?.searchKey ?? row.search_key}`;

              if (finalKeys.has(dedupe)) {
                return yield* new InvalidSearchFilter({ reason: "duplicate name in request" });
              }

              finalKeys.add(dedupe);
            }

            for (const entry of prepared) {
              if (entry.nameId === null) {
                const dedupe = `${entry.languageTag} ${entry.searchKey}`;

                if (finalKeys.has(dedupe)) {
                  return yield* new InvalidSearchFilter({ reason: "duplicate name in request" });
                }

                finalKeys.add(dedupe);
              }
            }

            const upsertWinner = new Map<string, (typeof prepared)[number]>();

            for (const entry of prepared) {
              if (entry.isPreferred === true) {
                upsertWinner.set(entry.languageTag, entry);
              }
            }

            // Per-language preferred resolution over the final rows.
            // Explicit `isPreferred: true` wins. Otherwise the kept stored
            // preferred stays. Otherwise the oldest surviving row
            // auto-promotes — this covers both deleting a preferred name
            // and demoting one without a replacement, so no language is
            // ever stranded. A brand-new language with a single insert
            // elects that insert; several inserts require an explicit mark.
            const finalLanguages = new Set<string>();

            for (const row of survivors) {
              finalLanguages.add(editsById.get(row.id.toString())?.languageTag ?? row.language_tag);
            }

            for (const entry of prepared) {
              finalLanguages.add(entry.languageTag);
            }

            const finalPreferredId = new Map<string, bigint>();
            const insertWinnerLanguages = new Set<string>();
            const pendingInserts = new Map<string, Array<(typeof prepared)[number]>>();

            for (const entry of prepared) {
              if (entry.nameId === null) {
                const list = pendingInserts.get(entry.languageTag) ?? [];

                list.push(entry);
                pendingInserts.set(entry.languageTag, list);
              }
            }

            for (const languageTag of finalLanguages) {
              const winner = upsertWinner.get(languageTag);

              if (winner !== undefined) {
                if (winner.nameId !== null) {
                  finalPreferredId.set(languageTag, winner.nameId);
                } else {
                  // Winner is an insert: no id to record, but the kept
                  // stored preferred below must not claim this language —
                  // the insert takes it, and the language needs a demote.
                  insertWinnerLanguages.add(languageTag);
                }

                continue;
              }

              const kept = survivors.find((row) => {
                const edit = editsById.get(row.id.toString());

                if ((edit?.languageTag ?? row.language_tag) !== languageTag) {
                  return false;
                }

                return edit?.isPreferred ?? row.is_preferred;
              });

              if (kept !== undefined) {
                finalPreferredId.set(languageTag, kept.id);

                continue;
              }

              const survivorsOfLang = survivors.filter((row) => {
                if (
                  (editsById.get(row.id.toString())?.languageTag ?? row.language_tag) !==
                  languageTag
                ) {
                  return false;
                }

                // An explicit demote vetoes this row: oldest-fallback must
                // promote a sibling, never crown the demoted row itself.
                return editsById.get(row.id.toString())?.isPreferred !== false;
              });

              const oldest = survivorsOfLang.toSorted(comparePlaceNameRowsById)[0];

              if (oldest !== undefined) {
                finalPreferredId.set(languageTag, oldest.id);

                continue;
              }

              const inserts = pendingInserts.get(languageTag) ?? [];

              if (inserts.length === 1) {
                continue;
              }

              return yield* new InvalidSearchFilter({
                reason: `language "${languageTag}" adds several names; mark one preferred in the same request`,
              });
            }

            // Clear winner languages first so the partial unique index
            // (place_id, language_tag WHERE is_preferred) never observes
            // two preferred rows mid-transaction.
            const changed = new Set<string>();

            for (const [languageTag, preferredId] of finalPreferredId) {
              const stored = survivors.find(
                (row) => row.language_tag === languageTag && row.is_preferred,
              );

              if (stored === undefined || stored.id !== preferredId) {
                changed.add(languageTag);
              }
            }

            for (const languageTag of insertWinnerLanguages) {
              changed.add(languageTag);
            }

            for (const languageTag of changed) {
              yield* places.demoteNames({ placeId: id, languageTag });
            }

            let upserted = 0;

            for (const entry of prepared) {
              if (entry.nameId !== null) {
                const preferredId = finalPreferredId.get(entry.languageTag);

                let isPreferred: boolean;

                if (preferredId !== undefined && preferredId === entry.nameId) {
                  isPreferred = true;
                } else if (preferredId !== undefined) {
                  isPreferred = false;
                } else {
                  isPreferred = entry.isPreferred ?? false;
                }

                const updated = yield* places.updateName({
                  id: entry.nameId,
                  placeId: id,
                  languageTag: entry.languageTag,
                  name: entry.name,
                  isPreferred,
                  searchKey: entry.searchKey,
                });

                if (updated === null) {
                  return yield* new InvalidPlaceData({
                    reason: `place name "${entry.name}" changed during the request; retry`,
                  });
                }

                upserted += 1;
              }
            }

            for (const entry of prepared) {
              if (entry.nameId === null) {
                const preferredId = finalPreferredId.get(entry.languageTag);

                const isWinnerInsert =
                  upsertWinner.get(entry.languageTag) === entry ||
                  (preferredId === undefined &&
                    (pendingInserts.get(entry.languageTag) ?? []).length === 1);

                yield* places.insertName({
                  placeId: id,
                  languageTag: entry.languageTag,
                  name: entry.name,
                  isPreferred: isWinnerInsert,
                  searchKey: entry.searchKey,
                });

                upserted += 1;
              }
            }

            // Resolution can select an untouched survivor (auto-promoted
            // oldest after a preferred delete/demote, or a keeper whose
            // language was cleared above). Edits and inserts already carry
            // their final flags; only such rows still need a write.
            for (const [, preferredId] of finalPreferredId) {
              if (editsById.has(preferredId.toString())) {
                continue;
              }

              const row = byId.get(preferredId.toString());

              if (row === undefined || row.is_preferred) {
                continue;
              }

              const promoted = yield* places.promoteName({ id: preferredId, placeId: id });

              if (promoted === null) {
                return yield* new InvalidPlaceData({
                  reason: "place name changed during the request; retry",
                });
              }
            }

            let removed = 0;

            for (const nameId of removeIds) {
              const deleted = yield* places.deleteName({ id: nameId, placeId: id });

              removed += deleted === null ? 0 : 1;
            }

            // The place_revisions CHECK vocabulary has no dedicated
            // "names_saved" operation, so the atomic save lands under
            // `name_upserted` with exact upsert/remove counts — no migration
            // needed for this workstream.
            yield* places.insertRevision({
              placeId: id,
              actor: actorLabel(actor),
              operation: "name_upserted",
              summary: `saved ${current.length} place name(s): ${upserted} upserted, ${removed} removed on ${placeId}`,
            });

            return yield* places.namesWithIdsByPlaceIds([id]);
          }),
        ).pipe(
          Effect.catchTag("PersistenceConflict", (failure) =>
            Effect.fail(
              new ConflictingPlace({
                reason: `place name conflicts with an existing record (${failure.constraint ?? "unique constraint"})`,
              }),
            ),
          ),
        );

        return result.map(toNameView);
      });

    const setPlaceParent: PlaceAdminApi["setPlaceParent"] = (placeId, parentPlaceId) =>
      Effect.gen(function* () {
        const actor = yield* requireFoodUpdate;
        const id = yield* checkPlaceId(placeId);
        const parentId = yield* checkPlaceId(parentPlaceId);

        const child = yield* requirePlace(id, placeId);

        yield* requirePlace(parentId, parentPlaceId);
        yield* assertNoPlaceCycle(id, parentId);

        const linked = yield* withTransaction(
          "place-admin/set-parent",
          Effect.gen(function* () {
            const current = yield* places.parentsByPlaceIds([id]);

            if (current.some((edge) => edge.parent_place_id === parentId)) {
              return false;
            }

            const [existingNames, existingEdges] = yield* Effect.all(
              [places.namesByPlaceIds([id]), places.parentsByPlaceIds([id])],
              { concurrency: 2 },
            );

            yield* assertUniqueIdentity(
              id,
              child.kind,
              existingNames.map((row) => row.search_key),
              [...existingEdges.map((edge) => edge.parent_place_id), parentId],
            );
            yield* places.insertParent({ placeId: id, parentPlaceId: parentId });
            yield* places.insertRevision({
              placeId: id,
              actor: actorLabel(actor),
              operation: "parent_linked",
              summary: `linked place ${placeId} under parent ${parentPlaceId}`,
            });

            return true;
          }),
        );

        return { linked };
      });

    const removePlaceParent: PlaceAdminApi["removePlaceParent"] = (placeId, parentPlaceId) =>
      Effect.gen(function* () {
        const actor = yield* requireFoodUpdate;
        const id = yield* checkPlaceId(placeId);
        const parentId = yield* checkPlaceId(parentPlaceId);

        yield* requirePlace(id, placeId);
        yield* requirePlace(parentId, parentPlaceId);

        const removed = yield* withTransaction(
          "place-admin/remove-parent",
          Effect.gen(function* () {
            const deleted = yield* places.deleteParent({ placeId: id, parentPlaceId: parentId });

            if (deleted === null) {
              return false;
            }

            yield* places.insertRevision({
              placeId: id,
              actor: actorLabel(actor),
              operation: "parent_unlinked",
              summary: `unlinked place ${placeId} from parent ${parentPlaceId}`,
            });

            return true;
          }),
        );

        return { removed };
      });

    const resolvePlaceRef: PlaceAdminApi["resolvePlaceRef"] = (ref) =>
      Effect.gen(function* () {
        if ("placeId" in ref) {
          if (!Number.isInteger(ref.placeId) || ref.placeId <= 0) {
            return yield* new PlaceNotFound({ placeId: String(ref.placeId) });
          }

          const record = yield* places.findById(BigInt(ref.placeId));

          if (record === null) {
            return yield* new PlaceNotFound({ placeId: String(ref.placeId) });
          }

          return toPlaceView(record);
        }

        if ("iso" in ref) {
          const upper = ref.iso.trim().toUpperCase();

          if (!ISO_PATTERN.test(upper)) {
            return yield* new PlaceNotFound({ placeId: ref.iso });
          }

          const record = yield* places.findByIso(upper);

          if (record === null) {
            return yield* new PlaceNotFound({ placeId: upper });
          }

          return toPlaceView(record);
        }

        const key = normalizeSearchKey(ref.city);

        if (key.length === 0) {
          return yield* new PlaceNotFound({ placeId: ref.city });
        }

        const scope = ref.parentIso === undefined ? null : ref.parentIso.trim().toUpperCase();

        if (scope !== null && !ISO_PATTERN.test(scope)) {
          return yield* new PlaceNotFound({ placeId: `${ref.city} in ${ref.parentIso}` });
        }

        const query = scope === null ? ref.city : `${ref.city} in ${scope}`;

        const ids = yield* places.searchIds({
          q: key,
          prefix: toPrefixKey(key),
          contains: toContainsKey(key),
          limit: MAX_RESOLVER_CANDIDATES,
        });

        if (ids.length === 0) {
          return yield* new PlaceNotFound({ placeId: query });
        }

        const allNames = yield* places.namesByPlaceIds(ids.map((entry) => entry.id));
        const exact = allNames.filter((row) => row.search_key === key);

        if (exact.length === 0) {
          return yield* new PlaceNotFound({ placeId: query });
        }

        // Preferred names win over non-preferred aliases.
        const preferred = exact.filter((row) => row.is_preferred);
        const tier = preferred.length > 0 ? preferred : exact;

        const candidateIds = [...new Set(tier.map((row) => row.place_id.toString()))].map((raw) =>
          BigInt(raw),
        );

        let scoped = candidateIds;

        if (scope !== null) {
          scoped = [];

          for (const candidate of candidateIds) {
            const chain = yield* places.ancestors(candidate);

            if (chain.some((row) => row.iso3166 !== null && row.iso3166.toUpperCase() === scope)) {
              scoped.push(candidate);
            }
          }

          if (scoped.length === 0) {
            return yield* new PlaceNotFound({ placeId: query });
          }
        }

        if (scoped.length === 1) {
          const only = scoped[0];

          if (only === undefined) {
            return yield* new PlaceNotFound({ placeId: query });
          }

          const record = yield* places.findById(only);

          if (record === null) {
            return yield* new PlaceNotFound({ placeId: query });
          }

          return toPlaceView(record);
        }

        const chains = new Map<string, ReadonlyArray<PlaceAncestorRow>>();

        for (const candidate of scoped) {
          chains.set(candidate.toString(), yield* places.ancestors(candidate));
        }

        const poolIds = [...chains.values()].flatMap((chain) => chain.map((row) => row.id));
        const poolNames = yield* places.namesByPlaceIds(poolIds);
        const poolByPlace = new Map<string, Array<PlaceNameRow>>();

        for (const row of poolNames) {
          const list = poolByPlace.get(row.place_id.toString()) ?? [];

          list.push(row);
          poolByPlace.set(row.place_id.toString(), list);
        }

        const candidates: Array<AmbiguousPlaceCandidate> = scoped.map((candidate) => {
          const chain = chains.get(candidate.toString()) ?? [];
          const self = chain.find((row) => row.id === candidate);

          const ownName =
            pickDisplayName(poolByPlace.get(candidate.toString()) ?? []) ??
            `#${candidate.toString()}`;

          const country = chain.find((row) => row.kind === "country");

          const countryName =
            country === undefined
              ? null
              : (pickDisplayName(poolByPlace.get(country.id.toString()) ?? []) ?? null);

          return {
            id: encodeDbId(candidate),
            name: ownName,
            context:
              countryName === null || countryName === ownName
                ? `${ownName} (${self?.kind ?? "place"})`
                : `${ownName}, ${countryName}`,
          };
        });

        return yield* new AmbiguousPlace({ query, candidates });
      });

    return PlaceAdminService.of({
      listPlaces,
      placeDetail,
      createPlace,
      updatePlace,
      deletePlace,
      upsertPlaceNames,
      removePlaceName,
      savePlaceNames,
      setPlaceParent,
      removePlaceParent,
      resolvePlaceRef,
    });
  }),
);
