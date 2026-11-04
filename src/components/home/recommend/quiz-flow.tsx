import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Match } from "effect";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  MapPinIcon,
  SkipForwardIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { DishCarousel } from "@/components/dish/dish-carousel";
import { useMobileHomeOptional } from "@/components/home/mobile/mobile-home-context";
import { presenceForSnapshot } from "@/components/home/recommend/agent-progress";
import { useIsMaxMd } from "@/components/home/recommend/quiz-drawer";
import {
  buildRecommendPayload,
  buildSurprisePayload,
  cacheKeyInputFor,
  clearJourneySnapshot,
  DISH_RECOMMENDATIONS_KEY,
  draftCountryMirror,
  draftLocation,
  EMPTY_DRAFT,
  formatTemplate,
  geographicScopeKeyFor,
  isCityPlaceId,
  isExplicitRegionChoice,
  needsAccountPrefill,
  normalizeCacheTerms,
  parseCommaList,
  persistPrefs,
  PREFS_STORAGE_KEY,
  readInitialDraft,
  readJourneySnapshot,
  readStoredPrefs,
  RECOMMENDATION_CACHE_GC_MS,
  RECOMMENDATION_CACHE_STALE_MS,
  recommendationCacheKey,
  regionOriginFor,
  removeSavedPrefs,
  resolvePersistedExclusions,
  sanitizeCountryCode,
  shouldShowImportBanner,
  termLengthError,
  textOriginFor,
  toCoarseSnapshot,
  toTransportPayload,
  validateRegion,
  writeJourneySnapshot,
  type AnswerOrigin,
  type JourneySnapshot,
  type QuizDraft,
  type RecommendPayload,
  type SavedRecommendPrefs,
} from "@/components/home/recommend/quiz-model";
import {
  AvoidStep,
  CravingStep,
  WhereStep,
  type CountryOption,
} from "@/components/home/recommend/quiz-stages";
import {
  AiExplanationCard,
  cleanReasonForDisplay,
  QuizError,
  rankingVariantFor,
  ResultWarnings,
  SelectedDishReason,
} from "@/components/home/recommend/quiz-status";
import { RecommendationRail } from "@/components/home/recommend/recommendation-rail";
import {
  ResultsExplanationSkeleton,
  ResultsLoadingSkeleton,
} from "@/components/home/recommend/results-loading";
import { SidebarPrefsCard, YourPicksCard } from "@/components/home/recommend/results-sidebar";
import { useAgentProgress } from "@/components/home/recommend/use-agent-progress";
import { usePreciseLocation } from "@/components/home/recommend/use-precise-location";
import { listCountriesFn, recommendDishesFn } from "@/modules/food-discovery/food.functions";
import { getQuizRegionFn } from "@/modules/food-discovery/quiz.functions";
import type {
  MealOccasion,
  RecommendationMood,
} from "@/modules/food-discovery/recommendation.constants";
import { useFavoriteStatus } from "@/modules/user/components/save-dish-button";
import { getFoodPreferencesFn, saveFoodPreferencesFn } from "@/modules/user/profile.functions";
import { messagesFor, type Messages } from "@/shared/i18n";

const rootRoute = getRouteApi("__root__");

const QUIZ_STEPS = 3;

type RecommendResult = Awaited<ReturnType<typeof recommendDishesFn>>;

const stepQuestion = (step: number, copy: Messages): string => {
  if (step === 0) {
    return copy.recWhereLegend;
  }

  if (step === 1) {
    return copy.recCravingLegend;
  }

  return copy.recAvoidTitle;
};

/**
 * Homepage recommendation quiz: a 3-step journey (where, what craving,
 * anything to avoid) replacing the old 5-step wizard. One persistent outer
 * card keeps the frame stable across steps; inner stages remount with the
 * shared 240ms enter animation and never scroll the page. Pointer clicks
 * auto-advance completed answers; keyboard and assistive-tech users advance
 * explicitly via Continue. Results collapse the old review page into a
 * compact editable summary with per-chip adjustment.
 */
