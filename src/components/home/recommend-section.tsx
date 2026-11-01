import { RecommendSection as RecommendQuiz } from "@/components/home/recommend/quiz-flow";

/**
 * Homepage recommendation section. The 3-step quiz lives in
 * `recommend/` (orchestration, stage presentation, summary, result card,
 * status); this entry keeps the historical import path stable for route
 * code and the client-parsing tests, which import the pure quiz model
 * helpers from here.
 */
export function RecommendSection() {
  return <RecommendQuiz />;
}

export {
  buildRecommendPayload,
  buildSurprisePayload,
  clearJourneySnapshot,
  DEFAULT_PROVENANCE_LABELS,
  didPreciseFixArrive,
  draftCountryMirror,
  draftFromSavedPrefs,
  EMPTY_DRAFT,
  flagOriginFor,
  formatTemplate,
  isCityPlaceId,
  isRegionComplete,
  MAX_REC_TERM_LENGTH,
  mealSchema,
  migrateLegacyPrefs,
  moodSchema,
  parseCommaList,
  persistPrefs,
  pickDestinationCity,
  pickDestinationCountry,
  pickRegionChoice,
  PREFS_STORAGE_KEY,
  readInitialDraft,
  readJourneySnapshot,
  readSavedPrefs,
  readSavedPrefsWithMigration,
  readStoredPrefs,
  recCountrySchema,
  regionOriginFor,
  removeSavedPrefs,
  sameRegion,
  sanitizeCountryCode,
  scopeLabelFor,
  serializePrefs,
  shouldAutoAdvanceRegion,
  termLengthError,
  textOriginFor,
  tooLongTerms,
  validateRegion,
  writeJourneySnapshot,
  type AnswerOrigin,
  type JourneySnapshot,
  type ProvenanceLabels,
  type QuizDraft,
  type RecommendAnswers,
  type RecommendPayload,
  type RecRegionMode,
  type SavedRecommendPrefs,
  type SurpriseInputs,
} from "@/components/home/recommend/quiz-model";
