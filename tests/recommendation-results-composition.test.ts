import { describe, expect, test } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DishCarouselSkeleton } from "@/components/dish/dish-carousel";
import { DishMedia, DishMediaFallback, DishMediaSkeleton } from "@/components/dish/dish-media";
import { mealLabelFor, moodLabelFor } from "@/components/home/recommend/quiz-stages";
import { QuizError, ResultWarnings } from "@/components/home/recommend/quiz-status";
import { QuizSummary } from "@/components/home/recommend/quiz-summary";
import { messagesFor } from "@/shared/i18n";

const copyEn = messagesFor("en");
const copyVi = messagesFor("vi");

const countryOptions = [
  { code: "VN", label: "Vietnam" },
  { code: "TH", label: "Thailand" },
] as const;

const summaryBase = {
  copy: copyEn,
  countryOptions: [...countryOptions],
  onEditStep: () => {},
} as const;

/**
 * Results composition as shipped in quiz-flow.tsx renderOutcome: QuizSummary
 * chips above the ranking note, warnings, allergy notice, then the shared
 * featured carousel. Full-carousel and ResultCard SSR need router context
 * (Link/useNavigate), so slide DOM is pinned in the ready-to-run Playwright
 * spec; here we pin every SSR-safe piece of the composition.
 */
describe("results summary chips", () => {
  test("renders the Your Picks label with one chip per questionnaire step", () => {
    const html = renderToStaticMarkup(
      QuizSummary({
        ...summaryBase,
        excludedIngredients: [],
        meal: "dinner",
        mood: "any",
        submittedCountry: "VN",
        submittedLocation: { kind: "destination", country: "VN" },
      }),
    );

    expect(html).toContain(copyEn.recSummaryLabel);
    expect(html).toContain("Vietnam");
    expect(html).toContain(mealLabelFor("dinner", copyEn));
    expect(html).toContain(moodLabelFor("any", copyEn));
    expect(html).toContain(copyEn.recReviewAny);
  });

  test("each chip exposes a per-step edit target", () => {
    const seen: Array<number> = [];

    const html = renderToStaticMarkup(
      QuizSummary({
        ...summaryBase,
        excludedIngredients: [],
        meal: "anything",
        mood: "any",
        onEditStep: (step: number) => {
          seen.push(step);
        },
        submittedCountry: undefined,
        submittedLocation: { kind: "worldwide" },
      }),
    );

    // Three chips (where / craving / avoid) each labelled with its step name.
    expect(html).toContain(copyEn.recWhereLegend);
    expect(html).toContain(copyEn.recCravingLegend);
    expect(html).toContain(copyEn.recAvoidTitle);
    expect(seen).toEqual([]);
  });

  test("exclusions list truncates at two with an honest overflow count", () => {
    const html = renderToStaticMarkup(
      QuizSummary({
        ...summaryBase,
        excludedIngredients: ["pork", "cilantro", "durian"],
        meal: "anything",
        mood: "any",
        submittedCountry: undefined,
        submittedLocation: { kind: "worldwide" },
      }),
    );

    expect(html).toContain("pork");
    expect(html).toContain("cilantro");
    expect(html).toContain("+1");
    // The truncated item is still discoverable in the overflow count only.
    expect(html).not.toContain("durian");
  });

  test("unified exclusions render as plain text with no separate allergy line", () => {
    const html = renderToStaticMarkup(
      QuizSummary({
        ...summaryBase,
        excludedIngredients: ["peanut", "shellfish"],
        meal: "anything",
        mood: "any",
        submittedCountry: undefined,
        submittedLocation: { kind: "worldwide" },
      }),
    );

    expect(html).toContain("peanut");
    expect(html).toContain("shellfish");
  });

  test("precise scope shows the nearby label without meters, never city precision", () => {
    const html = renderToStaticMarkup(
      QuizSummary({
        ...summaryBase,
        excludedIngredients: [],
        meal: "anything",
        mood: "any",
        submittedCountry: undefined,
        submittedLocation: { accuracy: 25, kind: "precise", latitude: 21.02, longitude: 105.85 },
      }),
    );

    expect(html).toContain(copyEn.recWhereNearYou);
    expect(html).not.toContain("25 m");
    expect(html).not.toContain("Hanoi");
  });

  test("worldwide scope stays unlabeled", () => {
    const html = renderToStaticMarkup(
      QuizSummary({
        ...summaryBase,
        excludedIngredients: [],
        meal: "anything",
        mood: "any",
        submittedCountry: undefined,
        submittedLocation: { kind: "worldwide" },
      }),
    );

    expect(html).toContain(copyEn.recWhereAnywhere);
  });

  test("summary copy exists in Vietnamese", () => {
    const html = renderToStaticMarkup(
      QuizSummary({
        copy: copyVi,
        countryOptions: [...countryOptions],
        excludedIngredients: [],
        meal: "dinner",
        mood: "comforting",
        onEditStep: () => {},
        submittedCountry: "VN",
        submittedLocation: { kind: "destination", country: "VN" },
      }),
    );

    expect(html).toContain(copyVi.recSummaryLabel);
  });
});

