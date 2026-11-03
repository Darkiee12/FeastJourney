import { z } from "zod";

import type { RecommendationLocation } from "@/modules/food-discovery/food.schema";
import {
  MEAL_OCCASIONS,
  RECOMMENDATION_MOODS,
  type MealOccasion,
  type RecommendationMood,
} from "@/modules/food-discovery/recommendation.constants";
import type { Messages } from "@/shared/i18n";

/** UI mirror of the shared meal vocabulary; undefined is never a meal. */
export const mealSchema = z.enum(MEAL_OCCASIONS);

/** UI mirror of the shared mood vocabulary; undefined is never a mood. */
export const moodSchema = z.enum(RECOMMENDATION_MOODS);

export type RecRegionMode = "anywhere" | "country" | "precise";

/** Step 1 choice in display order: home region, precise, destination, worldwide. */
export type RegionChoice = "home" | "precise" | "destination" | "worldwide";

/** Where a country value came from: trusted network region or explicit choice. */
export type CountrySource = "detected" | "chosen";

/** Ephemeral precise fix: client memory only, never persisted or logged. */
export interface PreciseFix {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy: number | null;
}

export const MAX_REC_TERM_LENGTH = 100;

export const recCountrySchema = z
  .string()
  .regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/, "country must be an ISO 3166 code");

/**
 * Normalize a possibly messy country value (detection headers, restored
 * drafts) to an uppercase ISO code, or null when it is not one. The quiz
 * UI only ever offers valid codes, so this keeps invalid values from
 * reaching validation and ever surfacing as form errors.
 */
export function sanitizeCountryCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();

  if (normalized === "" || !recCountrySchema.safeParse(normalized).success) {
    return null;
  }

  return normalized;
}

export interface QuizDraft {
  /**
   * Raw unified exclusions text (ingredients to avoid, comma-separated).
   * Single source for the final step: dislikes and former allergy input
   * share one field, one policy, one persistence path.
   */
  readonly excludedRaw: string;
  readonly regionMode: RecRegionMode;
  readonly country: string;
  readonly countrySource: CountrySource | null;
  readonly precise: PreciseFix | null;
  readonly remember: boolean;
  /**
   * Explicitly chosen canonical city (place registry id) with its display
   * label and nearest country ISO hint for the honest wider-pool fallback.
   * Set only through the city chooser; never overwritten by async
   * geolocation. Null means no city choice.
   */
  readonly cityId: string | null;
  readonly cityLabel: string | null;
  readonly cityCountry: string | null;
}

export interface RecommendAnswers {
  readonly meal: MealOccasion;
  /** Canonical unified exclusions (ingredients to avoid). */
  readonly excludedIngredients: ReadonlyArray<string>;
  readonly country: string | undefined;
  readonly location?: RecommendationLocation | undefined;
  readonly mood: RecommendationMood;
  readonly locale: string;
}

export interface RecommendPayload {
  readonly meal: MealOccasion;
  /** Canonical unified exclusions (ingredients to avoid). */
  readonly excludedIngredients: Array<string>;
  /** Legacy country mirror for display; stripped at transport when location is present. */
  readonly country?: string | undefined;
  readonly location?: RecommendationLocation | undefined;
  readonly mood: RecommendationMood;
  readonly locale: string;
  readonly surpriseSeed: number;
}

export interface SurpriseInputs {
  readonly draft: QuizDraft;
  readonly meal: MealOccasion;
  readonly mood: RecommendationMood;
  readonly locale: string;
  readonly surpriseSeed: number;
}

/** Split a comma-separated field into trimmed, deduplicated, non-empty terms. */
export const parseCommaList = (raw: string): Array<string> => {
  const seen = new Set<string>();
  const terms: Array<string> = [];

  for (const part of raw.split(",")) {
    const term = part.trim();

    if (term.length === 0 || seen.has(term)) {
      continue;
    }

    seen.add(term);
    terms.push(term);
  }

  return terms;
};

/** True when any exclusion term exceeds the server's 100-character item limit. */
export const tooLongTerms = (terms: ReadonlyArray<string>): boolean =>
  terms.some((term) => term.length > MAX_REC_TERM_LENGTH);

/** Localized error when any exclusion term exceeds the server item limit. */
export const termLengthError = (excludedRaw: string, copy: Messages): string | null => {
  if (tooLongTerms(parseCommaList(excludedRaw))) {
    return copy.recTermTooLong;
  }

  return null;
};

/** Fill a `{name}` template without casts or string surgery at call sites. */
export const formatTemplate = (template: string, name: string): string =>
  template.replace("{name}", name);

/** Client mirror of the server recommendation enums; undefined means "unfiltered". */
export const buildRecommendPayload = (
  answers: RecommendAnswers & { readonly surpriseSeed?: number },
): RecommendPayload => ({
  meal: answers.meal,
  excludedIngredients: [...answers.excludedIngredients],
  country: answers.country,
  location: answers.location,
  mood: answers.mood,
  locale: answers.locale,
  surpriseSeed: answers.surpriseSeed ?? 0,
});

/**
 * Transport payload: the request schema accepts country XOR location, so the
 * legacy country mirror is dropped whenever the discriminated location is
 * present. Pure and shape-preserving otherwise.
 */
