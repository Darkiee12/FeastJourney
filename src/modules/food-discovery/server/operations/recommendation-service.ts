import { Context, Data, Effect, Layer, Match, Option } from "effect";

import type { RecommendationLocation } from "@/modules/food-discovery/food.schema";
import type {
  MealOccasion,
  RecommendationMood,
} from "@/modules/food-discovery/recommendation.constants";
import type { DishCardImage, DishSummary } from "@/modules/food-discovery/server/domain/dish";
import { InvalidLocale } from "@/modules/food-discovery/server/domain/errors";
import { isDbIdString, isLanguageTag } from "@/modules/food-discovery/server/domain/ids";
import {
  asLocalizedName,
  normalizeSearchKey,
  pickDisplayName,
} from "@/modules/food-discovery/server/domain/search";
import { windowForSurprise } from "@/modules/food-discovery/server/domain/surprise-window";
import { toPublishedImage } from "@/modules/food-discovery/server/operations/dish-media-service";
import {
  findNearbyDishCandidates,
  NEARBY_MAX_M,
  type NearbyRecommendationCandidateRow,
} from "@/modules/food-discovery/server/operations/dish-service";
import type {
  DishDescriptionRow,
  DishIngredientRow,
  DishNameRow,
  DishPlaceRow,
  DishPublishedMediaRow,
} from "@/modules/food-discovery/server/repository/dish-relations-repository";
import { IngredientRepository } from "@/modules/food-discovery/server/repository/ingredient-repository";
import type { IngredientNameRow } from "@/modules/food-discovery/server/repository/ingredient-repository";
import type { PlaceNameRow } from "@/modules/food-discovery/server/repository/place-repository";
import dishDescriptionsByDishIds from "@/modules/food-discovery/server/repository/sql/dish-descriptions-by-dish-ids.sql";
import dishIngredientsByDishIds from "@/modules/food-discovery/server/repository/sql/dish-ingredients-by-dish-ids.sql";
import dishMediaPublishedByDishIds from "@/modules/food-discovery/server/repository/sql/dish-media-published-by-dish-ids.sql";
import dishNamesByDishIds from "@/modules/food-discovery/server/repository/sql/dish-names-by-dish-ids.sql";
import dishPlacesByDishIds from "@/modules/food-discovery/server/repository/sql/dish-places-by-dish-ids.sql";
import dishRecommendationCandidatesPlace from "@/modules/food-discovery/server/repository/sql/dish-recommendation-candidates-place.sql";
import dishRecommendationCandidates from "@/modules/food-discovery/server/repository/sql/dish-recommendation-candidates.sql";
import ingredientNamesByIngredientIds from "@/modules/food-discovery/server/repository/sql/ingredient-names-by-ingredient-ids.sql";
import placeFindByIso from "@/modules/food-discovery/server/repository/sql/place-find-by-iso.sql";
import placeNamesByPlaceIds from "@/modules/food-discovery/server/repository/sql/place-names-by-place-ids.sql";
import { Actor } from "@/server/auth/actor";
import { CurrentActor } from "@/server/auth/current-actor";
import type { Database } from "@/server/database/client";
import type { DatabaseError } from "@/server/database/query";
import { runQuery } from "@/server/database/query";
import { RankingConfig, resolveRankingConfig, serverEnv } from "@/server/env";
import {
  MetaClient,
  type MetaAuthError,
  MetaInvalidOutput,
  type MetaPermanentError,
  type MetaRankContext,
  type MetaRateLimited,
  type MetaRequestError,
  type MetaRankCandidate,
  type MuseRankingConfig,
  RankingFailureDisposition,
  dispositionForMetaError,
} from "@/server/integrations/meta-client";

export type RecommendationCandidateRow = (typeof dishRecommendationCandidates)["~reylo"]["element"];

export type CityRecommendationCandidateRow =
  (typeof dishRecommendationCandidatesPlace)["~reylo"]["element"];

/** Which pool actually served a ready result — the honest scope for labels. */
export type RecommendationServedScope = "city" | "country" | "nearby" | "worldwide";

export type RecommendationOutcome = Data.TaggedEnum<{
  ReadyMuse: {
    readonly dishes: ReadonlyArray<DishSummary>;
    readonly warnings: ReadonlyArray<string>;
    readonly ranking: RankingProvenance;
    readonly servedScope: RecommendationServedScope;
  };
  ReadyDeterministic: {
    readonly dishes: ReadonlyArray<DishSummary>;
    readonly warnings: ReadonlyArray<string>;
    readonly ranking: RankingProvenance;
    readonly servedScope: RecommendationServedScope;
  };
  Uncertain: { readonly reasons: ReadonlyArray<string> };
  Empty: { readonly reasons: ReadonlyArray<string> };
}>;

export const RecommendationOutcome = Data.taggedEnum<RecommendationOutcome>();

/**
 * Structured ranking provenance for the wire envelope. Replaces
 * English-sniffing on the client ("AI ranking was..."): the frontend
 * branches on `ranking._tag` instead of warning substrings.
 *
 * - LiveMuse: a signed-in member request ranked by Muse.
 * - DeterministicCatalog: catalog order with no provider attempt (guests,
 *   unconfigured provider, surprise slices, and the zero-dish outcomes).
 * - DegradedMuse: a member request attempted Muse and fell back, with the
 *   typed cause (rate-limited | transient | invalid-output).
 */
export type DegradedCause = "rate-limited" | "transient" | "invalid-output";

