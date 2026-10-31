import type { ReactNode } from "react";

import type { RecommendPayload } from "@/components/home/recommend/quiz-model";
import type { CountryOption } from "@/components/home/recommend/quiz-stages";
import { QuizSummary, RememberPrefs } from "@/components/home/recommend/quiz-summary";
import type { Messages } from "@/shared/i18n";

/**
 * Submitted values the YOUR PICKS card renders. Projected verbatim from
 * the last submitted request by toYourPicksProps — never reinterpreted
 * here, and never carrying plaintext coordinates into display text (the
 * summary's scope label decides the honest region wording).
 */
export interface YourPicksProps {
  readonly allergies: ReadonlyArray<string>;
  readonly avoid: ReadonlyArray<string>;
  readonly country: string | undefined;
  readonly location: RecommendPayload["location"];
  readonly meal: RecommendPayload["meal"];
  readonly mood: RecommendPayload["mood"];
}

/**
 * Project the last SUBMITTED request onto the props QuizSummary renders.
 * Pure pass-through: same references, no normalization, no second
 * interpretation of the submitted answers.
 */
export const toYourPicksProps = (submitted: RecommendPayload): YourPicksProps => ({
  allergies: submitted.allergies,
  avoid: submitted.avoid,
  country: submitted.country,
  location: submitted.location,
  meal: submitted.meal,
  mood: submitted.mood,
});

/**
 * Remember-preferences controls, forwarded verbatim to RememberPrefs.
 * Persistence rules live there: allergies are never persisted and no
 * precise coordinates enter storage.
 */
export interface SidebarPrefsProps {
  readonly checked: boolean;
  readonly hasSaved: boolean;
  readonly onChange: (next: boolean) => void;
  readonly onClear: () => void;
  readonly onConfirmClear: () => void;
  readonly onDismissClear: () => void;
  readonly showConfirmClear: boolean;
}

/**
 * YOUR PICKS card: submitted values with per-step edit chips. Standalone
 * export so the results layout can interleave it with the carousel on
 * mobile; ResultsSidebar composes it with the AI and prefs cards.
 * The region chip always names the requested scope (e.g. the chosen city);
 * when the server fell back to a wider pool, the outcome warnings rendered
 * alongside explain exactly what was served — the chip never silently
 * rewrites the visitor's choice to something they did not pick.
 */
export function YourPicksCard({
  compact = false,
  copy,
  countryOptions,
  onEditStep,
  submitted,
}: {
  readonly compact?: boolean;
  readonly copy: Messages;
  readonly countryOptions: ReadonlyArray<CountryOption>;
  readonly onEditStep: (step: number) => void;
  readonly submitted: RecommendPayload;
}) {
  const picks = toYourPicksProps(submitted);

  return (
    <QuizSummary
      allergies={picks.allergies}
      avoid={picks.avoid}
      compact={compact}
      copy={copy}
      countryOptions={countryOptions}
      meal={picks.meal}
      mood={picks.mood}
      onEditStep={onEditStep}
      submittedCountry={picks.country}
      submittedLocation={picks.location}
    />
  );
}

/**
 * Remember-preferences card. Standalone export for the same layout reason;
 * behavior stays entirely inside RememberPrefs.
 */
export function SidebarPrefsCard({
  compact = false,
  copy,
  prefs,
}: {
  readonly compact?: boolean;
  readonly copy: Messages;
  readonly prefs: SidebarPrefsProps;
}) {
  return (
    <RememberPrefs
      checked={prefs.checked}
      compact={compact}
      copy={copy}
      hasSaved={prefs.hasSaved}
      onChange={prefs.onChange}
      onClear={prefs.onClear}
      onConfirmClear={prefs.onConfirmClear}
      onDismissClear={prefs.onDismissClear}
      showConfirmClear={prefs.showConfirmClear}
    />
  );
}

/**
 * Results sidebar composition: YOUR PICKS card (submitted values with
 * per-step edit chips) + Agent C's AI card slot + the RememberPrefs card.
 * Single-column flow with compact spacing: no sticky positioning and no
 * breakpoint-duplicated components — mobile order follows normal flow.
 * Intro copy and Adjust/Start-over actions stay with the lead's left
 * column; this component owns only the cards below them.
 */
export function ResultsSidebar({
  aiCard,
  compact = false,
  copy,
  countryOptions,
  onEditStep,
  prefs,
  submitted,
}: {
  readonly aiCard?: ReactNode | undefined;
  readonly compact?: boolean;
  readonly copy: Messages;
  readonly countryOptions: ReadonlyArray<CountryOption>;
  readonly onEditStep: (step: number) => void;
  readonly prefs: SidebarPrefsProps;
  readonly submitted: RecommendPayload;
}) {
  return (
    <div className={compact ? "flex min-w-0 flex-col gap-3" : "flex min-w-0 flex-col gap-4"}>
      <YourPicksCard
        compact={compact}
        copy={copy}
        countryOptions={countryOptions}
        onEditStep={onEditStep}
        submitted={submitted}
      />
      {aiCard}
      <SidebarPrefsCard compact={compact} copy={copy} prefs={prefs} />
    </div>
  );
}