export function RecommendSection() {
  const { lang } = rootRoute.useSearch();
  const { session } = rootRoute.useRouteContext();
  const copy = messagesFor(lang);

  const [journey] = useState<JourneySnapshot | null>(readJourneySnapshot);

  const [savedInitial] = useState<SavedRecommendPrefs | null>(() => readStoredPrefs());

  const [initial] = useState(() => {
    if (journey?.draft === undefined) {
      const fresh = readInitialDraft();

      // Fresh mounts are never "explicit": a draft matching the opt-in saved
      // prefs renders with restored provenance until the visitor confirms or
      // changes it; async detection keeps its suggested provenance.
      return {
        draft: fresh,
        excludedTouched: false,
        mealTouched: false,
        moodTouched: false,
        regionTouched: false,
      };
    }

    // Tab-back journey restores are in-progress answers from this visit, so
    // anything already chosen counts as touched; detection-sourced regions
    // keep suggested provenance through regionOriginFor.
    const restored: QuizDraft = { ...EMPTY_DRAFT, ...journey.draft, precise: null };

    return {
      draft: restored,
      excludedTouched: restored.excludedRaw !== "",
      mealTouched: journey.meal !== "anything",
      moodTouched: journey.mood !== "any",
      regionTouched: isExplicitRegionChoice(restored),
    };
  });

  const [stepIndex, setStepIndex] = useState<number>(journey?.stepIndex ?? 0);
  const [showResults, setShowResults] = useState<boolean>(journey?.showResults ?? false);
  const [draft, setDraft] = useState<QuizDraft>(initial.draft);
  const [regionTouched, setRegionTouched] = useState<boolean>(initial.regionTouched);
  const [mealTouched, setMealTouched] = useState<boolean>(initial.mealTouched);
  const [moodTouched, setMoodTouched] = useState<boolean>(initial.moodTouched);
  const [excludedTouched, setExcludedTouched] = useState<boolean>(initial.excludedTouched);
  const explicitRegionRef = useRef(initial.regionTouched);
  const precise = usePreciseLocation();

  /** Region edits are always explicit and must never be clobbered by async detection. */
  const updateRegionDraft = (next: QuizDraft): void => {
    explicitRegionRef.current = true;
    setRegionTouched(true);
    // A stale step error (e.g. "choose a country") never survives a new
    // region choice: validation re-runs on the next Continue instead.
    setStepError(null);
    setDraft(next);
  };

  /** Meal quick-picks are explicit answers; advancement is decided by the stage. */
  const pickMeal = (next: MealOccasion): void => {
    setMealTouched(true);
    setMeal(next);
  };

  /** Mood is optional refinement; it never advances on its own. */
  const pickMood = (next: RecommendationMood): void => {
    setMoodTouched(true);
    setMood(next);
  };

  /** Exclusion edits are explicit; provenance flips from restored to normal style. */
  const updateExclusionsDraft = (next: QuizDraft): void => {
    setExcludedTouched(true);
    setDraft(next);
  };

  const [meal, setMeal] = useState<MealOccasion>(journey?.meal ?? "anything");
  const [mood, setMood] = useState<RecommendationMood>(journey?.mood ?? "any");
  const [stepError, setStepError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<RecommendPayload | null>(journey?.submitted ?? null);
  const [confirmClear, setConfirmClear] = useState<boolean>(false);
  const [surpriseSeed, setSurpriseSeed] = useState<number>(journey?.surpriseSeed ?? 0);
  /**
   * Guest save-sheet visibility, reported up from the nested sheet inside
   * the results carousel. While true the quiz drawer defers its Escape
   * handling so one keypress closes only the topmost layer. Reset whenever
   * the drawer closes (the sheet unmounts with it).
   */
  const [saveSheetOpen, setSaveSheetOpen] = useState<boolean>(false);
  const mobile = useMobileHomeOptional();
  const embeddedMobile = mobile !== null;
  // Legacy standalone mounts (tests/other routes) keep viewport detection;
  // route mounts are split by MobileHome/DesktopHome so context presence is
  // the authoritative presentation signal and only one quiz tree mounts.
  const legacyIsMobile = useIsMaxMd();
  const isMobile = embeddedMobile || legacyIsMobile;

  const drawerOpen = embeddedMobile
    ? mobile.state.mode === "quiz" || mobile.state.mode === "results"
    : false;

  const [hasSaved, setHasSaved] = useState<boolean>(() => savedInitial !== null);

  useEffect(() => {
    mobile?.setNestedDialogOpen(saveSheetOpen);
  }, [mobile, saveSheetOpen]);

  useEffect(() => {
    if (mobile === null) return;

    if (showResults && mobile.state.mode === "quiz") {
      mobile.showResults();
    }

    if (!showResults && mobile.state.mode === "results") {
      mobile.openQuiz();
    }
  }, [mobile, showResults]);

  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const drawerHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const mobileBodyRef = useRef<HTMLDivElement | null>(null);
  const skipInitialFocusRef = useRef(true);

  const regionQuery = useQuery({
    queryKey: ["geo", "quiz-region"],
    queryFn: () => getQuizRegionFn(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });

  // Detection comes from IP-derived server headers (Cloudflare) or a dev
  // override — both untrusted strings, so only a valid uppercase ISO code
  // is ever offered as the detected region. Anything else behaves as
  // "no detection", never as a form error.
  const detectedCountry = sanitizeCountryCode(regionQuery.data?.country ?? "");

  const countries = useQuery({
    queryKey: ["catalog", "countries", lang],
    queryFn: () => listCountriesFn({ data: { locale: lang } }),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const countryOptions = useMemo<ReadonlyArray<CountryOption>>(
    () =>
      (countries.data ?? [])
        .flatMap((entry) =>
          entry.iso3166 === null
            ? []
            : [{ code: entry.iso3166, label: entry.displayName ?? entry.iso3166 }],
        )
        .toSorted((left, right) => left.label.localeCompare(right.label)),
    [countries.data],
  );

  const detectedName =
    detectedCountry === null
      ? null
      : (countryOptions.find((option) => option.code === detectedCountry)?.label ??
        detectedCountry);

  const userId = session.status === "signed-in" ? session.user.id : null;
  const queryClient = useQueryClient();
  const userIdOrGuest = userId ?? "guest";

  // Presentation reset key: one entry per canonical request (actor +
  // coarse geo scope + prefs + locale + seed), so a new request — including
  // an account switch or scope change with otherwise identical answers —
  // always reopens on the first slide instead of inheriting a stale index.
  // New Muse reasons can never surface under a previous request's position.
  const outcomeKey =
    submitted === null
      ? "none"
      : [
          userIdOrGuest,
          geographicScopeKeyFor(toTransportPayload(submitted)),
          submitted.locale,
          submitted.meal,
          submitted.mood,
          submitted.cuisine ?? "",
          ...normalizeCacheTerms(submitted.excludedIngredients),
          submitted.surpriseSeed,
        ].join(":");

  /**
   * POST-but-read-oriented ranking cache: the recommendation POST has no
   * side effects, so one QueryClient entry per canonical request replaces
   * the old remount-mutate. Back-from-dish-detail restores the same list
   * with ZERO new Muse calls while fresh (5 min stale, 10 min bounded GC,
   * no refetch on window focus, no remount duplicate). Explicit Refresh /
   * Try-again refetch; prefs, identity, locale, scope, or seed changes key
   * differently and fetch exactly once. Per-user isolation via the actor id
   * in the key.
   */
  const submittedKey =
    submitted !== null && showResults
      ? recommendationCacheKey(cacheKeyInputFor(toTransportPayload(submitted), userIdOrGuest))
      : null;

  const resultsQuery = useQuery({
    queryKey: submittedKey ?? [DISH_RECOMMENDATIONS_KEY, "idle", lang, userIdOrGuest],
    queryFn: () => {
      if (submitted === null) {
        throw new Error("Recommendation query ran without a submitted payload");
      }

      return recommendDishesFn({ data: toTransportPayload(submitted) });
    },
    enabled: submittedKey !== null,
    staleTime: RECOMMENDATION_CACHE_STALE_MS,
    gcTime: RECOMMENDATION_CACHE_GC_MS,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  // Adapter preserving the outcome shape the render paths read: data is
  // visible only while results are shown, so disabling the query on
  // back-to-quiz can never flash a stale list.
  const recommend = {
    data: showResults ? (resultsQuery.data ?? null) : null,
    isPending: submittedKey !== null && (resultsQuery.isPending || resultsQuery.isFetching),
    isError: submittedKey !== null && resultsQuery.isError,
    refetch: resultsQuery.refetch,
  };

  /**
   * Agentic progress stream (workstream C consumer). Active only while a
   * fresh request is pending with no cached outcome: back-navigation cache
   * hits and quiz-phase renders pass `null` and never open a stream. No
   * opener is wired yet — the streaming transport endpoint is owned by the
   * transport workstream — so this stays idle and the neutral skeleton
   * renders, with zero extra requests. Passing the opener later is the
   * only change needed to light up live presence.
   */
  const streamRequestId =
    showResults && submitted !== null && recommend.isPending ? outcomeKey : null;

  const agentProgress = useAgentProgress(streamRequestId);

  /** Guest-storage mirror of persisted exclusions; guest submits write through here. Signed-in submits write the account instead and leave this copy independent for explicit import. */
  const [guestExclusions, setGuestExclusions] = useState<ReadonlyArray<string>>(
    () => savedInitial?.excludedIngredients ?? [],
  );

  const [accountSaveError, setAccountSaveError] = useState<string | null>(null);
  const [importDismissed, setImportDismissed] = useState<boolean>(false);

  /**
   * Signed-in account prefs, keyed by member id so one member's answers can
   * never surface for another. Disabled for guests: they persist to device
   * storage only.
   */
  // TQueryFnData is pinned explicitly: oxlint's type model cannot see
  // through the server-function generics (same as the sibling prefs tests),
  // while tsc resolves the identical shape with no errors.
  const accountPrefsQuery = useQuery<{ readonly excludedIngredients: Array<string> } | null>({
    queryKey: ["user", "food-preferences", userId ?? "signed-out"],
    queryFn: () => getFoodPreferencesFn(),
    enabled: userId !== null,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const accountSave = useMutation({
    // Transport is snake_case per the user module convention; the read path
    // already maps back to camelCase.
    mutationFn: (excluded: Array<string>) =>
      saveFoodPreferencesFn({ data: { excluded_ingredients: excluded } }),
  });

  /** Fire-and-forget account save; a failure surfaces an inline retry only.
   * On success the account-scoped cache is updated so Skip, the import
   * banner, and later submits all observe the saved values (never stale). */
  const saveAccountPrefs = (excluded: ReadonlyArray<string>): void => {
    if (userId === null) {
      return;
    }

    const memberId = userId;
    const next = [...excluded];

    accountSave.mutate(next, {
      onSuccess: () => {
        setAccountSaveError(null);
        queryClient.setQueryData(["user", "food-preferences", memberId], {
          excludedIngredients: next,
        });
      },
      onError: () => {
        setAccountSaveError(copy.recError);
      },
    });
  };

  /**
   * Persisted exclusions source of truth: the loaded account prefs when
   * signed in, otherwise guest storage. Delegates to the pure resolver so
   * the branching is unit-tested (see quiz-prefs-lifecycle tests).
   */
  const persistedExclusions = (): Array<string> =>
    resolvePersistedExclusions({
      userId,
      accountLoaded: accountPrefsQuery.data !== undefined,
      account: accountPrefsQuery.data?.excludedIngredients ?? null,
      guest: guestExclusions,
    });

  /** Adopt the guest-storage exclusions into the draft and save them to the account. */
  const importGuestPrefs = (): void => {
    const guest = [...guestExclusions];
    setDraft({ ...draft, excludedRaw: guest.join(", ") });
    setExcludedTouched(true);

    if (userId !== null) {
      const memberId = userId;

      accountSave.mutate(guest, {
        onSuccess: () => {
          setAccountSaveError(null);
          queryClient.setQueryData(["user", "food-preferences", memberId], {
            excludedIngredients: guest,
          });
          setImportDismissed(true);
        },
        onError: () => {
          // Stay visible so Import doubles as the retry; the adopted
          // draft values are preserved regardless.
          setAccountSaveError(copy.recError);
        },
      });
    } else {
      setImportDismissed(true);
    }
  };

  /** Retry a failed account save with the currently drafted terms. */
  const retryAccountSave = (): void => {
    if (userId === null) {
      return;
    }

    saveAccountPrefs(parseCommaList(draft.excludedRaw));
  };

  const previousLangRef = useRef(lang);

  // Switching language while results are visible re-runs the submitted
  // search in the new locale instead of showing stale-language dishes. The
  // relocalized payload keys a NEW cache entry, so exactly one fetch fires
  // (never a remount-style duplicate); the lang guard keeps unrelated state
  // updates from re-firing the search.
  useEffect(() => {
    if (previousLangRef.current === lang) {
      return;
    }

    previousLangRef.current = lang;
    setStepError(null);

    if (submitted !== null && showResults) {
      setSubmitted({ ...submitted, locale: lang });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, submitted, showResults]);

  // Trusted approximate region: applies only while the visitor has made no
  // explicit region choice (no saved preference, no journey choice, no manual
  // edit). The functional update double-guards so async detection can never
  // overwrite a manual selection, and it never advances the step.
  useEffect(() => {
    if (explicitRegionRef.current) {
      return;
    }

    const trusted = sanitizeCountryCode(regionQuery.data?.country ?? "");

    if (trusted === null) {
      return;
    }

    setDraft((previous) => {
      if (
        isExplicitRegionChoice(previous) ||
        previous.regionMode !== "anywhere" ||
        previous.country !== ""
      ) {
        return previous;
      }

      return { ...previous, regionMode: "country", country: trusted, countrySource: "detected" };
    });
  }, [regionQuery.data]);

  // Precise fixes land only on an explicitly chosen precise lane; a fix that
  // arrives after the visitor moved on is dropped, never written over the
  // new selection.
  useEffect(() => {
    if (precise.status !== "success" || precise.fix === null) {
      return;
    }

    const fix = precise.fix;

    setDraft((previous) => {
      if (previous.regionMode !== "precise") {
        return previous;
      }

      return {
        ...previous,
        precise: { accuracy: fix.accuracy, latitude: fix.latitude, longitude: fix.longitude },
      };
    });
  }, [precise.status, precise.fix]);

  // Leaving the precise lane clears the locator so a return starts idle;
  // re-locating is always one explicit tap.
  useEffect(() => {
    if (draft.regionMode !== "precise" && precise.status !== "idle") {
      precise.reset();
    }
    // `precise.reset` is a stable callback; `precise.status` covers the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.regionMode, precise.status]);

  /**
   * Signed-in prefill: the first account-prefs load adopts the member's
   * saved exclusions, but ONLY when the draft is still pristine (no
   * explicit edits this visit). Guest-restored text is pristine, so the
   * account wins as source of truth and the import banner offers the
   * guest values back. An empty account never wipes guest-restored text.
   */
  const prefilledAccountRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !needsAccountPrefill({
        signedIn: userId !== null,
        prefilledForUserId: prefilledAccountRef.current,
        userId,
        accountLoaded: accountPrefsQuery.data !== undefined,
        excludedTouched,
        accountNonEmpty: (accountPrefsQuery.data?.excludedIngredients.length ?? 0) > 0,
      })
    ) {
      return;
    }

    prefilledAccountRef.current = userId;

    const account = accountPrefsQuery.data?.excludedIngredients ?? [];
    setDraft((previous) => ({ ...previous, excludedRaw: account.join(", ") }));
  }, [userId, accountPrefsQuery.data, excludedTouched]);

  /**
   * Account transitions: a new sign-in re-arms the prefill and the import
   * banner; a sign-out clears the in-memory account prefs AND the member's
   * cached recommendation entries (per-user isolation: the member key can
   * never serve the guest, and prefs/identity changes invalidate). Account
   * values are never written to guest storage, and guest storage is never
   * cleared — the in-progress draft is preserved untouched.
   */
  const previousUserIdRef = useRef<string | null>(userId);
  useEffect(() => {
    const previous = previousUserIdRef.current;
    previousUserIdRef.current = userId;

    if (previous === userId) {
      return;
    }

    setImportDismissed(false);
    prefilledAccountRef.current = null;

    if (previous !== null && userId === null) {
      queryClient.removeQueries({ queryKey: ["user", "food-preferences"] });
      queryClient.removeQueries({ queryKey: [DISH_RECOMMENDATIONS_KEY] });
    }
  }, [userId, queryClient]);

  // Deep links are handled by MobileHome (context owner) on mobile and by
  // normal document anchors on desktop; no window-event coordination here.

  // Predictable focus: each step and the results heading receive focus on
  // entry (without scrolling), so keyboard and screen-reader users land on
  // the question. The initial mount keeps natural focus.
  useEffect(() => {
    if (skipInitialFocusRef.current) {
      skipInitialFocusRef.current = false;

      return;
    }

    stepHeadingRef.current?.focus({ preventScroll: true });
  }, [stepIndex, showResults]);

  // Drawer mirror of the desktop focus move: the drawer owns its own
  // heading (the desktop one is unmounted on mobile), focused without
  // scrolling the page behind the sheet.
  useEffect(() => {
    if (drawerOpen && isMobile) {
      drawerHeadingRef.current?.focus({ preventScroll: true });
    }
  }, [stepIndex, showResults, drawerOpen, isMobile]);

  // Results entry always starts at the top of the drawer body: moving from
  // the final quiz step to results resets the internal scroll position
  // without moving the page or interrupting carousel navigation.
  useEffect(() => {
    if (showResults && drawerOpen && isMobile) {
      mobileBodyRef.current?.scrollTo({ top: 0 });
    }
  }, [showResults, drawerOpen, isMobile]);

  const startSearch = (payload: RecommendPayload, remember: boolean): void => {
    const transport = toTransportPayload(payload);
    const excluded = [...transport.excludedIngredients];

    // Persistence is source-separated: guests write versioned localStorage
    // only; signed-in submissions write only the member's account prefs.
    // Account values must never mirror into guest storage (the guest copy
    // stays independent for explicit import), and guest writes must never
    // run for members.
    if (userId === null) {
      persistPrefs({
        rememberDestination: remember,
        excludedIngredients: excluded,
        country: transport.country,
        city:
          draft.cityId !== null && isCityPlaceId(draft.cityId)
            ? { placeId: draft.cityId, label: draft.cityLabel, country: draft.cityCountry }
            : undefined,
      });
      setGuestExclusions(excluded);
    } else {
      // Signed-in account save never blocks the recommendation: the dishes
      // still load from the submitted terms; a save failure only surfaces an
      // inline retry while the form input is preserved untouched.
      saveAccountPrefs(excluded);
    }

    setHasSaved(remember || excluded.length > 0);
    setSubmitted(payload);
    setStepError(null);
    setShowResults(true);
    // The results query fetches on the new key (or serves the cache when
    // this exact request already ran) — no manual mutate, no duplicate.
  };

  const currentPayload = (seed: number): RecommendPayload =>
    buildSurprisePayload({
      draft,
      meal,
      mood,
      locale: lang,
      surpriseSeed: seed,
    });

  /**
   * Shared step validation for Continue and pointer auto-advance: the answer
   * must be complete before leaving. Auto-advance call sites only fire on
   * already-complete answers; this is the keyboard/assistive-tech path's
   * guard and the defensive backstop.
   */
  /**
   * Step validation. The candidate defaults to the render-scope draft —
   * fresh for every post-render caller (Continue buttons, fix-arrival
   * effects). `commit` passes its just-picked candidate explicitly because
   * the state update has not committed yet within the same tick.
   */
  const tryAdvance = (candidate: QuizDraft = draft): void => {
    if (stepIndex === 0) {
      const regionError = validateRegion(
        candidate.regionMode,
        candidate.country,
        copy,
        candidate.precise,
        candidate.cityId,
      );

      if (regionError !== null) {
        setStepError(regionError);

        return;
      }
    }

    setStepError(null);
    setStepIndex(stepIndex + 1);
  };

  const goBack = (): void => {
    setStepError(null);
    setStepIndex(stepIndex - 1);
  };

  const findDishes = (): void => {
    const lengthError = termLengthError(draft.excludedRaw, copy);

    if (lengthError !== null) {
      setStepError(lengthError);

      return;
    }

    const regionError = validateRegion(
      draft.regionMode,
      draft.country,
      copy,
      draft.precise,
      draft.cityId,
    );

    if (regionError !== null) {
      setStepError(regionError);
      setShowResults(false);
      setStepIndex(0);

      return;
    }

    startSearch(currentPayload(0), draft.remember);
  };

  /**
   * Skip reverts the exclusions box to the persisted value (guest storage,
   * or the loaded account prefs when signed in) and submits that — the
   * persisted values are pre-validated, so no length check runs here. The
   * region still validates: an invalid region sends the visitor back to
   * step 0 with the error.
   */
  const skipExclusions = (): void => {
    const regionError = validateRegion(
      draft.regionMode,
      draft.country,
      copy,
      draft.precise,
      draft.cityId,
    );

    if (regionError !== null) {
      setStepError(regionError);
      setShowResults(false);
      setStepIndex(0);

      return;
    }

    const persisted = persistedExclusions();
    const reverted: QuizDraft = { ...draft, excludedRaw: persisted.join(", ") };
    setDraft(reverted);
    setExcludedTouched(false);

    startSearch(
      buildRecommendPayload({
        meal,
        excludedIngredients: persisted,
        country: draftCountryMirror(reverted),
        location: draftLocation(reverted),
        mood,
        locale: lang,
        surpriseSeed: 0,
      }),
      reverted.remember,
    );
  };

  /** Empty-state fallback for sparse city/precise coverage: search worldwide instead. */
  const searchWorldwide = (): void => {
    const next: QuizDraft = {
      ...draft,
      regionMode: "anywhere",
      country: "",
      countrySource: null,
      cityId: null,
      cityLabel: null,
      cityCountry: null,
      precise: null,
    };

    explicitRegionRef.current = true;
    setDraft(next);
    startSearch(
      buildSurprisePayload({ draft: next, meal, mood, locale: lang, surpriseSeed: 0 }),
      next.remember,
    );
  };

  /**
   * Surprise keeps the current meal, mood, region, and exclusions and never
   * touches saved preferences: no persist, no clear. Each click bumps a
   * bounded seed so the server offsets a window into the eligible pool —
   * same filters, different dishes.
   */
  const surprise = (): void => {
    const nextSeed = surpriseSeed + 1;
    setSurpriseSeed(nextSeed);
    const payload = currentPayload(nextSeed);

    setSubmitted(payload);
    setStepError(null);
    setShowResults(true);
    // New seed keys a new cache entry: exactly one fetch per surprise tap.
  };

  /** Wipe saved preferences and reset the whole form; storage first. */
  const clearSaved = (): void => {
    if (typeof window !== "undefined") {
      removeSavedPrefs(() => window.localStorage.removeItem(PREFS_STORAGE_KEY));
    }

    setGuestExclusions([]);
    clearJourneySnapshot();

    setDraft(EMPTY_DRAFT);
    setMeal("anything");
    setMood("any");
    setStepError(null);
    setSubmitted(null);
    setStepIndex(0);
    setShowResults(false);
    setConfirmClear(false);
    setHasSaved(false);
    setSurpriseSeed(0);
    setRegionTouched(false);
    setMealTouched(false);
    setMoodTouched(false);
    setExcludedTouched(false);
    explicitRegionRef.current = false;

    // Signed-in members clear the account-backed list through the
    // authenticated server operation and refresh the account-scoped cache,
    // so cleared values cannot reappear via Skip, reload, or the import
    // banner. The in-memory draft above is already empty, so an inline
    // retry after a failure correctly re-saves the empty list.
    if (userId !== null) {
      const memberId = userId;

      accountSave.mutate([], {
        onSuccess: () => {
          setAccountSaveError(null);
          queryClient.setQueryData(["user", "food-preferences", memberId], {
            excludedIngredients: [],
          });
        },
        onError: () => {
          setAccountSaveError(copy.recError);
        },
      });
    }
  };

  /** Explicit refresh / Try-again: exactly one new request, on demand only. */
  const retry = (): void => {
    if (submitted === null) {
      return;
    }

    void recommend.refetch();
  };

  const backToQuiz = (): void => {
    setShowResults(false);
  };

  const editStep = (step: number): void => {
    setShowResults(false);
    setStepError(null);
    setStepIndex(step);
  };

  const startOver = (): void => {
    clearJourneySnapshot();

    setDraft(EMPTY_DRAFT);
    setMeal("anything");
    setMood("any");
    setStepError(null);
    setSubmitted(null);
    setStepIndex(0);
    setShowResults(false);
    setConfirmClear(false);
    setSurpriseSeed(0);
    setRegionTouched(false);
    setMealTouched(false);
    setMoodTouched(false);
    setExcludedTouched(false);
    explicitRegionRef.current = false;
  };

  const regionOrigin: AnswerOrigin = regionOriginFor({
    draft,
    savedCountry: savedInitial?.country ?? null,
    savedCityId: savedInitial?.city?.placeId ?? null,
    touched: regionTouched,
  });

  const excludedOrigin: AnswerOrigin = textOriginFor({
    savedValue: savedInitial === null ? null : savedInitial.excludedIngredients.join(", "),
    touched: excludedTouched,
    value: draft.excludedRaw,
  });

  const outcome: RecommendResult | null = recommend.data ?? null;
  const stepLabel = `${copy.recStep} ${stepIndex + 1} ${copy.recOf} ${QUIZ_STEPS}`;
  const resultUserId = userId;

  const resultIds = useMemo(
    () =>
      outcome !== null && (outcome.mode === "ai" || outcome.mode === "deterministic")
        ? outcome.dishes.map((dish) => dish.id)
        : [],
    [outcome],
  );

  const resultFavorites = useFavoriteStatus(resultIds, resultUserId);

  const carouselItems = useMemo(
    () =>
      outcome !== null && (outcome.mode === "ai" || outcome.mode === "deterministic")
        ? outcome.dishes.slice(0, 10)
        : [],
    [outcome],
  );

  // Shared carousel + rail index. Reset on a new result set via the
  // render-adjust pattern (no set-state-in-effect): the carousel also
  // receives resetKey, but the parent owns the index so it resets here.
  // Initial value restores the tab-back slide from the journey snapshot.
  const [railIndex, setRailIndex] = useState(journey?.railIndex ?? 0);
  const [railKey, setRailKey] = useState(outcomeKey);

  if (railKey !== outcomeKey) {
    setRailKey(outcomeKey);
    setRailIndex(0);
  }

  // Persist the in-progress journey in memory so dish detail visits (back
  // navigation remounts this route) restore form, step, results, and the
  // selected slide. Coordinates never enter the cache: toCoarseSnapshot
  // strips precise fixes and precise results before writing. Quiz answers
  // (draft/meal/mood) stay separate from presentation state (railIndex).
  useEffect(() => {
    writeJourneySnapshot(
      toCoarseSnapshot({
        meal,
        mood,
        draft,
        stepIndex,
        submitted,
        showResults,
        surpriseSeed,
        railIndex,
      }),
    );
  }, [meal, mood, draft, stepIndex, submitted, showResults, surpriseSeed, railIndex]);

  const provenanceLabels = useMemo(
    () => ({ approximate: copy.recApproximate, saved: copy.recSavedFromVisit }),
    [copy],
  );

  /**
   * Guest-to-account import banner: when the device holds exclusions that
   * differ from the signed-in member's account prefs, offer a one-tap
   * import. Import adopts the guest values and saves them to the account;
   * Not now dismisses for the visit. Never shows for guests or while the
   * account prefs are still loading.
   */
  const accountExclusions: ReadonlyArray<string> | null =
    accountPrefsQuery.data?.excludedIngredients ?? null;

  const accountHasPrefs = (accountExclusions?.length ?? 0) > 0;

  /** Clear affordance covers guest storage, the in-memory mirrors, and the
   * loaded account prefs — whichever source actually holds values. */
  const hasSavedVisible = hasSaved || (userId !== null && accountHasPrefs);

  const showImportBanner = shouldShowImportBanner({
    signedIn: userId !== null,
    accountLoaded: accountPrefsQuery.data !== undefined,
    dismissed: importDismissed,
    guest: guestExclusions,
    account: accountExclusions,
  });

  const renderImportBanner = (): ReactNode =>
    showImportBanner ? (
      <div className="rounded-2xl border-2 border-border-soft bg-cream px-4 py-3">
        <p className="text-sm font-extrabold text-ink">{copy.recPrefsImportTitle}</p>
        <p className="mt-1 text-sm text-muted">{copy.recPrefsImportBody}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={importGuestPrefs}
            className="inline-flex min-h-10 cursor-pointer items-center rounded-full bg-ink px-4 text-xs font-bold text-white transition hover:opacity-90"
          >
            {copy.recPrefsImportYes}
          </button>
          <button
            type="button"
            onClick={() => {
              setImportDismissed(true);
            }}
            className="inline-flex min-h-10 cursor-pointer items-center rounded-full border-2 border-border-soft bg-white px-4 text-xs font-bold text-ink transition hover:border-ink"
          >
            {copy.recPrefsImportNo}
          </button>
        </div>
      </div>
    ) : null;

  /**
   * Shared stage renderer for the desktop card and the mobile drawer. One
   * question per view in both; the drawer passes compact for the tighter
   * option presentation. State and handlers are shared, so answers survive
   * overlay round-trips.
   */
  const renderStages = (compact: boolean): ReactNode => (
    <div key={stepIndex} className="motion-safe:animate-rec-step-enter">
      {stepIndex === 0 ? (
        <WhereStep
          compact={compact}
          copy={copy}
          countriesError={countries.isError}
          countryOptions={countryOptions}
          detected={{ country: detectedCountry, locating: regionQuery.isPending }}
          draft={draft}
          onAdvance={tryAdvance}
          onDraft={updateRegionDraft}
          onRetryCountries={() => {
            void countries.refetch();
          }}
          origin={regionOrigin}
          lang={lang}
          precise={{
            fix: precise.fix,
            request: precise.request,
            status: precise.status,
          }}
          provenanceLabels={provenanceLabels}
        />
      ) : null}

      {stepIndex === 1 ? (
        <CravingStep
          compact={compact}
          copy={copy}
          meal={meal}
          onAdvance={tryAdvance}
          onMeal={pickMeal}
          touched={mealTouched}
        />
      ) : null}

      {stepIndex === 2 ? (
        <AvoidStep
          compact={compact}
          copy={copy}
          draft={draft}
          excludedOrigin={excludedOrigin}
          mood={mood}
          moodTouched={moodTouched}
          onDraft={updateExclusionsDraft}
          onMood={pickMood}
          provenanceLabels={provenanceLabels}
        />
      ) : null}
    </div>
  );

  /**
   * Sticky drawer footer for quiz steps only: the single primary action per
   * view, always a min-44px target. Mirrors the desktop card actions exactly
   * — same handlers, same validation — only the layout is bottom-docked.
   * Successful results deliberately have no fixed footer (the dish owns the
   * drawer); Adjust lives as a compact header action and Start over in the
   * secondary disclosure below the dish.
   */
  const renderDrawerFooter = (): ReactNode => {
    if (stepIndex < QUIZ_STEPS - 1) {
      return (
        <div className="flex items-center gap-2">
          {stepIndex > 0 ? (
            <button
              type="button"
              onClick={goBack}
              aria-label={copy.recBack}
              className="inline-flex min-h-11 min-w-11 flex-none cursor-pointer items-center justify-center rounded-full border-2 border-border-soft bg-white px-3 text-sm font-bold text-ink transition hover:border-ink"
            >
              <ArrowLeftIcon aria-hidden="true" className="size-4" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              tryAdvance();
            }}
            className="inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full bg-ink px-6 text-sm font-bold text-white transition hover:opacity-90"
          >
            {copy.recContinue}
            <ArrowRightIcon aria-hidden="true" className="size-4 flex-none" />
          </button>
        </div>
      );
    }

    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={goBack}
          aria-label={copy.recBack}
          className="inline-flex min-h-11 min-w-11 flex-none cursor-pointer items-center justify-center rounded-full border-2 border-border-soft bg-white px-3 text-sm font-bold text-ink transition hover:border-ink"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
        </button>
        <button
          type="button"
          onClick={skipExclusions}
          disabled={recommend.isPending}
          className="inline-flex min-h-11 flex-none cursor-pointer items-center gap-1.5 rounded-full border-2 border-border-soft bg-white px-4 text-sm font-bold whitespace-nowrap text-ink transition hover:border-ink disabled:cursor-wait disabled:opacity-70"
        >
          <SkipForwardIcon aria-hidden="true" className="size-4 flex-none" />
          {copy.recSkipShort}
        </button>
        <button
          type="button"
          onClick={findDishes}
          disabled={recommend.isPending}
          className="inline-flex min-h-11 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full bg-food-orange-strong px-4 text-sm font-bold whitespace-nowrap text-white shadow-[0_10px_28px_rgba(194,65,12,0.35)] transition hover:bg-food-orange-dark disabled:cursor-wait disabled:opacity-70"
        >
          <SparklesIcon aria-hidden="true" className="size-4 flex-none" />
          {copy.recRecommendSubmit}
        </button>
      </div>
    );
  };

  if (embeddedMobile) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-quiz-sheet>
        <span
          id="recommend"
          aria-hidden="true"
          tabIndex={-1}
          className="block h-0 w-full overflow-hidden"
        />
        <div className="flex flex-none items-center gap-2 px-4 pt-1">
          {showResults ? (
            <div className="flex flex-1 justify-end">
              <button
                type="button"
                onClick={backToQuiz}
                aria-label={copy.recAdjust}
                className="inline-flex min-h-11 min-w-11 flex-none cursor-pointer items-center justify-center rounded-full border-2 border-border-soft bg-white px-3 text-sm font-bold text-ink"
              >
                <SlidersHorizontalIcon aria-hidden="true" className="size-4" />
              </button>
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <div className="min-w-0">
                <p aria-live="polite" className="truncate text-sm">
                  <span className="font-semibold text-muted">
                    {stepIndex + 1}/{QUIZ_STEPS}
                  </span>
                  <span aria-hidden="true" className="text-muted">
                    {" "}
                    ·{" "}
                  </span>
                  <span className="font-extrabold text-ink">{stepQuestion(stepIndex, copy)}</span>
                </p>
                <div aria-hidden="true" className="mt-1.5 flex gap-1">
                  {[0, 1, 2].map((dot) => (
                    <span
                      key={dot}
                      className={`h-1 flex-1 rounded-full ${dot <= stepIndex ? "bg-food-orange-strong" : "bg-border-soft"}`}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        {draft.cityId !== null && draft.cityLabel !== null ? (
          <div className="flex-none px-4 pt-2">
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border-2 border-ink bg-ink px-3 py-1 text-xs font-bold text-white">
              <MapPinIcon aria-hidden="true" className="size-3.5 flex-none" />
              <span className="truncate">{draft.cityLabel}</span>
            </span>
          </div>
        ) : null}
        <div
          ref={mobileBodyRef}
          data-drawer-body
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3"
        >
          <h2 ref={drawerHeadingRef} tabIndex={-1} className="sr-only">
            {showResults
              ? copy.recRecommendationsHeading
              : `${stepLabel}: ${stepQuestion(stepIndex, copy)}`}
          </h2>
          {showResults && submitted !== null ? (
            <div aria-live="polite" aria-busy={recommend.isPending}>
              {renderOutcome(copy, true)}
            </div>
          ) : (
            <div>
              {renderImportBanner()}
              <div className={showImportBanner ? "mt-3" : undefined}>{renderStages(true)}</div>
              {stepError !== null ? (
                <p
                  role="alert"
                  className="mt-3 rounded-xl border-2 border-danger bg-white px-4 py-3 text-sm font-bold text-danger"
                >
                  {stepError}
                </p>
              ) : null}
            </div>
          )}
        </div>
        {showResults ? null : (
          <div className="flex-none border-t-2 border-border-soft bg-cream px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {renderDrawerFooter()}
          </div>
        )}
      </div>
    );
  }

  return (
    <section
      id="recommend"
      aria-labelledby="recommend-heading"
      className={
        showResults
          ? "mx-auto w-full max-w-[90rem] scroll-mt-20 px-5 pt-10 sm:px-8"
          : "mx-auto w-full max-w-6xl scroll-mt-20 px-5 pt-10"
      }
      style={{ paddingBottom: "max(4rem, env(safe-area-inset-bottom))" }}
    >
      <div
        className={
          showResults
            ? "grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,11fr)]"
            : "grid items-start gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"
        }
      >
        <div className={showResults ? "contents lg:flex lg:min-w-0 lg:flex-col" : "min-w-0"}>
          <div className={showResults ? "order-1 min-w-0 lg:order-none" : undefined}>
            <h1
              id="recommend-heading"
              className="font-display text-[clamp(2.25rem,7vw,3.5rem)] leading-none tracking-wide text-balance"
            >
              {copy.recTitle}
            </h1>
            <p className="mt-3 max-w-[60ch] text-lg text-muted">
              {showResults && outcome !== null ? copy.recResultsIntro : copy.recIntro}
            </p>
            {showResults &&
            outcome !== null &&
            (outcome.mode === "ai" || outcome.mode === "deterministic") ? (
              <p className="mt-2 max-w-[60ch] text-base font-bold text-ink">
                {copy.recResultsCount.replace("{count}", String(outcome.dishes.length))}
              </p>
            ) : null}
            {/* Quiz phase only: once results show, scope display belongs
                to YourPicksCard (requested scope) plus the served-scope
                warnings — never a stale detection line beside them. */}
            {detectedName !== null && !showResults ? (
              <p className="mt-3 max-w-[60ch] text-base font-bold text-ink">
                {formatTemplate(copy.recWhereExploring, detectedName)}
              </p>
            ) : null}

            {showResults ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={backToQuiz}
                  className="inline-flex min-h-11 cursor-pointer items-center rounded-full bg-ink px-5 text-sm font-bold text-white transition hover:opacity-90"
                >
                  {copy.recAdjust}
                </button>
                <button
                  type="button"
                  onClick={startOver}
                  className="inline-flex min-h-11 cursor-pointer items-center rounded-full px-4 text-sm font-bold text-muted underline decoration-2 underline-offset-4 transition hover:text-ink"
                >
                  {copy.recStartOver}
                </button>
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={surprise}
                  disabled={recommend.isPending}
                  className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full bg-ink px-4 text-sm font-bold text-white transition hover:opacity-90 disabled:cursor-wait disabled:opacity-70"
                >
                  <SparklesIcon aria-hidden="true" className="size-4" /> {copy.recSurprise}
                </button>
                <button
                  type="button"
                  onClick={findDishes}
                  disabled={recommend.isPending}
                  className="inline-flex min-h-10 cursor-pointer items-center rounded-full border-2 border-border-soft bg-white px-4 text-sm font-bold text-ink transition hover:border-ink disabled:cursor-wait disabled:opacity-70"
                >
                  {copy.recQuick}
                </button>
              </div>
            )}
          </div>
          {showResults && submitted !== null ? (
            <div className="order-2 mt-6 min-w-0 lg:order-none">
              <YourPicksCard
                copy={copy}
                countryOptions={countryOptions}
                onEditStep={editStep}
                submitted={submitted}
              />
            </div>
          ) : null}
          {showResults &&
          outcome !== null &&
          (outcome.mode === "ai" || outcome.mode === "deterministic") ? (
            <div className="order-5 mt-4 min-w-0 lg:order-none">
              <AiExplanationCard copy={copy} mode={outcome.mode} ranking={outcome.ranking} />
            </div>
          ) : null}
          {showResults && submitted !== null && recommend.isPending && outcome === null ? (
            <div className="order-5 mt-4 min-w-0 lg:order-none">
              <ResultsExplanationSkeleton />
            </div>
          ) : null}
          {showResults && submitted !== null ? (
            <div className="order-6 mt-4 min-w-0 lg:order-none">
              <SidebarPrefsCard
                copy={copy}
                prefs={{
                  accountSaveError,
                  checked: draft.remember,
                  hasSaved: hasSavedVisible,
                  onChange: (next) => {
                    setDraft({ ...draft, remember: next });
                  },
                  onClear: () => {
                    setConfirmClear(true);
                  },
                  onConfirmClear: clearSaved,
                  onDismissClear: () => {
                    setConfirmClear(false);
                  },
                  onRetryAccountSave: retryAccountSave,
                  showConfirmClear: confirmClear,
                }}
              />
            </div>
          ) : null}
        </div>
        <div className={showResults ? "contents lg:block lg:min-w-0" : "min-w-0"}>
          {showResults ? (
            <section
              aria-labelledby="rec-results-heading"
              className="order-3 min-w-0 motion-safe:animate-rec-step-enter lg:order-none"
            >
              <h2 id="rec-results-heading" ref={stepHeadingRef} tabIndex={-1} className="sr-only">
                {copy.recRecommendationsHeading}
              </h2>
              <div aria-live="polite" aria-busy={recommend.isPending} className="mt-4 lg:mt-0">
                {renderOutcome(copy)}
              </div>
            </section>
          ) : (
            <section aria-labelledby="rec-step-heading" className="mt-3">
              <div className="min-h-[30rem] rounded-3xl border-2 border-border-soft bg-white p-6 shadow-[0_12px_28px_rgba(194,65,12,0.08)] sm:min-h-[26rem]">
                <h2 id="rec-step-heading" ref={stepHeadingRef} tabIndex={-1} className="sr-only">
                  {`${stepLabel}: ${stepQuestion(stepIndex, copy)}`}
                </h2>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <p
                    aria-live="polite"
                    className="text-sm font-bold tracking-wide text-muted uppercase"
                  >
                    {stepLabel}
                  </p>
                  <div aria-hidden="true" className="flex gap-1.5">
                    {[0, 1, 2].map((dot) => (
                      <span
                        key={dot}
                        className={`h-2 w-8 rounded-full ${dot <= stepIndex ? "bg-food-orange-strong" : "bg-border-soft"}`}
                      />
                    ))}
                  </div>
                </div>

                {renderImportBanner()}
                <div className={showImportBanner ? "mt-4" : undefined}>{renderStages(false)}</div>

                {stepError !== null ? (
                  <p
                    role="alert"
                    className="mt-4 rounded-xl border-2 border-danger bg-white px-4 py-3 text-sm font-bold text-danger"
                  >
                    {stepError}
                  </p>
                ) : null}

                <div className="mt-6 flex flex-wrap items-center gap-3 border-t-2 border-border-soft pt-5">
                  {stepIndex > 0 ? (
                    <button
                      type="button"
                      onClick={goBack}
                      className="inline-flex min-h-11 cursor-pointer items-center rounded-full border-2 border-border-soft bg-white px-5 text-sm font-bold text-ink transition hover:border-ink"
                    >
                      {copy.recBack}
                    </button>
                  ) : null}
                  {stepIndex < QUIZ_STEPS - 1 ? (
                    <button
                      type="button"
                      onClick={() => {
                        tryAdvance();
                      }}
                      className="inline-flex min-h-11 cursor-pointer items-center rounded-full bg-ink px-6 text-sm font-bold text-white transition hover:opacity-90"
                    >
                      {copy.recContinue}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={skipExclusions}
                        disabled={recommend.isPending}
                        className="inline-flex min-h-11 cursor-pointer items-center rounded-full border-2 border-border-soft bg-white px-5 text-sm font-bold text-ink transition hover:border-ink disabled:cursor-wait disabled:opacity-70"
                      >
                        {copy.recSkip}
                      </button>
                      <button
                        type="button"
                        onClick={findDishes}
                        disabled={recommend.isPending}
                        className="inline-flex min-h-12 cursor-pointer items-center rounded-full bg-food-orange-strong px-6 text-base font-bold text-white shadow-[0_10px_28px_rgba(194,65,12,0.35)] transition hover:-translate-y-px hover:bg-food-orange-dark disabled:cursor-wait disabled:opacity-70 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                      >
                        {copy.recFindMine}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </section>
  );

  function renderOutcome(copyMessages: Messages, compact = false) {
    // Active slide for the in-card Muse explanation. Restaurant discovery
    // lives in the carousel's own Find action (shared DishActions,
    // canonical dish identity) — no duplicate CTA here.
    const activeDish = carouselItems[railIndex] ?? null;

    /**
     * Backend-confirmed live-Muse gate for the per-dish explanation: the
     * wire mode alone is not the brand source — the structured ranking must
     * be LiveMuse (matched exhaustively, never warning-sniffed). Gated here
     * AND inside SelectedDishReason, so deterministic, degraded, and
     * stale/cross-identity payloads never present model text.
     */
    const liveMuse =
      outcome !== null &&
      outcome.mode === "ai" &&
      Match.value(outcome.ranking).pipe(
        Match.tag("LiveMuse", () => true),
        Match.orElse(() => false),
      );

    const activeReason = liveMuse ? cleanReasonForDisplay(activeDish?.aiReason) : null;

    // In-card Muse block: the active slide's validated reason travels
    // into the shared carousel through its `reason` slot (inline concise
    // block inside the compact text column, full-width top strip in full
    // layout). Slide changes re-render with the new active dish, so the
    // explanation always matches the visible slide. Deterministic and
    // degraded outcomes pass no reason, so no Muse container renders and
    // no extra model call fires.
    const activeReasonNode =
      activeReason === null ? undefined : (
        <SelectedDishReason
          aiReason={activeDish?.aiReason}
          copy={copyMessages}
          liveMuse={liveMuse}
        />
      );

    if (recommend.isPending) {
      return (
        <ResultsLoadingSkeleton
          compact={compact}
          copy={copyMessages}
          presence={presenceForSnapshot(agentProgress.snapshot)}
        />
      );
    }

    if (recommend.isError) {
      return <QuizError copy={copyMessages} onRetry={retry} />;
    }

    if (outcome === null) {
      return null;
    }

    if (outcome.mode === "uncertain" || outcome.mode === "empty") {
      // Compact drawer-first empty state: one heading, one hint, primary +
      // secondary location actions. Drawer footer already owns Adjust /
      // Start over, so they are not repeated here. Detailed backend reasons
      // stay behind an optional disclosure for troubleshooting.
      // Explicit worldwide is opt-in only: every location-scoped empty
      // (city, country, destination, approx, precise) offers one tap to
      // explore worldwide; a request that already was worldwide offers none.
      const requestedWorldwide =
        submitted?.location !== undefined
          ? submitted.location.kind === "worldwide"
          : submitted?.country === undefined;

      if (compact) {
        return (
          <div>
            <p className="text-base font-extrabold text-ink">{copyMessages.recReasonsHeading}</p>
            <p className="mt-1 text-sm font-semibold text-muted">{copyMessages.recEmptySuggest}</p>
            {outcome.mode === "empty" && !requestedWorldwide ? (
              <div className="mt-3 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => editStep(0)}
                  className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full bg-ink px-5 text-sm font-bold text-white transition hover:opacity-90"
                >
                  {copyMessages.recWhereAnother}
                </button>
                <button
                  type="button"
                  onClick={searchWorldwide}
                  disabled={recommend.isPending}
                  className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full border-2 border-border-soft bg-white px-5 text-sm font-bold text-ink transition hover:border-ink disabled:cursor-wait disabled:opacity-70"
                >
                  {copyMessages.recWhereAnywhere}
                </button>
              </div>
            ) : null}
            {outcome.reasons.length > 0 ? (
              <details className="mt-3 rounded-xl border border-border-soft bg-white px-3 py-2">
                <summary className="cursor-pointer text-sm font-bold text-muted">
                  {copyMessages.adminPlaceDetails}
                </summary>
                <ul className="mt-2 flex list-disc flex-col gap-1 pl-6 text-sm text-ink">
                  {outcome.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        );
      }

      return (
        <div>
          <AiExplanationCard
            copy={copyMessages}
            mode={outcome.mode}
            ranking={outcome.ranking}
            reasons={outcome.reasons}
          />
          {outcome.mode === "empty" && !requestedWorldwide ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => editStep(0)}
                className="inline-flex min-h-11 cursor-pointer items-center rounded-full border-2 border-border-soft bg-white px-5 text-sm font-bold text-ink transition hover:border-ink"
              >
                {copyMessages.recWhereAnother}
              </button>
              <button
                type="button"
                onClick={searchWorldwide}
                disabled={recommend.isPending}
                className="inline-flex min-h-11 cursor-pointer items-center rounded-full border-2 border-ink bg-white px-5 text-sm font-bold text-ink transition hover:bg-ink hover:text-white disabled:cursor-wait disabled:opacity-70"
              >
                {copyMessages.recWhereAnywhere}
              </button>
            </div>
          ) : null}
        </div>
      );
    }

    // Drawer-first compact success: the dish owns the drawer. Warnings stay
    // prominent above it; the Muse badge is a small disclosure, never a card
    // above the dish. Your picks, preferences, and the full AI explanation
    // live in one optional disclosure below the dish; Start over sits there
    // too. No rail — the two arrows navigate.
    if (compact) {
      const rankingVariant =
        outcome.mode === "deterministic" ? rankingVariantFor(outcome.mode, outcome.ranking) : null;

      // Keyed per canonical request: each new result set fades/slides in as
      // one composition (title + explanation together), never a staggered
      // jump. Remount also resets carousel internals alongside railIndex.
      return (
        <div key={outcomeKey} className="motion-safe:animate-rec-step-enter">
          {outcome.warnings.length > 0 ? (
            <div className="mb-2">
              <ResultWarnings copy={copyMessages} warnings={outcome.warnings} />
            </div>
          ) : null}
          {outcome.mode === "ai" ? (
            <details className="mb-2 rounded-full border border-border-soft bg-white px-3 py-1.5">
              <summary className="cursor-pointer text-xs font-bold text-ink">
                ✦ {copyMessages.recAiNote}
              </summary>
              <p className="px-1 pt-1 pb-1 text-xs font-semibold text-muted">
                {copyMessages.recAiExplainer}
              </p>
            </details>
          ) : (
            <p className="mb-2 text-xs font-semibold text-muted">
              {rankingVariant === "degraded"
                ? copyMessages.recFallbackNote
                : copyMessages.recCatalogNote}
            </p>
          )}
          <DishCarousel
            activeIndex={railIndex}
            autoplay
            autoplayMs={5000}
            copy={copyMessages}
            favoriteStatus={resultFavorites}
            items={carouselItems}
            label={copyMessages.recRecommendationsHeading}
            lang={lang}
            layout="compact"
            onIndexChange={setRailIndex}
            onSaveSheetOpenChange={setSaveSheetOpen}
            reason={activeReasonNode}
            resetKey={outcomeKey}
            session={session}
          />
          <details className="mt-2 rounded-2xl border-2 border-border-soft bg-white px-3 py-2">
            <summary className="cursor-pointer text-sm font-bold text-ink">
              {copyMessages.recSummaryLabel}
            </summary>
            <div className="mt-2 flex min-w-0 flex-col gap-2">
              {submitted !== null ? (
                <YourPicksCard
                  compact
                  copy={copyMessages}
                  countryOptions={countryOptions}
                  onEditStep={editStep}
                  submitted={submitted}
                />
              ) : null}
              <SidebarPrefsCard
                compact
                copy={copyMessages}
                prefs={{
                  accountSaveError,
                  checked: draft.remember,
                  hasSaved: hasSavedVisible,
                  onChange: (next) => {
                    setDraft({ ...draft, remember: next });
                  },
                  onClear: () => {
                    setConfirmClear(true);
                  },
                  onConfirmClear: clearSaved,
                  onDismissClear: () => {
                    setConfirmClear(false);
                  },
                  onRetryAccountSave: retryAccountSave,
                  showConfirmClear: confirmClear,
                }}
              />
              <AiExplanationCard
                copy={copyMessages}
                mode={outcome.mode}
                ranking={outcome.ranking}
              />
              <button
                type="button"
                onClick={startOver}
                className="inline-flex min-h-10 cursor-pointer items-center self-start rounded-full px-2 text-xs font-bold text-muted underline decoration-2 underline-offset-4 transition hover:text-ink"
              >
                {copyMessages.recStartOver}
              </button>
            </div>
          </details>
        </div>
      );
    }

    // Same keyed enter transition as the compact rail: one composed
    // fade/slide per result set, no title/explanation stagger.
    return (
      <div key={outcomeKey} className="motion-safe:animate-rec-step-enter">
        {outcome.warnings.length > 0 ? (
          <div className="mb-3">
            <ResultWarnings copy={copyMessages} warnings={outcome.warnings} />
          </div>
        ) : null}
        <DishCarousel
          activeIndex={railIndex}
          autoplay
          autoplayMs={5000}
          copy={copyMessages}
          favoriteStatus={resultFavorites}
          items={carouselItems}
          label={copyMessages.recRecommendationsHeading}
          lang={lang}
          onIndexChange={setRailIndex}
          onSaveSheetOpenChange={setSaveSheetOpen}
          reason={activeReasonNode}
          resetKey={outcomeKey}
          session={session}
        />
        <div className="mt-6">
          <RecommendationRail
            activeIndex={railIndex}
            copy={copyMessages}
            items={carouselItems}
            label={copyMessages.recRailHeading}
            lang={lang}
            onSelect={setRailIndex}
          />
        </div>
      </div>
    );
  }
}