export const toTransportPayload = (payload: RecommendPayload): RecommendPayload =>
  payload.location === undefined ? payload : { ...payload, country: undefined };

/**
 * Derive the discriminated location for a draft. Home region and chosen
 * destination both filter by country (provenance differs for labels only);
 * an explicitly chosen city filters by its canonical place id with the
 * country hint for fallback; precise needs a live fix; anywhere is
 * explicitly worldwide.
 */
export const draftLocation = (draft: QuizDraft): RecommendationLocation | undefined => {
  if (draft.regionMode === "precise") {
    const fix = draft.precise;

    if (fix === null) {
      return undefined;
    }

    return {
      kind: "precise",
      latitude: fix.latitude,
      longitude: fix.longitude,
      accuracy: fix.accuracy,
    };
  }

  if (draft.regionMode === "country") {
    if (draft.cityId !== null && isCityPlaceId(draft.cityId)) {
      const hint = sanitizeCountryCode(draft.cityCountry ?? "");

      if (hint === null) {
        if (draft.cityLabel === null) {
          return { kind: "city", placeId: draft.cityId };
        }

        return { kind: "city", placeId: draft.cityId, label: draft.cityLabel };
      }

      if (draft.cityLabel === null) {
        return { kind: "city", placeId: draft.cityId, country: hint };
      }

      return { kind: "city", placeId: draft.cityId, country: hint, label: draft.cityLabel };
    }

    const normalized = draft.country.trim().toUpperCase();
    const parsed = recCountrySchema.safeParse(normalized);

    if (!parsed.success) {
      return undefined;
    }

    return {
      kind: draft.countrySource === "detected" ? "approx" : "destination",
      country: parsed.data,
    };
  }

  return { kind: "worldwide" };
};

/**
 * Surprise keeps the visitor's current meal, mood, region, and exclusions;
 * only the sense of direction is "surprise". It never reads or writes
 * persisted preferences as a side effect — the draft already carries any
 * saved values via its initializer. The seed rotates the ranked slice so
 * repeated clicks vary; seed 0 keeps the stable deterministic order.
 */
export const buildSurprisePayload = (inputs: SurpriseInputs): RecommendPayload =>
  buildRecommendPayload({
    meal: inputs.meal,
    excludedIngredients: parseCommaList(inputs.draft.excludedRaw),
    country: draftCountryMirror(inputs.draft),
    location: draftLocation(inputs.draft),
    mood: inputs.mood,
    locale: inputs.locale,
    surpriseSeed: inputs.surpriseSeed,
  });

/**
 * Canonical city place id shape: a decimal id string from the place
 * registry. Client-side twin of the server dbId check so drafts fail
 * closed before transport.
 */
export const isCityPlaceId = (value: string): boolean => /^[0-9]+$/.test(value);

/** Validate the region step, returning a localized error or null when it passes. */
export const validateRegion = (
  mode: RecRegionMode,
  country: string,
  copy: Messages,
  precise: PreciseFix | null = null,
  cityId: string | null = null,
): string | null => {
  if (mode === "country") {
    if (cityId !== null && isCityPlaceId(cityId)) {
      return null;
    }

    return isRegionComplete({ ...EMPTY_DRAFT, regionMode: mode, country })
      ? null
      : copy.recCountryError;
  }

  if (mode === "precise") {
    return precise === null ? copy.recError : null;
  }

  return null;
};

/**
 * Provenance of one quiz answer: where the currently displayed value came
 * from. Untouched defaults look unanswered, app-suggested values carry an
 * approximate indicator, opt-in restored values carry a saved label, and
 * anything the visitor tapped or typed this visit renders as an explicit
 * answer. Confirming or changing a suggested/restored value flips it to
 * explicit, restoring the normal style.
 */
export type AnswerOrigin = "untouched" | "suggested" | "restored" | "explicit";

/**
 * Provenance badge copy. Defaults are English fallbacks so stages render
 * honestly before the coordinator wires real i18n keys; pass explicit
 * labels to override. Needed keys (en+vi): a "saved from last visit"
 * label and an "approximate" indicator. Do NOT touch src/shared/i18n.ts
 * from feature branches — the coordinator owns it.
 */
export interface ProvenanceLabels {
  readonly saved: string;
  readonly approximate: string;
}

export const DEFAULT_PROVENANCE_LABELS: ProvenanceLabels = {
  approximate: "Approximate",
  saved: "Saved from last visit",
};

/** Meal/mood origin: only an explicit tap this visit counts as an answer. */
export const flagOriginFor = (touched: boolean): AnswerOrigin =>
  touched ? "explicit" : "untouched";

/**
 * Region origin from the current draft plus how it got there. `touched`
 * wins: any tap or edit this visit makes the value explicit. Otherwise a
 * non-empty country matching the opt-in saved preference is restored, a
 * detected source is app-suggested, and everything else (including the
 * anywhere default and an empty destination) is untouched. A bare default
 * is therefore never presented as saved.
 */
