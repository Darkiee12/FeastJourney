import {
  DishRecommendationCard,
  DishRecommendationCardSkeleton,
  type CardProvenance,
  type DishRecommendationPresentation,
} from "@/components/home/dish-recommendation-card";
import type { RankedDishSummary } from "@/modules/food-discovery/server/operations/recommendation-service";
import type { FavoriteStatusQuery } from "@/modules/user/components/save-dish-button";
import type { SessionState } from "@/modules/user/session.functions";
import type { Locale, Messages } from "@/shared/i18n";

/**
 * Personalized-results grid card: thin adapter over the shared
 * `DishRecommendationCard`. One authoritative DTO (`RankedDishSummary`,
 * Muse reason riding optional) plus explicit card provenance feed the
 * whole card — the adapter adds no presentation of its own. Callers map
 * the wire outcome via `provenanceForOutcome` so deterministic and
 * degraded results never claim Muse ranking.
 */
export function ResultCard({
  copy,
  dish,
  favoriteStatus,
  lang,
  presentation,
  provenance,
  session,
}: {
  readonly copy: Messages;
  readonly dish: RankedDishSummary;
  readonly favoriteStatus: FavoriteStatusQuery;
  readonly lang: Locale;
  readonly presentation?: DishRecommendationPresentation | undefined;
  readonly provenance: CardProvenance;
  readonly session: SessionState;
}) {
  return (
    <DishRecommendationCard
      copy={copy}
      dish={dish}
      favoriteStatus={favoriteStatus}
      lang={lang}
      presentation={presentation}
      provenance={provenance}
      returnTo="/"
      session={session}
    />
  );
}

/**
 * Loading skeleton for the results grid. Re-exported shape of the shared
 * card skeleton so grid callers keep one import.
 */
export function ResultCardSkeleton({
  presentation,
}: {
  readonly presentation?: DishRecommendationPresentation | undefined;
} = {}) {
  return <DishRecommendationCardSkeleton presentation={presentation} />;
}