export type RankingProvenance = Data.TaggedEnum<{
  LiveMuse: {};
  DeterministicCatalog: {};
  DegradedMuse: { readonly cause: DegradedCause };
}>;

export const RankingProvenance = Data.taggedEnum<RankingProvenance>();

/** Typed operator error: muse was requested but key/model/baseUrl is unusable. */
export class RecommendationMisconfigured extends Data.TaggedError("RecommendationMisconfigured")<{
  readonly reason: string;
}> {}

/** Intermediate provider result before hydration into dish summaries. */
export type MuseRankResult = Data.TaggedEnum<{
  Ranked: { readonly ids: ReadonlyArray<string> };
  Degraded: {
    readonly ids: ReadonlyArray<string>;
    readonly warning: string;
    readonly cause: DegradedCause;
  };
}>;

export const MuseRankResult = Data.taggedEnum<MuseRankResult>();

/**
 * Client-safe wire envelope. The transport returns HTTP 200 with exactly this
 * shape for every outcome; provider/auth/config failures reject instead and
 * surface as HTTP 500. `mode`/`warnings` stay for wire compatibility while
 * `ranking` carries the structured provenance (the single branching source
 * for the frontend). Asserted per-variant in
 * tests/integration/recommendation.test.ts.
 */
export interface RecommendationWireOutcome {
  readonly mode: "ai" | "deterministic" | "uncertain" | "empty";
  readonly dishes: Array<DishSummary>;
  readonly warnings: Array<string>;
  readonly reasons: Array<string>;
  readonly ranking: RankingProvenance;
  /**
   * Which pool actually served a ready result ("city", "country", "nearby",
   * or "worldwide"). Absent for zero-dish outcomes. The client labels the
   * summary from this, never from what it asked for.
   */
  readonly servedScope?: RecommendationServedScope | undefined;
}

/** Exhaustive outcome-to-wire mapping; the transport handler delegates here. */
export const toWireOutcome = (outcome: RecommendationOutcome): RecommendationWireOutcome =>
  RecommendationOutcome.$match(outcome, {
    ReadyMuse: ({ dishes, warnings, ranking, servedScope }) => ({
      mode: "ai" as const,
      dishes: [...dishes],
      warnings: [...warnings],
      reasons: [],
      ranking,
      servedScope,
    }),
    ReadyDeterministic: ({ dishes, warnings, ranking, servedScope }) => ({
      mode: "deterministic" as const,
      dishes: [...dishes],
      warnings: [...warnings],
      reasons: [],
      ranking,
      servedScope,
    }),
    // No ranking was performed for zero-dish outcomes; the catalog basis is
    // the honest provenance (no AI attempt, nothing to degrade from).
    Uncertain: ({ reasons }) => ({
      mode: "uncertain" as const,
      dishes: [],
      warnings: [],
      reasons: [...reasons],
      ranking: RankingProvenance.DeterministicCatalog(),
    }),
    Empty: ({ reasons }) => ({
      mode: "empty" as const,
      dishes: [],
      warnings: [],
      reasons: [...reasons],
      ranking: RankingProvenance.DeterministicCatalog(),
    }),
  });

export interface RecommendDishesInput {
  readonly meal: MealOccasion;
  readonly avoid: ReadonlyArray<string>;
  readonly allergies: ReadonlyArray<string>;
  readonly cuisine?: string | undefined;
  readonly country?: string | undefined;
  readonly location?: RecommendationLocation | undefined;
  readonly mood: RecommendationMood;
  readonly locale: string;
  readonly surpriseSeed: number;
}

/**
 * Server-side location scope resolved from the validated request. The
 * request schema guarantees `country` and `location` never arrive together;
 * legacy country-only payloads resolve to the country scope, and no scope
 * at all means worldwide. Coordinates never leave this scope object: ranking
 * input, logs, and wire output only ever see the coarse derivations below.
 * A city resolves to its canonical place id with an optional country hint
 * for the honest wider-pool fallback.
 */
export type LocationScope = Data.TaggedEnum<{
  Country: { readonly country: string };
  City: { readonly placeId: string; readonly countryHint: string | null };
  Precise: {
    readonly latitude: number;
    readonly longitude: number;
    readonly accuracy: number | null;
  };
  Worldwide: {};
}>;

export const LocationScope = Data.taggedEnum<LocationScope>();

export const resolveLocationScope = (
  input: Pick<RecommendDishesInput, "country" | "location">,
): LocationScope => {
  const location = input.location;

  if (location === undefined) {
    if (input.country === undefined) {
      return LocationScope.Worldwide();
    }

    return LocationScope.Country({ country: input.country });
  }

  if (location.kind === "approx" || location.kind === "destination") {
    return LocationScope.Country({ country: location.country });
  }

  if (location.kind === "city") {
    return LocationScope.City({
      placeId: location.placeId,
      countryHint: location.country ?? null,
    });
  }

  if (location.kind === "precise") {
    return LocationScope.Precise({
      accuracy: location.accuracy ?? null,
      latitude: location.latitude,
      longitude: location.longitude,
    });
  }

  return LocationScope.Worldwide();
};

/** Country filter implied by a scope, if any. City, precise, and worldwide imply none. */
export const scopeCountryOf = (
  input: Pick<RecommendDishesInput, "country" | "location">,
): string | null =>
  LocationScope.$match(resolveLocationScope(input), {
    Country: ({ country }) => country,
    City: () => null,
    Precise: () => null,
    Worldwide: () => null,
  });