export const regionOriginFor = (input: {
  readonly touched: boolean;
  readonly draft: QuizDraft;
  readonly savedCountry: string | null;
  readonly savedCityId?: string | null | undefined;
}): AnswerOrigin => {
  if (input.touched) {
    return "explicit";
  }

  if (
    input.draft.regionMode === "country" &&
    input.draft.cityId !== null &&
    input.savedCityId !== null &&
    input.savedCityId !== undefined &&
    input.draft.cityId === input.savedCityId
  ) {
    return "restored";
  }

  if (
    input.draft.regionMode === "country" &&
    input.draft.country !== "" &&
    input.savedCountry !== null &&
    input.draft.country.toUpperCase() === input.savedCountry.toUpperCase()
  ) {
    return "restored";
  }

  if (input.draft.countrySource === "detected") {
    return "suggested";
  }

  return "untouched";
};

/**
 * Free-text origin (exclusions box): restored only when the visible text is
 * non-empty and matches the persisted value. Empty text is untouched even
 * when a preference exists, so "no exclusions" is never claimed as saved.
 */
export const textOriginFor = (input: {
  readonly touched: boolean;
  readonly value: string;
  readonly savedValue: string | null;
}): AnswerOrigin => {
  if (input.touched) {
    return "explicit";
  }

  if (input.value !== "" && input.savedValue !== null && input.value === input.savedValue) {
    return "restored";
  }

  return "untouched";
};

/**
 * Copy-free completeness check for one draft snapshot. Home and worldwide
 * are complete by construction; a destination needs a valid ISO country or
 * an explicitly chosen canonical city; precise needs a live fix. Used by the
 * single auto-advance commit site so pointer taps advance only on explicitly
 * complete answers.
 */
export const isRegionComplete = (draft: QuizDraft): boolean => {
  if (draft.regionMode === "country") {
    if (draft.cityId !== null && isCityPlaceId(draft.cityId)) {
      return true;
    }

    return recCountrySchema.safeParse(draft.country.trim().toUpperCase()).success;
  }

  if (draft.regionMode === "precise") {
    return draft.precise !== null;
  }

  return true;
};

/** True when two drafts select the same Step-1 lane, country, and city. */
export const sameRegion = (left: QuizDraft, right: QuizDraft): boolean =>
  left.regionMode === right.regionMode &&
  left.country.toUpperCase() === right.country.toUpperCase() &&
  left.countrySource === right.countrySource &&
  left.cityId === right.cityId;

/**
 * Pure Step-1 lane transition for a radio tap. Home pins the trusted
 * detection (worldwide fallback when detection vanished); precise opens
 * the locator lane with no fix yet (never complete, so never advances);
 * destination opens the catalog selector empty (incomplete until a valid
 * country or city is chosen — any previous city choice is cleared so a
 * stale city can never ride along); worldwide clears everything (complete
 * at once). The caller commits the returned candidate and advances only
 * when it is complete, so async detection and saved prefs — which never
 * flow through here — can never trigger advancement.
 */
export const pickRegionChoice = (
  draft: QuizDraft,
  choice: RegionChoice,
  detected: string | null,
): QuizDraft => {
  if (choice === "home" && detected !== null) {
    return {
      ...draft,
      country: detected,
      countrySource: "detected",
      cityId: null,
      cityLabel: null,
      cityCountry: null,
      precise: null,
      regionMode: "country",
    };
  }

  if (choice === "precise") {
    return {
      ...draft,
      country: "",
      countrySource: null,
      cityId: null,
      cityLabel: null,
      cityCountry: null,
      precise: null,
      regionMode: "precise",
    };
  }

  if (choice === "destination") {
    return {
      ...draft,
      country: "",
      countrySource: null,
      cityId: null,
      cityLabel: null,
      cityCountry: null,
      precise: null,
      regionMode: "country",
    };
  }

  return {
    ...draft,
    country: "",
    countrySource: null,
    cityId: null,
    cityLabel: null,
    cityCountry: null,
    precise: null,
    regionMode: "anywhere",
  };
};

/**
 * Pure destination-selector transition: a valid pick is a chosen country
 * (complete, advances on pointer); clearing back to the placeholder keeps
 * the lane open but incomplete (reveals the selector, never advances).
 * Choosing a country clears any city choice — the two never combine.
 */
export const pickDestinationCountry = (draft: QuizDraft, country: string): QuizDraft => ({
  ...draft,
  country,
  countrySource: country === "" ? null : "chosen",
  cityId: null,
  cityLabel: null,
  cityCountry: null,
  precise: null,
  regionMode: "country",
});

/**
 * Pure city-selector transition: a chosen canonical city (complete,
 * advances on pointer) with its display label and country hint. Clearing
 * (null id) keeps the lane open but incomplete. A city choice clears any
 * country choice — the served scope is the city, with the hint only for
 * the honest wider-pool fallback.
 */
export const pickDestinationCity = (
  draft: QuizDraft,
  city: {
    readonly placeId: string;
    readonly label: string | null;
    readonly country: string | null;
  },
): QuizDraft => ({
  ...draft,
  country: "",
  countrySource: null,
  cityId: city.placeId,
  cityLabel: city.label,
  cityCountry: city.country,
  precise: null,
  regionMode: "country",
});

/**
 * Auto-advance gate for an explicitly committed Step-1 candidate: advance
 * if and only if the NEW snapshot is complete. Evaluate the candidate the
 * visitor just picked — never the pre-update batched state.
 */
