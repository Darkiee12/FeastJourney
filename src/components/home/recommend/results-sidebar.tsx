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
 * The optional served scope keeps the region chip honest: when the server
 * fell back from a city to a wider pool, the chip names the pool actually
 * served instead of the requested city.
 */
export function YourPicksCard({
  copy,
  countryOptions,
  onEditStep,
  submitted,
  servedScope,
}: {
  readonly copy: Messages;
  readonly countryOptions: ReadonlyArray<CountryOption>;
  readonly onEditStep: (step: number) => void;
  readonly submitted: RecommendPayload;
  readonly servedScope?: "city" | "country" | "nearby" | "worldwide" | undefined;
}) {
  const picks = toYourPicksProps(submitted);

  const summaryLocation = (() => {
    if (picks.location?.kind !== "city") {
      return picks.location;
    }

    if (servedScope === undefined || servedScope === "city") {
      return picks.location;
    }

    if (servedScope === "country" && picks.location.country !== undefined) {
      return { kind: "destination", country: picks.location.country } as const;
    }

    if (servedScope === "worldwide") {
      return { kind: "worldwide" } as const;
    }

    return picks.location;
  })();

  return (
    <QuizSummary
      allergies={picks.allergies}
      avoid={picks.avoid}
      copy={copy}
      countryOptions={countryOptions}
      meal={picks.meal}
      mood={picks.mood}
      onEditStep={onEditStep}
      submittedCountry={picks.country}
      submittedLocation={summaryLocation}
    />
  );
}

/**
 * Remember-preferences card. Standalone export for the same layout reason;
 * behavior stays entirely inside RememberPrefs.
 */
export function SidebarPrefsCard({
  copy,
  prefs,
}: {
  readonly copy: Messages;
  readonly prefs: SidebarPrefsProps;
}) {
  return (
    <RememberPrefs
      checked={prefs.checked}
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
  copy,
  countryOptions,
  onEditStep,
  prefs,
  submitted,
}: {
  readonly aiCard?: ReactNode | undefined;
  readonly copy: Messages;
  readonly countryOptions: ReadonlyArray<CountryOption>;
  readonly onEditStep: (step: number) => void;
  readonly prefs: SidebarPrefsProps;
  readonly submitted: RecommendPayload;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <YourPicksCard
        copy={copy}
        countryOptions={countryOptions}
        onEditStep={onEditStep}
        submitted={submitted}
      />
      {aiCard}
      <SidebarPrefsCard copy={copy} prefs={prefs} />
    </div>
  );
}