/**
 * Coarse, log-safe location fields. Coordinates are deliberately absent:
 * server logs record only which scope ran and (for precise) the bounded
 * search cap, never visitor coordinates. The Record shape is forced by
 * Effect's annotateLogs API, not an application map.
 */
export const locationLogFields = (
  input: Pick<RecommendDishesInput, "country" | "location">,
): Record<string, string | number> =>
  LocationScope.$match(resolveLocationScope(input), {
    Country: ({ country }) => ({ locationKind: "country", country }),
    City: () => ({ locationKind: "city" }),
    Precise: () => ({ locationKind: "precise", searchRadiusMaxM: NEARBY_MAX_M }),
    Worldwide: () => ({ locationKind: "worldwide" }),
  });

/**
 * Ranking-model context. Carries occasion, mood, and an optional cuisine or
 * country label — never coordinates, never venue claims. The model only
 * re-ranks the candidate rows it is given.
 */
export const toRankContext = (input: RecommendDishesInput): MetaRankContext => ({
  cuisineOrRegion: input.cuisine ?? scopeCountryOf(input),
  mood: input.mood,
  occasion: input.meal,
});

export type RecommendationError =
  | InvalidLocale
  | DatabaseError
  | RecommendationMisconfigured
  | MetaAuthError
  | MetaPermanentError;

export class RecommendationService extends Context.Service<
  RecommendationService,
  {
    readonly recommend: (
      input: RecommendDishesInput,
    ) => Effect.Effect<
      RecommendationOutcome,
      RecommendationError,
      Database | IngredientRepository | MetaClient
    >;
  }
>()("feastjourney/food-discovery/RecommendationService") {}

// The catalog has no verified-completeness representation for ingredients, so
// allergy claims can never be proven; any allergy input refuses to rank.
const INCOMPLETE_DATA_EXPLANATION =
  "Ingredient data may be incomplete and carries no verified-completeness guarantee.";

const AI_NOT_CONFIGURED_NOTE = "Deterministic mode: AI ranking is not configured.";

const unixSeconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const compareIds = (left: string, right: string): number => {
  const leftId = BigInt(left);
  const rightId = BigInt(right);

  if (leftId < rightId) {
    return -1;
  }

  return leftId > rightId ? 1 : 0;
};

const nonNullStrings = (values: ReadonlyArray<string | null>): Array<string> =>
  values.filter((value): value is string => value !== null);

/**
 * Semantic card assembly, not a mechanical DTO copy: selects the localized
 * card fields out of the wider ranking projection (which also carries
 * description + ingredient names for the model), derives lastUpdate, and
 * records the absence of regional display data explicitly instead of
 * fabricating it. Row shape stays Reylo-inferred; this function only
 * projects it into the published DishSummary contract.
 */
/**
 * Semantic card assembly without relations: the ranking projection already
 * carries the localized display name and English fallback. Relation reads
 * (media, native names, descriptions, ingredients, places) happen in
 * `enrichRows` as bounded batch reads over the final ranked slice only.
 */
const toSummary = (row: RecommendationCandidateRow): DishSummary => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  englishName: row.englishName ?? undefined,
  regionNames: [],
  categorySlugs: nonNullStrings(row.categories),
  updatedAt: row.updatedAt,
  lastUpdate: unixSeconds(row.updatedAt),
});

const groupRowsByDish = <Row>(
  rows: ReadonlyArray<Row>,
  dishId: (row: Row) => bigint,
): ReadonlyMap<string, Array<Row>> => {
  const groups = new Map<string, Array<Row>>();

  for (const row of rows) {
    const key = dishId(row).toString();
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, [row]);
    } else {
      existing.push(row);
    }
  }

  return groups;
};

const MAX_CARD_INGREDIENTS = 6;

/**
 * Primary published image for a recommendation card: first by sort_order
 * from the published + ready projection, with generated delivery URL +
 * responsive srcSet and alt/attribution/focal preserved. Legacy license is
 * carried for older card readers; anything without projectable bytes
 * resolves to null so the card renders its placeholder.
 */
const imageFor = (
  media: ReadonlyArray<DishPublishedMediaRow> | undefined,
  fallbackName: string,
): DishCardImage | null => {
  const first = media?.[0];

  if (first === undefined) {
    return null;
  }

  const published = toPublishedImage(first);

  if (published === null) {
    return null;
  }

  return {
    ...published,
    alt: published.alt ?? fallbackName,
    license: first.license ?? null,
  };
};

interface NativeName {
  readonly name: string | undefined;
  readonly languageTag: string | undefined;
}

const nativeNameFor = (
  names: ReadonlyArray<DishNameRow> | undefined,
  displayName: string | undefined,
): NativeName => {
  const native = names?.find((entry) => entry.name_kind === "native");

  if (native === undefined || native.name === displayName) {
    return { languageTag: undefined, name: undefined };
  }

  return { languageTag: native.language_tag, name: native.name };
};

interface CardDescription {
  readonly description: string | null;
  readonly language: string | null;
}

const descriptionFor = (
  descriptions: ReadonlyArray<DishDescriptionRow> | undefined,
  locale: string,
): CardDescription => {
  if (descriptions === undefined || descriptions.length === 0) {
    return { description: null, language: null };
  }

  const picked =
    descriptions.find((entry) => entry.language_tag === locale) ??
    descriptions.find((entry) => entry.language_tag === "en") ??
    descriptions[0];

  if (picked === undefined) {
    return { description: null, language: null };
  }

  return {
    description: picked.description ?? picked.summary ?? null,
    language: picked.language_tag,
  };
};