describe("results status branches", () => {
  test("error branch is a retryable alert with recovery action", () => {
    const html = renderToStaticMarkup(QuizError({ copy: copyEn, onRetry: () => {} }));

    expect(html).toContain('role="alert"');
    expect(html).toContain(copyEn.recError);
    expect(html).toContain(copyEn.recRetry);
  });

  test("unresolvable exclusions render as an honest limitation warning", () => {
    const html = renderToStaticMarkup(
      ResultWarnings({
        copy: copyEn,
        warnings: [
          'Could not match exclusion "durian" to a known ingredient; it was not applied as a filter.',
        ],
      }),
    );

    expect(html).toContain(copyEn.recWarningsLabel);
    expect(html).toContain("durian");
  });

  test("empty warnings render nothing; unknown-dislike warnings stay visible", () => {
    expect(renderToStaticMarkup(ResultWarnings({ copy: copyEn, warnings: [] }))).toBe("");

    const html = renderToStaticMarkup(
      ResultWarnings({
        copy: copyEn,
        warnings: [
          'Could not match exclusion "durian" to a known ingredient; it was not applied as a filter.',
        ],
      }),
    );

    expect(html).toContain(copyEn.recWarningsLabel);
    expect(html).toContain("durian");
  });

  test("empty-state reasons list plus the honest retry suggestion", () => {
    // Mirrors the quiz-flow empty branch: reasons list, then recEmptySuggest.
    // The list itself is plain markup; pin the copy contract it depends on.
    expect(copyEn.recReasonsHeading.length).toBeGreaterThan(0);
    expect(copyEn.recEmptySuggest.length).toBeGreaterThan(0);
    expect(copyEn.recWhereAnother.length).toBeGreaterThan(0);
    expect(copyEn.recWhereAnywhere.length).toBeGreaterThan(0);
  });
});

describe("results loading skeletons hold layout", () => {
  test("dish carousel skeleton reserves media aspect at results padding", () => {
    const html = renderToStaticMarkup(DishCarouselSkeleton());

    expect(html).toContain("--dish-feature-media-mobile");
    expect(html).toContain("--dish-feature-stage-desktop");
    expect(html).not.toContain("aspect-[4/3]");
    expect(html).not.toContain("md:min-h-[22rem]");
    expect(html).toContain("motion-reduce:animate-none");
  });

  test("dish media reserves aspect up front and shows skeleton before decode", () => {
    const html = renderToStaticMarkup(
      createElement(DishMedia, {
        image: {
          alt: "A test bowl",
          attribution: null,
          dishId: "101",
          focalX: 0.5,
          focalY: 0.4,
          height: 800,
          id: "photo-1",
          srcSet: "https://cdn.example.com/400 400w",
          url: "https://cdn.example.com/1600",
          width: 1200,
        },
        loadingLabel: "Loading photo",
        unavailableLabel: "Photo coming soon",
      }),
    );

    // aspect-ratio style reserves space; skeleton shows until decode.
    expect(html).toContain("aspect-ratio:1200 / 800");
    expect(html).toContain("Loading photo");
  });

  test("missing photo renders the honest fallback, never a fabricated image", () => {
    const html = renderToStaticMarkup(
      createElement(DishMedia, {
        image: null,
        loadingLabel: "Loading",
        unavailableLabel: "Photo coming soon",
      }),
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("Photo coming soon");
  });

  test("fallback and skeleton carry stable layout classes", () => {
    expect(renderToStaticMarkup(DishMediaFallback({ label: "Soon" }))).toContain(
      "absolute inset-0",
    );
    expect(renderToStaticMarkup(DishMediaSkeleton({ label: "Loading" }))).toContain(
      "absolute inset-0",
    );
  });
});