export const shouldAutoAdvanceRegion = (candidate: QuizDraft): boolean =>
  isRegionComplete(candidate);

/**
 * Precise-fix arrival: the draft moved from no fix to a live fix while
 * staying on the precise lane. The only advance path for Near-you (never
 * while locating, denied, or unavailable — those keep no fix).
 */
export const didPreciseFixArrive = (previous: QuizDraft, next: QuizDraft): boolean =>
  previous.precise === null && next.precise !== null && next.regionMode === "precise";

/**
 * Choice precedence for the initial region: an explicit journey choice beats
 * a saved opt-in preference, which beats the trusted network region. Never
 * true for untouched defaults, so async detection can never clobber a manual
 * selection.
 */
export const isExplicitRegionChoice = (draft: QuizDraft): boolean => {
  if (draft.regionMode === "precise") {
    return true;
  }

  if (draft.regionMode === "country") {
    return draft.countrySource === "chosen";
  }

  return false;
};

/** Resolve the visible Step 1 choice from draft state and trusted detection. */
export const regionChoiceFor = (draft: QuizDraft, detected: string | null): RegionChoice => {
  if (draft.regionMode === "precise") {
    return "precise";
  }

  if (draft.regionMode === "country") {
    if (draft.countrySource === "detected") {
      return "home";
    }

    if (
      draft.countrySource === null &&
      detected !== null &&
      draft.country.toUpperCase() === detected
    ) {
      return "home";
    }

    return "destination";
  }

  return "worldwide";
};

/** Format a geolocation accuracy in meters; units need no translation. */
export const formatAccuracyM = (accuracy: number): string =>
  `±${Math.round(accuracy).toString()} m`;

/**
 * Precise scope wording now reads from i18n copy (recWhereUsingLocation,
 * recWhereAccuracyNote with a {meters} slot) instead of the interim
 * English fallbacks.
 */

/**
 * Result-scope label for the summary chips, composed from existing copy plus
 * catalog names: approximate home regions explore by name, city choices show
 * the chosen city label, precise fixes show the honest "Near you" scope
 * (never GPS accuracy meters), destinations show the plain country name,
 * worldwide stays unlabeled. City cultural discovery never claims
 * restaurant availability, which the places lookup answers separately.
 * Never claims city precision without a resolved city.
 */
export const scopeLabelFor = (
  input: {
    readonly location?: RecommendationLocation | undefined;
    readonly country?: string | undefined;
  },
  copy: Messages,
  countryOptions: ReadonlyArray<{ readonly code: string; readonly label: string }>,
): string => {
  const nameOf = (code: string): string =>
    countryOptions.find((option) => option.code === code)?.label ?? code;

  const location = input.location;

  if (location !== undefined) {
    switch (location.kind) {
      case "approx":
        return formatTemplate(copy.recWhereExploring, nameOf(location.country));
      case "city":
        if (location.label !== undefined && location.label.trim() !== "") {
          return formatTemplate(copy.recWhereExploring, location.label);
        }

        if (location.country !== undefined) {
          return formatTemplate(copy.recWhereExploring, nameOf(location.country));
        }

        return copy.recWhereAnywhere;
      case "precise":
        return copy.recWhereNearYou;
      case "destination":
        return nameOf(location.country);
      case "worldwide":
        return copy.recWhereAnywhere;
    }
  }

  if (input.country !== undefined) {
    return nameOf(input.country);
  }

  return copy.recWhereAnywhere;
};

const resolveCountry = (mode: RecRegionMode, country: string): string | undefined => {
  if (mode !== "country") {
    return undefined;
  }

  const normalized = country.trim().toUpperCase();
  const parsed = recCountrySchema.safeParse(normalized);

  if (!parsed.success) {
    return undefined;
  }

  return parsed.data;
};

/**
 * Legacy country mirror for a draft: the explicitly chosen country, or the
 * city choice's country hint (kept for restore display alongside the city
 * location). The discriminated city location remains the scoping source;
 * this mirror is coarse display context only.
 */
export const draftCountryMirror = (
  draft: Pick<QuizDraft, "regionMode" | "country" | "cityCountry">,
): string | undefined => {
  const direct = resolveCountry(draft.regionMode, draft.country);

  if (direct !== undefined) {
    return direct;
  }

  if (draft.regionMode !== "country") {
    return undefined;
  }

  return sanitizeCountryCode(draft.cityCountry ?? "") ?? undefined;
};

/**
 * Saved preferences v2: unified ingredient exclusions persist for every
 * guest automatically (no opt-in); the opt-in `remember` flag now governs
 * only the destination (country/city). Coordinates are never persisted.
 *
 * v1 stored `{remember: true, avoid, country?, city?}` with dislikes only.
 * v1 rows migrate forward on read (avoid → excludedIngredients) and the v1
 * key is removed — never silently dropped, never downgraded.
 */
const savedPrefsV2Schema = z.object({
  remember: z.boolean().default(false),
  excludedIngredients: z.array(z.string()).default([]),
  country: recCountrySchema.optional(),
  city: z
    .object({
      placeId: z.string().regex(/^[0-9]+$/),
      label: z.string().max(200).optional(),
      country: recCountrySchema.optional(),
    })
    .optional(),
});