/**
 * Image-led card enrichment over the final ranked slice: one bounded batch
 * read per relation (media, names, descriptions, ingredients, ingredient
 * names, places, place names), no per-card fetch, no invented content.
 * Missing relations stay absent so the card renders its placeholder.
 */
const enrichRows = (
  rows: ReadonlyArray<RecommendationCandidateRow>,
  base: ReadonlyArray<DishSummary>,
  locale: string,
): Effect.Effect<ReadonlyArray<DishSummary>, DatabaseError, Database> =>
  Effect.gen(function* () {
    if (rows.length === 0) {
      return base;
    }

    const ids: Array<bigint> = [];

    for (const row of rows) {
      if (isDbIdString(row.id)) {
        ids.push(BigInt(row.id));
      }
    }

    if (ids.length === 0) {
      return base;
    }

    const [mediaRows, nameRows, descriptionRows, dishIngredientRows, dishPlaceRows] =
      yield* Effect.all(
        [
          runQuery("dish/media-published-by-ids", (sql) =>
            dishMediaPublishedByDishIds.run(sql, { ids: [...ids] }),
          ),
          runQuery("dish/names-by-ids", (sql) => dishNamesByDishIds.run(sql, { ids: [...ids] })),
          runQuery("dish/descriptions-by-ids", (sql) =>
            dishDescriptionsByDishIds.run(sql, { ids: [...ids] }),
          ),
          runQuery("dish/ingredients-by-ids", (sql) =>
            dishIngredientsByDishIds.run(sql, { ids: [...ids] }),
          ),
          runQuery("dish/places-by-ids", (sql) => dishPlacesByDishIds.run(sql, { ids: [...ids] })),
        ] as const,
        { concurrency: "unbounded" },
      );

    const mediaByDish = groupRowsByDish<DishPublishedMediaRow>(mediaRows, (row) =>
      BigInt(row.dish_id),
    );

    const namesByDish = groupRowsByDish<DishNameRow>(nameRows, (row) => row.dish_id);

    const descriptionsByDish = groupRowsByDish<DishDescriptionRow>(
      descriptionRows,
      (row) => row.dish_id,
    );

    const dishIngredientsByDish = groupRowsByDish<DishIngredientRow>(
      dishIngredientRows,
      (row) => row.dish_id,
    );

    const dishPlacesByDish = groupRowsByDish<DishPlaceRow>(dishPlaceRows, (row) => row.dish_id);

    const ingredientIds = [
      ...new Set(
        [...dishIngredientsByDish.values()].flatMap((entries) =>
          entries.map((entry) => entry.ingredient_id),
        ),
      ),
    ];

    const placeIds = [
      ...new Set(
        [...dishPlacesByDish.values()].flatMap((entries) => entries.map((entry) => entry.place_id)),
      ),
    ];

    const [ingredientNameRows, placeNameRows] = yield* Effect.all(
      [
        ingredientIds.length > 0
          ? runQuery("ingredient/names-by-ids", (sql) =>
              ingredientNamesByIngredientIds.run(sql, { ids: ingredientIds }),
            )
          : // SAFETY: empty batch input stays empty; the row type only guides the empty array.
            Effect.succeed([] as ReadonlyArray<IngredientNameRow>),
        placeIds.length > 0
          ? runQuery("place/names-by-ids", (sql) =>
              placeNamesByPlaceIds.run(sql, { ids: placeIds }),
            )
          : // SAFETY: empty batch input stays empty; the row type only guides the empty array.
            Effect.succeed([] as ReadonlyArray<PlaceNameRow>),
      ] as const,
      { concurrency: "unbounded" },
    );

    const ingredientNamesByIngredient = groupRowsByDish<IngredientNameRow>(
      ingredientNameRows,
      (row) => row.ingredient_id,
    );

    const placeNamesByPlace = groupRowsByDish<PlaceNameRow>(placeNameRows, (row) => row.place_id);

    return base.map((summary) => {
      const names = namesByDish.get(summary.id);

      const native = nativeNameFor(names, summary.name);

      const dishIngredients = (dishIngredientsByDish.get(summary.id) ?? []).slice(
        0,
        MAX_CARD_INGREDIENTS,
      );

      const described = descriptionFor(descriptionsByDish.get(summary.id), locale);

      const regionNames: Array<string> = [];

      for (const place of dishPlacesByDish.get(summary.id) ?? []) {
        const labels = (placeNamesByPlace.get(place.place_id.toString()) ?? []).map(
          asLocalizedName,
        );

        const picked = pickDisplayName(labels, locale);

        if (picked !== undefined && !regionNames.includes(picked.name)) {
          regionNames.push(picked.name);
        }
      }

      return {
        ...summary,
        description: described.description,
        descriptionLanguage: described.language,
        image: imageFor(mediaByDish.get(summary.id), summary.name ?? summary.slug),
        ingredients: dishIngredients.map((entry) => {
          const labels = (
            ingredientNamesByIngredient.get(entry.ingredient_id.toString()) ?? []
          ).map(asLocalizedName);

          return {
            name: pickDisplayName(labels, locale)?.name,
            role: entry.role,
          };
        }),
        nativeName: native.name,
        nativeLanguageTag: native.languageTag,
        regionNames,
      };
    });
  });

