import { PencilIcon } from "lucide-react";

import { formatTemplate, scopeLabelFor } from "@/components/home/recommend/quiz-model";
import {
  mealLabelFor,
  moodLabelFor,
  type CountryOption,
} from "@/components/home/recommend/quiz-stages";
import type { RecommendationLocation } from "@/modules/food-discovery/food.schema";
import type {
  MealOccasion,
  RecommendationMood,
} from "@/modules/food-discovery/recommendation.constants";
import type { Messages } from "@/shared/i18n";

export interface SummaryChips {
  readonly region: string;
  readonly meal: string;
  readonly preferences: string;
}

/**
 * Sidebar YOUR PICKS card: compact editable summary of the last submitted
 * request (e.g. "Exploring Bengaluru, Karnataka, India · Dinner · No pork").
 * Each chip returns to its step so the visitor adjusts one thing instead of
 * restarting. The unified exclusions render as plain text (first two plus
 * an overflow count). The region chip names the scope honestly:
 * approximate home regions explore by country name, chosen cities show the
 * city label (falling back to the wider pool actually served when the
 * server reports one), precise fixes show the nearby scope without accuracy
 * meters, destinations show the plain country, worldwide stays unlabeled.
 * Never claims food is physically near or that a city is proven.
 */
export function QuizSummary({
  compact = false,
  copy,
  countryOptions,
  excludedIngredients,
  meal,
  mood,
  onEditStep,
  submittedCountry,
  submittedLocation,
}: {
  readonly compact?: boolean;
  readonly copy: Messages;
  readonly countryOptions: ReadonlyArray<CountryOption>;
  readonly excludedIngredients: ReadonlyArray<string>;
  readonly meal: MealOccasion;
  readonly mood: RecommendationMood;
  readonly onEditStep: (step: number) => void;
  readonly submittedCountry: string | undefined;
  readonly submittedLocation?: RecommendationLocation | undefined;
}) {
  const regionName = scopeLabelFor(
    { country: submittedCountry, location: submittedLocation },
    copy,
    countryOptions,
  );

  const shownExcluded = excludedIngredients.slice(0, 2).join(", ");
  const hiddenExcluded = excludedIngredients.length - Math.min(excludedIngredients.length, 2);

  const exclusionsText =
    excludedIngredients.length === 0
      ? copy.recReviewAny
      : `${shownExcluded}${hiddenExcluded > 0 ? ` +${hiddenExcluded.toString()}` : ""}`;

  const chips: ReadonlyArray<{ label: string; step: number; value: string }> = [
    { label: copy.recWhereLegend, step: 0, value: regionName },
    {
      label: copy.recCravingLegend,
      step: 1,
      value: `${mealLabelFor(meal, copy)} · ${moodLabelFor(mood, copy)}`,
    },
    { label: copy.recAvoidTitle, step: 2, value: exclusionsText },
  ];

  return (
    <div
      className={
        compact
          ? "rounded-2xl border-2 border-border-soft bg-cream px-3 py-2"
          : "rounded-2xl border-2 border-border-soft bg-cream px-4 py-3"
      }
    >
      {/* In compact (drawer) mode the drawer header already names the
          section — keep the card label screen-reader-only so the visible
          heading never repeats. */}
      <p
        className={
          compact
            ? "sr-only"
            : "flex items-center gap-2 font-display text-xl tracking-wide text-ink"
        }
      >
        <PencilIcon aria-hidden="true" className="size-4 shrink-0" />
        {copy.recSummaryLabel}
      </p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {chips.map((chip) => (
          <li key={chip.label}>
            <button
              type="button"
              onClick={() => {
                onEditStep(chip.step);
              }}
              aria-label={formatTemplate(copy.recSummaryChange, chip.label)}
              title={formatTemplate(copy.recSummaryChange, chip.label)}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border-2 border-border-soft bg-white px-4 text-sm font-bold text-ink transition hover:border-food-orange"
            >
              <span aria-hidden="true" className="text-muted">
                {chip.value}
              </span>
              <span className="sr-only">{formatTemplate(copy.recSummaryChange, chip.label)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Unobtrusive opt-in shown with results. Never prechecked; the checkbox
 * governs only the destination (country/city). Unified exclusions always
 * persist — on this device for guests, to the account when signed in.
 */
export function RememberPrefs({
  accountSaveError,
  checked,
  compact = false,
  copy,
  hasSaved,
  onChange,
  onClear,
  onConfirmClear,
  onDismissClear,
  onRetryAccountSave,
  showConfirmClear,
}: {
  readonly accountSaveError: string | null;
  readonly checked: boolean;
  readonly compact?: boolean;
  readonly copy: Messages;
  readonly hasSaved: boolean;
  readonly onChange: (next: boolean) => void;
  readonly onClear: () => void;
  readonly onConfirmClear: () => void;
  readonly onDismissClear: () => void;
  readonly onRetryAccountSave: () => void;
  readonly showConfirmClear: boolean;
}) {
  return (
    <div
      className={
        compact
          ? "rounded-2xl border border-border-soft bg-white px-3 py-2"
          : "mt-4 rounded-2xl border border-border-soft bg-white px-4 py-3"
      }
    >
      <label className="flex cursor-pointer items-start gap-3 text-sm font-bold text-ink">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
          className="mt-0.5 size-5 flex-none accent-food-orange-strong"
        />
        <span>
          {copy.recRememberDestination}
          <span className="mt-1 block text-xs font-normal text-muted">
            {copy.recExclusionsAutoSaved}
          </span>
        </span>
      </label>
      {accountSaveError !== null ? (
        <p
          role="alert"
          className="mt-3 rounded-xl border-2 border-danger bg-white px-4 py-3 text-sm font-bold text-danger"
        >
          {accountSaveError}{" "}
          <button
            type="button"
            onClick={onRetryAccountSave}
            className="cursor-pointer underline decoration-2 underline-offset-4 transition hover:opacity-80"
          >
            {copy.recRetry}
          </button>
        </p>
      ) : null}
      {hasSaved ? (
        <div className="mt-3">
          {showConfirmClear ? (
            <div>
              <p className="text-sm font-bold text-ink">{copy.recClearPrefsConfirm}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onConfirmClear}
                  className="inline-flex min-h-10 cursor-pointer items-center rounded-full border-2 border-danger bg-white px-4 text-xs font-bold text-danger transition hover:bg-danger hover:text-white"
                >
                  {copy.recClearPrefsYes}
                </button>
                <button
                  type="button"
                  onClick={onDismissClear}
                  className="inline-flex min-h-10 cursor-pointer items-center rounded-full border-2 border-border-soft bg-white px-4 text-xs font-bold text-ink transition hover:border-ink"
                >
                  {copy.recClearPrefsNo}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={onClear}
              aria-expanded="false"
              className="inline-flex min-h-10 cursor-pointer items-center rounded-full border border-border-soft bg-white px-4 text-xs font-bold text-muted transition hover:border-ink hover:text-ink"
            >
              {copy.recClearPrefs}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