export type SavedRecommendPrefs = z.infer<typeof savedPrefsV2Schema>;

/** Legacy v1 shape: opt-in dislikes only. Read-only; migrated to v2 on read. */
const savedPrefsV1Schema = z.object({
  remember: z.literal(true),
  avoid: z.array(z.string()).default([]),
  country: recCountrySchema.optional(),
  city: z
    .object({
      placeId: z.string().regex(/^[0-9]+$/),
      label: z.string().max(200).optional(),
      country: recCountrySchema.optional(),
    })
    .optional(),
});

const PREFS_KEY = "feastjourney.recommend.prefs.v2";
const LEGACY_PREFS_KEY = "feastjourney.recommend.prefs.v1";

/** Storage key for the versioned recommendation prefs; quiz-flow mirrors hasSaved reads against it. */
export const PREFS_STORAGE_KEY = PREFS_KEY;

export const EMPTY_DRAFT: QuizDraft = {
  excludedRaw: "",
  regionMode: "anywhere",
  country: "",
  countrySource: null,
  precise: null,
  remember: false,
  cityId: null,
  cityLabel: null,
  cityCountry: null,
};

/** Parse one raw storage value; any corruption or schema drift restores nothing. */
export const readSavedPrefs = (read: () => string | null): SavedRecommendPrefs | null => {
  const raw = read();

  if (raw === null) {
    return null;
  }

  try {
    const current = savedPrefsV2Schema.safeParse(JSON.parse(raw));

    if (current.success) {
      return current.data;
    }

    return null;
  } catch {
    return null;
  }
};

/**
 * Legacy v1 migration: reads the old opt-in key once, adopts its dislikes as
 * unified exclusions (same safety semantics — v1 never stored allergies),
 * and removes the v1 key so the migration runs exactly once per device.
 */
export const migrateLegacyPrefs = (
  read: () => string | null,
  remove: () => void,
): SavedRecommendPrefs | null => {
  const raw = read();

  if (raw === null) {
    return null;
  }

  try {
    const legacy = savedPrefsV1Schema.safeParse(JSON.parse(raw));

    if (!legacy.success) {
      return null;
    }

    remove();

    return {
      remember: legacy.data.remember,
      excludedIngredients: legacy.data.avoid,
      country: legacy.data.country,
      city: legacy.data.city,
    };
  } catch {
    return null;
  }
};

/** Read v2 prefs, falling back to a one-time v1 migration. */
export const readSavedPrefsWithMigration = (
  readV2: () => string | null,
  readV1: () => string | null,
  removeV1: () => void,
): SavedRecommendPrefs | null => {
  const rawV2 = readV2();

  if (rawV2 !== null) {
    // Defensive: v2 never writes an `avoid` key, so its presence means
    // legacy v1 data reached this key — migrate it rather than parsing it
    // as v2 (which would silently drop the legacy list). The boundary
    // parse below answers only whether the legacy key exists.
    let legacyPresent = false;

    try {
      legacyPresent = z
        .object({ avoid: z.array(z.unknown()) })
        .safeParse(JSON.parse(rawV2)).success;
    } catch {
      return null;
    }

    if (legacyPresent) {
      const migrated = migrateLegacyPrefs(
        () => rawV2,
        () => {},
      );

      if (migrated !== null) {
        return migrated;
      }
    }

    const current = readSavedPrefs(() => rawV2);

    if (current !== null) {
      return current;
    }
  }

  return migrateLegacyPrefs(readV1, removeV1);
};

export const serializePrefs = (prefs: SavedRecommendPrefs): string => JSON.stringify(prefs);

/** Invoke the storage remover; the caller resets the form separately. */
export const removeSavedPrefs = (remove: () => void): void => {
  remove();
};

/**
 * Preference-lifecycle decisions as pure functions so guest → sign-in →
 * edit → sign-out, account switching, save → Skip, and clear → reload are
 * unit-testable without a DOM. The component owns the React Query cache and
 * storage I/O; these functions own the branching.
 */

export interface PersistedExclusionsInput {
  /** Authenticated member id, or null for guests. */
  readonly userId: string | null;
  /** True once the account prefs query has resolved (success or empty). */
  readonly accountLoaded: boolean;
  /** Loaded account exclusions (null when absent). */
  readonly account: ReadonlyArray<string> | null;
  /** Guest-storage mirror (in-memory copy of the v2 key). */
  readonly guest: ReadonlyArray<string>;
}

/**
 * Which persisted list a submit or Skip should use. Signed-in members with
 * loaded account prefs use the account list; everyone else — including a
 * member whose account prefs are still loading — uses the guest mirror,
 * which is what the visible draft was initialized from.
 */
export const resolvePersistedExclusions = (input: PersistedExclusionsInput): Array<string> => {
  if (input.userId !== null && input.accountLoaded) {
    return [...(input.account ?? [])];
  }

  return [...input.guest];
};

export interface AccountPrefillInput {
  readonly signedIn: boolean;
  /** Member id the draft was already prefilled for (re-arm per account). */
  readonly prefilledForUserId: string | null;
  readonly userId: string | null;
  readonly accountLoaded: boolean;
  readonly excludedTouched: boolean;
  readonly accountNonEmpty: boolean;
}