const validateRankedIds = (
  ids: ReadonlyArray<string>,
  candidates: ReadonlyArray<RecommendationCandidateRow>,
  outputLimit: number,
): Effect.Effect<ReadonlyArray<string>, MetaInvalidOutput> =>
  Effect.gen(function* () {
    if (ids.length === 0) {
      return yield* new MetaInvalidOutput({ reason: "Meta ranking was empty" });
    }

    if (ids.length > outputLimit) {
      return yield* new MetaInvalidOutput({
        reason: `Meta ranking returned ${ids.length} dishes (limit ${outputLimit})`,
      });
    }

    const known = new Set(candidates.map((candidate) => candidate.id));
    const seen = new Set<string>();

    for (const id of ids) {
      if (!known.has(id)) {
        return yield* new MetaInvalidOutput({
          reason: "Meta ranking contained an unknown dish id",
        });
      }

      if (seen.has(id)) {
        return yield* new MetaInvalidOutput({
          reason: "Meta ranking contained duplicate ids",
        });
      }

      seen.add(id);
    }

    return ids;
  });

// Local relevance order. Mood-free by design: no catalog signal encodes
// mood suitability, so mood must not change this order (asserted in
// tests). Cuisine match outranks meal-category match, then id ASC keeps
// the order stable across seed changes. Mirrors the SQL ORDER BY so the
// candidate window and the final slice agree.
const scoreCandidate = (
  candidate: RecommendationCandidateRow,
  input: RecommendDishesInput,
): number => {
  const mealSlug = input.meal === "anything" ? null : input.meal;
  let score = 1;

  if (input.cuisine !== undefined && nonNullStrings(candidate.cuisines).includes(input.cuisine)) {
    score += 2;
  }

  if (mealSlug !== null && nonNullStrings(candidate.categories).includes(mealSlug)) {
    score += 1;
  }

  return score;
};

const rankAllDeterministic = (
  candidates: ReadonlyArray<RecommendationCandidateRow>,
  input: RecommendDishesInput,
): Array<RecommendationCandidateRow> => {
  const scored = candidates.map((candidate) => ({
    candidate,
    score: scoreCandidate(candidate, input),
  }));

  scored.sort(
    (left, right) => right.score - left.score || compareIds(left.candidate.id, right.candidate.id),
  );

  return scored.map((entry) => entry.candidate);
};

/**
 * Precise-scope order: nearest curated association first, then the same
 * cuisine/meal/id order as the country scope. Distance comes from the
 * PostGIS candidate query; unknown distances sort last.
 */
const rankPreciseDeterministic = (
  candidates: ReadonlyArray<NearbyRecommendationCandidateRow>,
  input: RecommendDishesInput,
): Array<RecommendationCandidateRow> => {
  const scored = candidates.map((candidate) => ({
    candidate,
    distanceM: candidate.nearbyDistanceM ?? Number.POSITIVE_INFINITY,
    score: scoreCandidate(candidate, input),
  }));

  scored.sort(
    (left, right) =>
      left.distanceM - right.distanceM ||
      right.score - left.score ||
      compareIds(left.candidate.id, right.candidate.id),
  );

  return scored.map((entry) => entry.candidate);
};

// Auth and permanent failures are observable: error log with status only (no
// keys/headers/prompts) and a loud failure that the server-fn transport
// surfaces as HTTP 500, never a silent deterministic downgrade.
const failLoudly = (
  config: MuseRankingConfig,
  error: MetaAuthError | MetaPermanentError,
): Effect.Effect<never, MetaAuthError | MetaPermanentError> =>
  Effect.logError("Recommendation ranking failed").pipe(
    Effect.annotateLogs({
      backend: "muse",
      modelId: config.modelId,
      failure: error._tag,
      status: error.status,
    }),
    Effect.andThen(Effect.fail(error)),
  );

// 429 cannot propagate Retry-After through the server-fn transport:
// returned Responses keep only allowlisted transport headers and
// Retry-After is stripped, so pretending to return 429 would lie.
// Degrade to deterministic order with a rate-limit warning instead.
// 5xx, timeouts, network failures, and invalid structured output
// degrade the same way with the generic unavailable warning. The warning
// text stays the single branding source downstream; the typed `cause`
// travels alongside so the wire envelope never needs English-sniffing.
const causeForDegraded = (
  error: MetaRateLimited | MetaRequestError | MetaInvalidOutput,
): DegradedCause =>
  Match.value(error).pipe(
    Match.tag("MetaRateLimited", () => "rate-limited" as const),
    Match.tag("MetaRequestError", () => "transient" as const),
    Match.tag("MetaInvalidOutput", () => "invalid-output" as const),
    Match.exhaustive,
  );

const degradeToDeterministic = (
  config: MuseRankingConfig,
  deterministicIds: ReadonlyArray<string>,
  error: MetaRateLimited | MetaRequestError | MetaInvalidOutput,
): Effect.Effect<MuseRankResult> =>
  RankingFailureDisposition.$match(dispositionForMetaError(error), {
    // The classification table maps these three tags to Fallback; Fail here
    // would mean table and handler routing drifted, so die loudly.
    Fail: () => Effect.die(`Ranking disposition drift for ${error._tag}`),
    Fallback: ({ warning }) =>
      Effect.logWarning("Recommendation ranking degraded").pipe(
        Effect.annotateLogs({
          backend: "muse",
          modelId: config.modelId,
          failure: error._tag,
          fallbackReason: warning,
        }),
        Effect.andThen(
          Effect.succeed(
            MuseRankResult.Degraded({
              ids: deterministicIds,
              warning,
              cause: causeForDegraded(error),
            }),
          ),
        ),
      ),
  });

/**
 * Provider input bound: Muse re-ranks the first 10 deterministic
 * candidates, never the whole pool. The reasoning model burns ~1k tokens
 * ranking 3 dishes; feeding it 30-60 candidates routinely blows the 15s
 * budget (timeout → transient fallback) or truncates the strict JSON
 * (invalid-output fallback). Deterministic scoring already ordered the
 * pool, so the model only needs room to reorder — not to search. Exported
 * pure so the bound is unit-testable.
 */
export const MUSE_RANK_INPUT_LIMIT = 10;

export const museRankInput = <Row>(sortedAll: ReadonlyArray<Row>): ReadonlyArray<Row> =>
  sortedAll.slice(0, MUSE_RANK_INPUT_LIMIT);

const rankWithMuse = (
  candidates: ReadonlyArray<RecommendationCandidateRow>,
  input: RecommendDishesInput,
  config: MuseRankingConfig,
  deterministicIds: ReadonlyArray<string>,
  outputLimit: number,
): Effect.Effect<MuseRankResult, MetaAuthError | MetaPermanentError, MetaClient> => {
  const rankInput: Array<MetaRankCandidate> = candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    cuisines: nonNullStrings(candidate.cuisines),
    categories: nonNullStrings(candidate.categories),
    description: candidate.description,
  }));

  return Effect.flatMap(
    Effect.flatMap(MetaClient, (client) =>
      client.rank(rankInput, toRankContext(input), config).pipe(
        Effect.annotateLogs({
          backend: "muse",
          modelId: config.modelId,
          candidateCount: candidates.length,
        }),
      ),
    ),
    (ids) => validateRankedIds(ids, candidates, outputLimit),
  ).pipe(
    Effect.map((ids) => MuseRankResult.Ranked({ ids })),
    Effect.catchTags({
      MetaAuthError: (error) => failLoudly(config, error),
      MetaPermanentError: (error) => failLoudly(config, error),
      MetaRateLimited: (error) => degradeToDeterministic(config, deterministicIds, error),
      MetaRequestError: (error) => degradeToDeterministic(config, deterministicIds, error),
      MetaInvalidOutput: (error) => degradeToDeterministic(config, deterministicIds, error),
    }),
  );
};

interface RankingLimits {
  readonly candidateLimit: number;
  readonly outputLimit: number;
}

// Surprise windowing lives in the domain layer (`surprise-window.ts`) so the
// size matrix is unit-testable without a database.
const SURPRISE_NOTE = "Surprise variety applied: showing a different slice of the eligible pool.";

// Guests never reach the provider even when one is configured: the honest
// note names catalog order and the member-only upgrade without reusing the
// "AI ranking was..." degraded marker (that prefix is reserved for a failed
// member attempt the frontend must explain differently).
const GUEST_DETERMINISTIC_NOTE =
  "Deterministic mode: showing catalog order. Sign in for AI-ranked picks.";

/** Accuracy above this is too coarse to call nearby; the client warns and the server widens honestly. */
const POOR_ACCURACY_M = 1_000;

const finishRecommendations = (
  input: RecommendDishesInput,
  sortedAll: ReadonlyArray<RecommendationCandidateRow>,
  warnings: ReadonlyArray<string>,
  limits: RankingLimits,
  muse: MuseRankingConfig | null,
  guestGated: boolean,
  servedScope: RecommendationServedScope,
): Effect.Effect<RecommendationOutcome, RecommendationError, Database | MetaClient> =>
  Effect.gen(function* () {
    const deterministicTop = windowForSurprise(sortedAll, input.surpriseSeed, limits.outputLimit);
    const deterministicIds = deterministicTop.map((candidate) => candidate.id);

    yield* Effect.logInfo("Recommendation candidates resolved").pipe(
      Effect.annotateLogs({
        backend: muse === null || input.surpriseSeed > 0 ? "deterministic" : "muse",
        candidateCount: sortedAll.length,
        returnedCount: deterministicTop.length,
        ...locationLogFields(input),
      }),
    );

    // Surprise bypasses the provider even when one is configured: the point
    // is deterministic pool variety at no model cost, stated honestly in the
    // warnings. The standard path below always runs with seed 0.
    if (muse === null || input.surpriseSeed > 0) {
      const dishes = yield* enrichRows(
        deterministicTop,
        deterministicTop.map((candidate) => toSummary(candidate)),
        input.locale,
      );

      if (input.surpriseSeed > 0) {
        return RecommendationOutcome.ReadyDeterministic({
          dishes,
          warnings: [...warnings, SURPRISE_NOTE],
          ranking: RankingProvenance.DeterministicCatalog(),
          servedScope,
        });
      }

      if (guestGated) {
        return RecommendationOutcome.ReadyDeterministic({
          dishes,
          warnings: [...warnings, GUEST_DETERMINISTIC_NOTE],
          ranking: RankingProvenance.DeterministicCatalog(),
          servedScope,
        });
      }

      return RecommendationOutcome.ReadyDeterministic({
        dishes,
        warnings: [...warnings, AI_NOT_CONFIGURED_NOTE],
        ranking: RankingProvenance.DeterministicCatalog(),
        servedScope,
      });
    }

    // Muse re-ranks the deterministic head only (first 10), never the
    // whole pool — see museRankInput. Membership is validated against
    // exactly what was sent.
    const rankInput = museRankInput(sortedAll);

    const ranked = yield* rankWithMuse(
      rankInput,
      input,
      muse,
      deterministicIds,
      limits.outputLimit,
    );

    const byId = new Map(sortedAll.map((candidate) => [candidate.id, candidate] as const));

    const rankedIds = MuseRankResult.$match(ranked, {
      Ranked: ({ ids }) => ids,
      Degraded: ({ ids }) => ids,
    });

    const rankedRows: Array<RecommendationCandidateRow> = [];

    for (const id of rankedIds) {
      const row = byId.get(id);

      if (row !== undefined) {
        rankedRows.push(row);
      }
    }

    const dishes = yield* enrichRows(
      rankedRows,
      rankedRows.map((row) => toSummary(row)),
      input.locale,
    );

    return MuseRankResult.$match(ranked, {
      Ranked: () =>
        RecommendationOutcome.ReadyMuse({
          dishes,
          warnings: [...warnings],
          ranking: RankingProvenance.LiveMuse(),
          servedScope,
        }),
      Degraded: ({ warning, cause }) =>
        RecommendationOutcome.ReadyDeterministic({
          dishes,
          warnings: [...warnings, warning],
          ranking: RankingProvenance.DegradedMuse({ cause }),
          servedScope,
        }),
    });
  });