/**
 * Whether the loaded account prefs may adopt the draft. Exactly one
 * adoption per sign-in: newer user edits (touched draft) and repeat loads
 * never overwrite. An empty account never wipes guest-restored text.
 */
export const needsAccountPrefill = (input: AccountPrefillInput): boolean =>
  input.signedIn &&
  input.prefilledForUserId !== input.userId &&
  input.accountLoaded &&
  !input.excludedTouched &&
  input.accountNonEmpty;

/** Order-insensitive comparison so a reorder never nags for an import. */
export const sameExclusionSet = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  const sortedLeft = [...left].toSorted();
  const sortedRight = [...right].toSorted();

  return sortedLeft.every((term, index) => term === sortedRight[index]);
};

export interface ImportBannerInput {
  readonly signedIn: boolean;
  readonly accountLoaded: boolean;
  readonly dismissed: boolean;
  readonly guest: ReadonlyArray<string>;
  readonly account: ReadonlyArray<string> | null;
}

/**
 * Whether to offer the guest → account import. Never shows for guests or
 * while account prefs are loading, and never nags after an explicit
 * dismissal or when both sides already agree.
 */
export const shouldShowImportBanner = (input: ImportBannerInput): boolean =>
  input.signedIn &&
  input.accountLoaded &&
  !input.dismissed &&
  input.guest.length > 0 &&
  !sameExclusionSet(input.guest, input.account ?? []);

/**
 * Tab-scoped journey snapshot: preserves the in-progress quiz (meal, mood,
 * draft, step, submitted payload, results flag, surprise seed) across dish
 * detail visits within the same tab. In-memory only, never written to disk.
 * A full reload falls back to the persisted guest preferences (exclusions
 * plus opt-in destination) with meal and mood at their defaults.
 */

const journeySnapshotSchema = z.object({
  meal: z.enum(MEAL_OCCASIONS).default("anything"),
  mood: z.enum(RECOMMENDATION_MOODS).default("any"),
  draft: z.object({
    excludedRaw: z.string().max(2000).default(""),
    regionMode: z.enum(["anywhere", "country", "precise"]).default("anywhere"),
    country: z.string().max(12).default(""),
    countrySource: z.enum(["detected", "chosen"]).nullable().default(null),
    cityId: z.string().max(24).nullable().default(null),
    cityLabel: z.string().max(200).nullable().default(null),
    cityCountry: z.string().max(12).nullable().default(null),
    remember: z.boolean().default(false),
  }),
  stepIndex: z.number().int().min(0).max(2).default(0),
  submitted: z
    .object({
      meal: z.enum(MEAL_OCCASIONS),
      excludedIngredients: z.array(z.string().max(100)).max(20),
      country: recCountrySchema.optional(),
      location: z
        .object({
          kind: z.literal("city"),
          placeId: z.string().regex(/^[0-9]+$/),
          country: recCountrySchema.optional(),
          label: z.string().max(200).optional(),
        })
        .optional(),
      mood: z.enum(RECOMMENDATION_MOODS),
      locale: z.string().max(12),
      surpriseSeed: z.number().int().min(0).default(0),
    })
    .nullable()
    .default(null),
  showResults: z.boolean().default(false),
  surpriseSeed: z.number().int().min(0).default(0),
  /** Presentation state: selected carousel slide, restored on tab-back. */
  railIndex: z.number().int().min(0).max(9).default(0),
});

export type JourneySnapshot = z.infer<typeof journeySnapshotSchema>;

// Module-scoped, client-only: the SPA keeps this module alive across
// client-side navigation, so dish detail visits unmounting this section
// restore from here on back-navigation. Server rendering never touches it
// (window guard), so concurrent requests cannot share state.
let journeyCache: JourneySnapshot | null = null;

export const readJourneySnapshot = (): JourneySnapshot | null => {
  if (typeof window === "undefined") {
    return null;
  }

  return journeyCache;
};

export const writeJourneySnapshot = (snapshot: JourneySnapshot): void => {
  if (typeof window === "undefined") {
    return;
  }

  const country = sanitizeCountryCode(snapshot.draft.country);

  // Coarse context only: precise coordinates never enter the journey cache,
  // even though it is memory-only. Restoring a precise choice keeps the mode
  // so the visitor can re-locate with one explicit tap. A chosen city keeps
  // its canonical place id (coarse registry identity, safe to restore).
  journeyCache = {
    ...snapshot,
    draft: {
      excludedRaw: snapshot.draft.excludedRaw,
      regionMode: snapshot.draft.regionMode,
      country: country ?? "",
      countrySource: snapshot.draft.countrySource,
      remember: snapshot.draft.remember,
      cityId:
        snapshot.draft.cityId !== null && isCityPlaceId(snapshot.draft.cityId)
          ? snapshot.draft.cityId
          : null,
      cityLabel: snapshot.draft.cityLabel,
      cityCountry: sanitizeCountryCode(snapshot.draft.cityCountry ?? "") ?? null,
    },
  };
};

export const clearJourneySnapshot = (): void => {
  journeyCache = null;
};