const serveCountryCandidates = (
  input: RecommendDishesInput,
  warnings: ReadonlyArray<string>,
  excluded: ReadonlySet<bigint>,
  limits: RankingLimits,
  muse: MuseRankingConfig | null,
  guestGated: boolean,
  servedScope: RecommendationServedScope,
): Effect.Effect<RecommendationOutcome, RecommendationError, Database | MetaClient> =>
  Effect.gen(function* () {
    const candidates = yield* runQuery("dish/recommendation-candidates", (sql) =>
      dishRecommendationCandidates.run(sql, {
        cuisine: input.cuisine ?? null,
        country: scopeCountryOf(input),
        excluded_ids: [...excluded],
        locale: input.locale,
        meal: input.meal,
        limit: limits.candidateLimit,
      }),
    );

    if (candidates.length === 0) {
      return RecommendationOutcome.Empty({
        reasons: ["No published dishes match the current filters."],
      });
    }

    return yield* finishRecommendations(
      input,
      rankAllDeterministic(candidates, input),
      warnings,
      limits,
      muse,
      guestGated,
      servedScope,
    );
  });

/**
 * City-scoped recommendation selection: dishes associated with the canonical
 * city subtree first. When the city pool is empty, fall back honestly — to
 * the country hint pool when one is known, then to an honest empty outcome
 * (never a silent worldwide scan, never a guessed city). The served scope
 * travels with the outcome so the client labels exactly what it got.
 */
/**
 * Display name of a country ISO in the request locale for honest fallback
 * warnings. Falls back to the raw ISO code when the registry has no name —
 * the same convention as the client choosers, never invented geography.
 */
const countryDisplayName = (
  country: string,
  locale: string,
): Effect.Effect<string, DatabaseError, Database> =>
  Effect.gen(function* () {
    const found = yield* runQuery("place/find-by-iso", (sql) =>
      placeFindByIso.run(sql, { iso: country }),
    );

    if (found === null) {
      return country;
    }

    const names = yield* runQuery("place/names-by-ids", (sql) =>
      placeNamesByPlaceIds.run(sql, { ids: [found.id] }),
    );

    const picked = pickDisplayName(names.map(asLocalizedName), locale);

    return picked?.name ?? country;
  });

const serveCityCandidates = (
  scope: { readonly placeId: string; readonly countryHint: string | null },
  input: RecommendDishesInput,
  warnings: ReadonlyArray<string>,
  excluded: ReadonlySet<bigint>,
  limits: RankingLimits,
  muse: MuseRankingConfig | null,
  guestGated: boolean,
): Effect.Effect<RecommendationOutcome, RecommendationError, Database | MetaClient> =>
  Effect.gen(function* () {
    if (!isDbIdString(scope.placeId)) {
      return RecommendationOutcome.Empty({
        reasons: ["No published dishes match the current filters."],
      });
    }

    const candidates: ReadonlyArray<RecommendationCandidateRow> = yield* runQuery(
      "dish/recommendation-candidates-place",
      (sql) =>
        dishRecommendationCandidatesPlace.run(sql, {
          place_id: BigInt(scope.placeId),
          cuisine: input.cuisine ?? null,
          excluded_ids: [...excluded],
          locale: input.locale,
          meal: input.meal,
          limit: limits.candidateLimit,
        }),
    );

    if (candidates.length > 0) {
      return yield* finishRecommendations(
        input,
        rankAllDeterministic(candidates, input),
        warnings,
        limits,
        muse,
        guestGated,
        "city",
      );
    }

    // Empty city pool falls back honestly: first the country hint pool when
    // one is known, then worldwide. The served scope travels with the
    // outcome so the client labels exactly what it got — never the city.
    if (scope.countryHint !== null) {
      const countryInput = {
        ...input,
        location: { kind: "destination", country: scope.countryHint } as const,
      };

      const countryCandidates: ReadonlyArray<RecommendationCandidateRow> = yield* runQuery(
        "dish/recommendation-candidates",
        (sql) =>
          dishRecommendationCandidates.run(sql, {
            cuisine: input.cuisine ?? null,
            country: scope.countryHint,
            excluded_ids: [...excluded],
            locale: input.locale,
            meal: input.meal,
            limit: limits.candidateLimit,
          }),
      );

      if (countryCandidates.length > 0) {
        const countryName = yield* countryDisplayName(scope.countryHint, input.locale);

        return yield* finishRecommendations(
          countryInput,
          rankAllDeterministic(countryCandidates, countryInput),
          [
            ...warnings,
            `No dishes from this city yet — showing dishes from across ${countryName} instead.`,
          ],
          limits,
          muse,
          guestGated,
          "country",
        );
      }
    }

    return yield* serveCountryCandidates(
      { ...input, location: { kind: "worldwide" } },
      [...warnings, "No dishes from this city or country yet — showing worldwide dishes instead."],
      excluded,
      limits,
      muse,
      guestGated,
      "worldwide",
    );
  });