/** Full in-memory journey state the quiz hands to the snapshot builder. */
export interface JourneyWriteModel {
  readonly meal: MealOccasion;
  readonly mood: RecommendationMood;
  readonly draft: QuizDraft;
  readonly stepIndex: number;
  readonly submitted: RecommendPayload | null;
  readonly showResults: boolean;
  readonly surpriseSeed: number;
  /** Presentation state: selected carousel slide (not quiz answers). */
  readonly railIndex?: number | undefined;
}

/**
 * Coarse snapshot builder: precise coordinates never enter the journey
 * cache, even though it is memory-only. A precise draft keeps its mode (the
 * visitor re-locates with one explicit tap); precise results are dropped
 * instead of re-running a stale fix on return, landing back on the quiz.
 * Submitted payloads keep the legacy country mirror for restore display and
 * re-runs, plus the city location (canonical place id, coarse and safe to
 * re-run) — never precise fixes.
 */
export const toCoarseSnapshot = (model: JourneyWriteModel): JourneySnapshot => {
  const draft = {
    excludedRaw: model.draft.excludedRaw,
    regionMode: model.draft.regionMode,
    country: model.draft.country,
    countrySource: model.draft.countrySource,
    remember: model.draft.remember,
    cityId: model.draft.cityId,
    cityLabel: model.draft.cityLabel,
    cityCountry: model.draft.cityCountry,
  };

  if (model.submitted !== null && model.submitted.location?.kind === "precise") {
    return {
      meal: model.meal,
      mood: model.mood,
      draft,
      stepIndex: model.stepIndex,
      submitted: null,
      showResults: false,
      surpriseSeed: model.surpriseSeed,
      railIndex: 0,
    };
  }

  const submittedLocation =
    model.submitted?.location?.kind === "city" ? model.submitted.location : undefined;

  if (model.submitted === null) {
    return {
      meal: model.meal,
      mood: model.mood,
      draft,
      stepIndex: model.stepIndex,
      submitted: null,
      showResults: model.showResults,
      surpriseSeed: model.surpriseSeed,
      railIndex: model.railIndex ?? 0,
    };
  }

  const submittedBase = {
    meal: model.submitted.meal,
    excludedIngredients: model.submitted.excludedIngredients,
    country: model.submitted.country,
    mood: model.submitted.mood,
    locale: model.submitted.locale,
    surpriseSeed: model.submitted.surpriseSeed,
  };

  return {
    meal: model.meal,
    mood: model.mood,
    draft,
    stepIndex: model.stepIndex,
    // Field-by-field: the snapshot never carries precise fixes, only the
    // legacy country mirror plus the coarse city location for restore
    // display and re-runs. The location key is absent unless a city was
    // submitted, so country/worldwide restores keep their legacy shape.
    submitted:
      submittedLocation === undefined
        ? submittedBase
        : { ...submittedBase, location: submittedLocation },
    showResults: model.showResults,
    surpriseSeed: model.surpriseSeed,
    railIndex: model.railIndex ?? 0,
  };
};

/**
 * Pure draft initializer from parsed prefs: unified exclusions always
 * restore (they persist unconditionally); the destination restores only
 * with prior opt-in consent. Meal and mood are per-visit and always start
 * at defaults. A saved canonical city restores with its label and hint,
 * taking precedence over a saved country.
 */
export const draftFromSavedPrefs = (saved: SavedRecommendPrefs | null): QuizDraft => {
  if (saved === null) {
    return EMPTY_DRAFT;
  }

  const excludedRaw = saved.excludedIngredients.join(", ");

  if (saved.remember && saved.city !== undefined) {
    return {
      excludedRaw,
      regionMode: "country",
      country: "",
      countrySource: "chosen",
      cityId: saved.city.placeId,
      cityLabel: saved.city.label ?? null,
      cityCountry: saved.city.country ?? null,
      precise: null,
      remember: true,
    };
  }

  return {
    excludedRaw,
    regionMode: saved.remember && saved.country !== undefined ? "country" : "anywhere",
    country: saved.remember ? (saved.country ?? "") : "",
    countrySource: saved.remember && saved.country !== undefined ? "chosen" : null,
    cityId: null,
    cityLabel: null,
    cityCountry: null,
    precise: null,
    remember: saved.remember,
  };
};

/** Window-backed stored-prefs read with one-time legacy v1 migration. */
export const readStoredPrefs = (): SavedRecommendPrefs | null => {
  if (typeof window === "undefined") {
    return null;
  }

  return readSavedPrefsWithMigration(
    () => window.localStorage.getItem(PREFS_KEY),
    () => window.localStorage.getItem(LEGACY_PREFS_KEY),
    () => window.localStorage.removeItem(LEGACY_PREFS_KEY),
  );
};

/** Lazy useState initializer: window-backed, corruption-proof. */
export const readInitialDraft = (): QuizDraft => {
  if (typeof window === "undefined") {
    return EMPTY_DRAFT;
  }

  return draftFromSavedPrefs(readStoredPrefs());
};

/**
 * Persist guest preferences. Unified exclusions always persist (no opt-in,
 * no per-keystroke writes — call this on submit). The `rememberDestination`
 * flag governs only the destination (country/city); when false, any stored
 * destination is dropped but exclusions are kept. An empty exclusion list
 * with no remembered destination removes the key entirely.
 */
export const persistPrefs = (input: {
  readonly rememberDestination: boolean;
  readonly excludedIngredients: ReadonlyArray<string>;
  readonly country?: string | undefined;
  readonly city?:
    | {
        readonly placeId: string;
        readonly label: string | null;
        readonly country: string | null;
      }
    | undefined;
}): void => {
  if (typeof window === "undefined") {
    return;
  }

  const prefs: SavedRecommendPrefs = {
    remember: input.rememberDestination,
    excludedIngredients: [...input.excludedIngredients],
  };

  if (input.rememberDestination) {
    if (input.country !== undefined) {
      prefs.country = input.country;
    }

    const city = input.city;

    if (city !== undefined) {
      if (city.label === null) {
        if (city.country === null) {
          prefs.city = { placeId: city.placeId };
        } else {
          prefs.city = { placeId: city.placeId, country: city.country };
        }
      } else if (city.country === null) {
        prefs.city = { placeId: city.placeId, label: city.label };
      } else {
        prefs.city = { placeId: city.placeId, label: city.label, country: city.country };
      }
    }
  }

  if (prefs.excludedIngredients.length === 0 && !prefs.remember) {
    window.localStorage.removeItem(PREFS_KEY);

    return;
  }

  window.localStorage.setItem(PREFS_KEY, serializePrefs(prefs));
};

/**
 * POST-but-read-oriented ranking cache: the recommendation POST has no
 * side effects, so identical requests share one QueryClient entry instead
 * of re-firing on every remount. Back-from-dish-detail restores the same
 * list, selected slide (railIndex in the journey snapshot), and prefs with
 * ZERO new Muse calls while the entry is fresh.
 */

/** QueryClient key root for ranked recommendation results. */
export const DISH_RECOMMENDATIONS_KEY = "dish-recommendations";

/** Contract version: bump when the ranking request shape changes. */
export const RECOMMENDATION_CACHE_VERSION = 1;

/** Fresh window: back-navigation within 5 minutes never refires. */
export const RECOMMENDATION_CACHE_STALE_MS = 5 * 60_000;

/** Bounded retention: entries older than 10 minutes are garbage-collected. */
export const RECOMMENDATION_CACHE_GC_MS = 10 * 60_000;

/**
 * Canonical preference normalization for the cache key: lowercase,
 * trimmed, deduplicated, and sorted, so "Pork, pork" and "pork" share one
 * entry. Cosmetic typing differences never cause a second model call.
 */
export const normalizeCacheTerms = (terms: ReadonlyArray<string>): Array<string> => {
  const seen = new Set<string>();

  for (const term of terms) {
    const normalized = term.trim().toLowerCase();

    if (normalized !== "") {
      seen.add(normalized);
    }
  }

  return [...seen].toSorted();
};

/**
 * Coarse geographic scope key. City identity is the canonical place id;
 * country scopes are ISO codes; precise fixes round to 2 decimals (~1.1 km
 * cells) so minor GPS jitter reuses the entry while a materially different
 * location keys differently. No raw coordinates enter the key, and no
 * precise location is ever persisted — this key lives in memory only.
 */
export const geographicScopeKeyFor = (payload: RecommendPayload): string => {
  const location = payload.location;

  if (location === undefined) {
    return payload.country === undefined ? "world" : `country:${payload.country.toUpperCase()}`;
  }

  if (location.kind === "city") {
    return `city:${location.placeId}`;
  }

  if (location.kind === "precise") {
    return `nearby:${location.latitude.toFixed(2)},${location.longitude.toFixed(2)}`;
  }

  if (location.kind === "worldwide") {
    return "world";
  }

  return `country:${location.country.toUpperCase()}`;
};

export interface RecommendationCacheKeyInput {
  /** Per-user isolation: member id when signed in, "guest" otherwise. */
  readonly userIdOrGuest: string;
  readonly locale: string;
  readonly meal: MealOccasion;
  readonly mood: RecommendationMood;
  readonly excludedIngredients: ReadonlyArray<string>;
  readonly cuisine?: string | undefined;
  readonly scopeKey: string;
  readonly surpriseSeed: number;
}

/**
 * Stable QueryClient key for one ranking request. Includes actor identity
 * (per-user isolation), locale (locale change fetches once under the new
 * key — never double-fires), normalized prefs, coarse geo scope, surprise
 * seed, and the contract version (shape changes invalidate old entries).
 */
export const recommendationCacheKey = (
  input: RecommendationCacheKeyInput,
): ReadonlyArray<string | number | ReadonlyArray<string>> => [
  DISH_RECOMMENDATIONS_KEY,
  RECOMMENDATION_CACHE_VERSION,
  input.userIdOrGuest,
  input.locale,
  input.meal,
  input.mood,
  normalizeCacheTerms(input.excludedIngredients),
  input.cuisine ?? "",
  input.scopeKey,
  input.surpriseSeed,
];

/** Build the cache-key input for one submitted transport payload. */
export const cacheKeyInputFor = (
  payload: RecommendPayload,
  userIdOrGuest: string,
): RecommendationCacheKeyInput => ({
  userIdOrGuest,
  locale: payload.locale,
  meal: payload.meal,
  mood: payload.mood,
  excludedIngredients: payload.excludedIngredients,
  scopeKey: geographicScopeKeyFor(payload),
  surpriseSeed: payload.surpriseSeed,
});