const serveRecommendations = (
  input: RecommendDishesInput,
  warnings: ReadonlyArray<string>,
  excluded: ReadonlySet<bigint>,
  limits: RankingLimits,
  muse: MuseRankingConfig | null,
  guestGated: boolean,
): Effect.Effect<RecommendationOutcome, RecommendationError, Database | MetaClient> => {
  const scope = resolveLocationScope(input);

  return LocationScope.$match(scope, {
    Precise: (precise) =>
      Effect.gen(function* () {
        const nearby = yield* findNearbyDishCandidates({
          cuisine: input.cuisine ?? null,
          excludedIds: [...excluded],
          latitude: precise.latitude,
          limit: limits.candidateLimit,
          locale: input.locale,
          longitude: precise.longitude,
          meal: input.meal,
        });

        if (nearby.rows.length === 0) {
          return RecommendationOutcome.Empty({
            reasons: [
              `No published dishes mapped near your location (searched within ${(nearby.searchedM / 1000).toString()} km).`,
              "Try a chosen destination or the worldwide catalog instead.",
            ],
          });
        }

        const sortedAll = rankPreciseDeterministic(nearby.rows, input);

        const scopedWarnings =
          precise.accuracy !== null && precise.accuracy > POOR_ACCURACY_M
            ? [
                ...warnings,
                `Location accuracy is coarse (±${Math.round(precise.accuracy).toString()} m); nearby results cover a wider area.`,
              ]
            : warnings;

        return yield* finishRecommendations(
          input,
          sortedAll,
          scopedWarnings,
          limits,
          muse,
          guestGated,
          "nearby",
        );
      }),
    City: (city) => serveCityCandidates(city, input, warnings, excluded, limits, muse, guestGated),
    Country: () =>
      serveCountryCandidates(input, warnings, excluded, limits, muse, guestGated, "country"),
    Worldwide: () =>
      serveCountryCandidates(input, warnings, excluded, limits, muse, guestGated, "worldwide"),
  });
};

export const RecommendationServiceLive = Layer.effect(
  RecommendationService,
  Effect.gen(function* () {
    const ingredients = yield* IngredientRepository;

    const resolveExclusionId = (
      term: string,
      locale: string,
    ): Effect.Effect<bigint | null, DatabaseError, Database> =>
      Effect.gen(function* () {
        const key = normalizeSearchKey(term);

        if (key.length === 0) {
          return null;
        }

        const primary = yield* ingredients.resolveByKey(key, locale, 1);
        const direct = primary[0]?.ingredientId;

        if (direct !== undefined) {
          return direct;
        }

        if (locale === "en") {
          return null;
        }

        const fallback = yield* ingredients.resolveByKey(key, "en", 1);

        return fallback[0]?.ingredientId ?? null;
      });

    const recommend = (
      input: RecommendDishesInput,
    ): Effect.Effect<
      RecommendationOutcome,
      RecommendationError,
      Database | IngredientRepository | MetaClient
    > =>
      Effect.gen(function* () {
        if (!isLanguageTag(input.locale)) {
          return yield* new InvalidLocale({ locale: input.locale });
        }

        if (input.allergies.length > 0) {
          return RecommendationOutcome.Uncertain({
            reasons: [
              ...input.allergies.map(
                (term) =>
                  `Cannot verify dish safety for allergy "${term}"; refusing to rank without complete exclusion data.`,
              ),
              INCOMPLETE_DATA_EXPLANATION,
            ],
          });
        }

        const warnings: Array<string> = [];
        const excluded = new Set<bigint>();

        for (const term of input.avoid) {
          const resolved = yield* resolveExclusionId(term, input.locale);

          if (resolved === null) {
            warnings.push(`Ignored unknown dislike "${term}".`);
          } else {
            excluded.add(resolved);
          }
        }

        const ranking = resolveRankingConfig(serverEnv());

        // Member-only Muse: guests always take the deterministic path even
        // when a provider is configured, so unauthenticated traffic can never
        // spend model budget. A missing CurrentActor (direct service use
        // without a request scope) is fail-closed to guest. Misconfiguration
        // stays loud for every actor: an operator error must surface, never
        // hide behind deterministic order.
        const current = yield* Effect.serviceOption(CurrentActor);

        const isGuest =
          Option.isNone(current) ||
          Actor.$match(current.value, {
            Guest: () => true,
            Member: () => false,
          });

        return yield* RankingConfig.$match(ranking, {
          Misconfigured: ({ reason }) =>
            Effect.logError("Recommendation ranking misconfigured").pipe(
              Effect.annotateLogs({ backend: "muse", reason }),
              Effect.andThen(Effect.fail(new RecommendationMisconfigured({ reason }))),
            ),
          Deterministic: (config) =>
            serveRecommendations(input, warnings, excluded, config, null, false),
          Muse: (config) => {
            if (isGuest) {
              return serveRecommendations(input, warnings, excluded, config, null, true);
            }

            return serveRecommendations(input, warnings, excluded, config, config, false);
          },
        });
      });

    return RecommendationService.of({ recommend });
  }),
);
