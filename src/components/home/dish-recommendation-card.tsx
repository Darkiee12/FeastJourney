import { Link } from "@tanstack/react-router";
import { Match } from "effect";
import { ArrowUpRightIcon, StoreIcon, UtensilsCrossedIcon } from "lucide-react";

import { dishRestaurantsSearch } from "@/components/dish/dish-actions";
import { dishCarouselTitle, toCarouselPublishedImage } from "@/components/dish/dish-carousel";
import { DishMedia } from "@/components/dish/dish-media";
import { cleanReasonForDisplay, SelectedDishReason } from "@/components/home/recommend/quiz-status";
import type {
  RankedDishSummary,
  RankingProvenance,
} from "@/modules/food-discovery/server/operations/recommendation-service";
import {
  SaveDishButton,
  statusForDish,
  type FavoriteStatusQuery,
  type SaveButtonStatus,
} from "@/modules/user/components/save-dish-button";
import type { SessionState } from "@/modules/user/session.functions";
import type { Locale, Messages } from "@/shared/i18n";

/**
 * Card-level provenance: the single explicit reason a card may or may not
 * show Muse text. Mapped from the wire outcome (`mode` + structured
 * `ranking`) via `provenanceForOutcome` — never inferred from warning
 * strings, config, or client-side signals.
 *
 * - `muse-ranked`: backend-confirmed live Muse ranking with a validated
 *   reason available on the dish. Only this variant renders Muse branding.
 * - `catalog`: deterministic catalog selection (guests, unconfigured
 *   provider, surprise slices). No Muse claim, no model text.
 * - `degraded`: a member request attempted Muse and fell back. The dish
 *   stays, the correct provenance stays, and no stale model text renders.
 */
export type CardProvenance =
  | { readonly kind: "muse-ranked" }
  | { readonly kind: "catalog" }
  | { readonly kind: "degraded" };

/**
 * Map one wire outcome onto card provenance. Double-gated exactly like the
 * carousel reason slot: `mode === "ai"` alone never brands a card — the
 * structured ranking must be `LiveMuse`. Anything else degrades honestly to
 * catalog/degraded, and zero-dish outcomes map to null (no card renders).
 */
export const provenanceForOutcome = (
  mode: "ai" | "deterministic" | "uncertain" | "empty",
  ranking: RankingProvenance,
): CardProvenance | null => {
  if (mode === "uncertain" || mode === "empty") {
    return null;
  }

  if (mode === "deterministic") {
    return Match.value(ranking).pipe(
      Match.tag("DegradedMuse", (): CardProvenance => ({ kind: "degraded" })),
      Match.orElse((): CardProvenance => ({ kind: "catalog" })),
    );
  }

  return Match.value(ranking).pipe(
    Match.tag("LiveMuse", (): CardProvenance => ({ kind: "muse-ranked" })),
    Match.tag("DegradedMuse", (): CardProvenance => ({ kind: "degraded" })),
    Match.orElse((): CardProvenance => ({ kind: "catalog" })),
  );
};

export interface AlternateDishName {
  readonly name: string;
  readonly languageTag?: string | undefined;
}

/**
 * Resolve the secondary name line: the native name when it differs from the
 * display title, else the English name when that differs from both. Returns
 * null when there is nothing distinct to show, so identical names never
 * render twice.
 */
export const resolveAlternateName = (
  dish: RankedDishSummary,
  title: string,
): AlternateDishName | null => {
  const native = dish.nativeName;

  if (native !== undefined && native !== title) {
    return { languageTag: dish.nativeLanguageTag, name: native };
  }

  const english = dish.englishName;

  if (english !== undefined && english !== title && english !== native) {
    return { name: english };
  }

  return null;
};

/** Presentation-only description preview cap: user-perceived characters, never bytes. */
const DESCRIPTION_PREVIEW_LIMIT = 100;

/**
 * Unicode-safe description preview. Code-point aware (`Array.from` never
 * splits a surrogate pair), so CJK and Vietnamese diacritics survive intact.
 * Ellipsis only when truncation actually happened.
 */
export const previewDescription = (value: string): string => {
  const trimmed = value.trim();
  const points = Array.from(trimmed);

  if (points.length <= DESCRIPTION_PREVIEW_LIMIT) {
    return trimmed;
  }

  return `${points.slice(0, DESCRIPTION_PREVIEW_LIMIT).join("")}…`;
};

const isSameText = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * First-class Muse reasoning block. Renders ONLY for backend-confirmed live
 * Muse provenance with a validated non-blank reason that is not a duplicate
 * of the catalog description — deterministic, degraded, stale, and
 * duplicate-text cases render nothing (no empty container, no fabricated
 * text). The distinct bordered section keeps the model voice visually
 * separate from the curated catalog description below it.
 */
export function MuseReasonBlock({
  copy,
  dish,
  liveMuse,
}: {
  readonly copy: Messages;
  readonly dish: RankedDishSummary;
  readonly liveMuse: boolean;
}) {
  if (!liveMuse) {
    return null;
  }

  const reason = cleanReasonForDisplay(dish.aiReason);

  if (reason === null) {
    return null;
  }

  const description = dish.description ?? null;

  if (description !== null && isSameText(reason, description)) {
    return null;
  }

  return (
    <div className="rounded-xl border border-mango bg-cream px-3 py-2.5">
      <SelectedDishReason aiReason={reason} copy={copy} liveMuse />
    </div>
  );
}

/**
 * Compact action footer shared by every recommendation card. Dish name keeps
 * the full content width above; this row only carries secondary actions:
 * Save (existing member/guest favorite flow, unchanged), Find places
 * (icon + explicit label, never a bare storefront icon), and View dish
 * (orange accent primary). Uniform 44px touch targets, wrapping so 320px
 * viewports never overflow. The card itself is never a link, so no nested
 * interactive elements.
 */
export function DishCardActions({
  copy,
  dishId,
  dishSlug,
  lang,
  returnTo,
  session,
  status,
}: {
  readonly copy: Messages;
  readonly dishId: string;
  readonly dishSlug: string;
  readonly lang: Locale;
  readonly returnTo: string;
  readonly session: SessionState;
  readonly status: SaveButtonStatus;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SaveDishButton
        dishId={dishId}
        lang={lang}
        returnTo={returnTo}
        session={session}
        status={status}
      />
      <Link
        to="/restaurants"
        search={dishRestaurantsSearch(dishId, dishSlug, lang)}
        aria-label={copy.recFindRestaurants}
        title={copy.recFindRestaurants}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full border-2 border-ink bg-white px-4 text-sm font-bold text-ink transition hover:bg-ink hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink motion-reduce:transition-none"
      >
        <StoreIcon aria-hidden="true" className="size-4 flex-none" />
        {copy.recFindRestaurants}
      </Link>
      <Link
        to="/dishes/$dishId"
        params={{ dishId: dishSlug }}
        search={{ lang }}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full border-2 border-food-orange-strong bg-food-orange-strong px-4 text-sm font-bold text-white transition hover:bg-food-orange-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink motion-reduce:transition-none"
      >
        <ArrowUpRightIcon aria-hidden="true" className="size-4 flex-none" />
        {copy.recViewDish}
      </Link>
    </div>
  );
}

const dishInitialFor = (title: string): string => title.slice(0, 1).toUpperCase();

/**
 * Typed explicit presentation variant for recommendation cards. `full`
 * is the featured vertical card (desktop grids); `sheet-compact` is the
 * dense horizontal thumbnail row for bottom sheets — the same
 * thumbnail-plus-text-plus-footer contract as the compact carousel,
 * sharing its DTO, provenance, and actions without duplicating any
 * carousel state. The rail (`RecommendationRail`) stays the third,
 * selection-only surface.
 */
export type DishRecommendationPresentation = "full" | "sheet-compact";

/**
 * Ground-up vertical recommendation card. Strict top-to-bottom hierarchy:
 * image, full-width dish name (natural word-boundary wrap, never
 * `break-all`), alternate name only when distinct, cuisine/origin label,
 * Muse reasoning (live provenance only), short catalog description
 * (clamped, detail page owns the rest), then the compact action footer.
 * One authoritative DTO (`RankedDishSummary`, reason riding optional) feeds
 * the whole card — no derived UI state from inconsistent sources.
 */
export function DishRecommendationCard({
  copy,
  dish,
  favoriteStatus,
  lang,
  presentation = "full",
  provenance,
  returnTo,
  session,
}: {
  readonly copy: Messages;
  readonly dish: RankedDishSummary;
  readonly favoriteStatus: FavoriteStatusQuery;
  readonly lang: Locale;
  readonly presentation?: DishRecommendationPresentation | undefined;
  readonly provenance: CardProvenance;
  readonly returnTo: string;
  readonly session: SessionState;
}) {
  const title = dishCarouselTitle(dish);
  const alternate = resolveAlternateName(dish, title);
  const regions = dish.regionNames.length > 0 ? dish.regionNames.slice(0, 2).join(" · ") : null;
  const rawDescription = dish.description ?? null;

  const description =
    rawDescription !== null && rawDescription.trim() !== "" ? rawDescription : null;

  const descriptionLanguage =
    dish.descriptionLanguage !== null &&
    dish.descriptionLanguage !== undefined &&
    dish.descriptionLanguage !== lang
      ? dish.descriptionLanguage
      : undefined;

  // Sheet-compact: dense thumbnail row for bottom sheets. Fixed square
  // thumbnail (same 80–104px footprint as the compact carousel), flexible
  // text column with one region line, clamped title/description, the
  // provenance-gated reason only, and the single shared footer. Missing
  // photos use the same neutral icon placeholder as the carousel — text
  // is always visible, never pushed under a full-width image.
  if (presentation === "sheet-compact") {
    return (
      <article className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border-soft bg-white">
        <div className="flex gap-3 p-3">
          <div
            className="relative h-20 w-20 flex-none overflow-hidden rounded-xl bg-cream min-[400px]:h-24 min-[400px]:w-24 sm:h-[104px] sm:w-[104px]"
            title={dish.image?.attribution ?? undefined}
          >
            {dish.image === null || dish.image === undefined ? (
              <span
                aria-hidden="true"
                className="grid h-full w-full place-items-center bg-cream text-muted"
              >
                <UtensilsCrossedIcon aria-hidden="true" className="size-7 flex-none" />
              </span>
            ) : (
              <DishMedia
                image={toCarouselPublishedImage(dish.image, dish.id)}
                className="absolute inset-0 h-full w-full"
                unavailableLabel={copy.carouselPhotoSoon}
                loadingLabel={title}
              />
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {regions !== null ? (
              <p
                title={regions}
                className="truncate text-[11px] font-bold tracking-[0.14em] text-food-orange-strong uppercase"
              >
                {regions}
              </p>
            ) : null}
            <h3 className="font-display line-clamp-2 min-h-[2.5em] min-w-0 text-lg leading-snug text-balance break-words text-ink">
              <Link
                to="/dishes/$dishId"
                params={{ dishId: dish.slug }}
                search={{ lang }}
                className="underline decoration-food-orange/60 underline-offset-4 hover:text-food-orange-strong"
              >
                {title}
              </Link>
            </h3>
            {alternate !== null ? (
              <p
                lang={alternate.languageTag}
                title={alternate.name}
                className="truncate text-[13px] font-semibold text-ink"
              >
                {alternate.name}
              </p>
            ) : null}
            <div className="line-clamp-3 min-w-0">
              <MuseReasonBlock
                copy={copy}
                dish={dish}
                liveMuse={provenance.kind === "muse-ranked"}
              />
            </div>
            {description !== null ? (
              <p
                lang={descriptionLanguage}
                className="line-clamp-2 min-h-[2.6em] text-[13px] leading-relaxed break-words text-pretty text-ink"
              >
                {description}
              </p>
            ) : null}
          </div>
        </div>
        <div className="border-t border-border-soft px-3 py-2.5">
          <DishCardActions
            copy={copy}
            dishId={dish.id}
            dishSlug={dish.slug}
            lang={lang}
            returnTo={returnTo}
            session={session}
            status={statusForDish(favoriteStatus, dish.id)}
          />
        </div>
      </article>
    );
  }

  return (
    <article className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-border-soft bg-white transition hover:-translate-y-0.5 hover:border-food-orange motion-reduce:transition-none motion-reduce:hover:translate-y-0">
      <div
        className="relative aspect-[16/10] w-full flex-none overflow-hidden bg-cream"
        title={dish.image?.attribution ?? undefined}
      >
        {dish.image === null || dish.image === undefined ? (
          <span
            aria-hidden="true"
            className="font-display grid h-full w-full place-items-center bg-gradient-to-br from-food-orange-strong to-mango text-6xl text-white"
          >
            {dishInitialFor(title)}
          </span>
        ) : (
          <DishMedia
            image={toCarouselPublishedImage(dish.image, dish.id)}
            className="absolute inset-0 h-full w-full"
            unavailableLabel={copy.carouselPhotoSoon}
            loadingLabel={title}
          />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-4 sm:p-5">
        {regions !== null ? (
          <p
            title={regions}
            className="truncate text-xs font-bold tracking-[0.14em] text-food-orange-strong uppercase"
          >
            {regions}
          </p>
        ) : null}
        <h3 className="font-display min-w-0 text-2xl leading-tight text-balance break-words text-ink">
          <Link
            to="/dishes/$dishId"
            params={{ dishId: dish.slug }}
            search={{ lang }}
            className="underline decoration-food-orange/60 underline-offset-4 hover:text-food-orange-strong"
          >
            {title}
          </Link>
        </h3>
        {alternate !== null ? (
          <p
            lang={alternate.languageTag}
            title={alternate.name}
            className="truncate text-sm font-semibold text-ink"
          >
            {alternate.name}
          </p>
        ) : null}
        <MuseReasonBlock copy={copy} dish={dish} liveMuse={provenance.kind === "muse-ranked"} />
        {description !== null ? (
          <p
            lang={descriptionLanguage}
            className="line-clamp-3 text-[0.95rem] leading-relaxed break-words text-pretty text-ink"
          >
            {description}
          </p>
        ) : null}
        {dish.categorySlugs.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {dish.categorySlugs.map((category) => (
              <li
                key={category}
                className="rounded-full border border-border-soft bg-cream px-2.5 py-0.5 text-xs font-bold text-muted"
              >
                {category}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-auto pt-3">
          <DishCardActions
            copy={copy}
            dishId={dish.id}
            dishSlug={dish.slug}
            lang={lang}
            returnTo={returnTo}
            session={session}
            status={statusForDish(favoriteStatus, dish.id)}
          />
        </div>
      </div>
    </article>
  );
}

/**
 * Loading skeleton mirroring the recommendation card: fixed media block,
 * origin/title/reason/description lines, and three footer pills — so content
 * resolves without layout shift. `sheet-compact` mirrors the dense
 * thumbnail row instead. Announced once via the caller's aria-busy
 * region, not per card.
 */
export function DishRecommendationCardSkeleton({
  presentation = "full",
}: {
  readonly presentation?: DishRecommendationPresentation | undefined;
} = {}) {
  if (presentation === "sheet-compact") {
    return (
      <div
        aria-hidden="true"
        className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border-soft bg-white"
      >
        <div className="flex gap-3 p-3">
          <div className="h-20 w-20 flex-none animate-pulse rounded-xl bg-border-soft motion-reduce:animate-none min-[400px]:h-24 min-[400px]:w-24 sm:h-[104px] sm:w-[104px]" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
            <div className="h-2.5 w-1/3 animate-pulse rounded bg-border-soft motion-reduce:animate-none" />
            <div className="h-6 w-3/4 animate-pulse rounded bg-border-soft motion-reduce:animate-none" />
            <div className="h-6 w-2/5 animate-pulse rounded bg-border-soft motion-reduce:animate-none" />
            <div className="h-3.5 w-full animate-pulse rounded bg-cream motion-reduce:animate-none" />
            <div className="h-3.5 w-5/6 animate-pulse rounded bg-cream motion-reduce:animate-none" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-border-soft px-3 py-2.5">
          <div className="h-11 w-24 animate-pulse rounded-full bg-cream motion-reduce:animate-none" />
          <div className="h-11 w-28 animate-pulse rounded-full bg-cream motion-reduce:animate-none" />
          <div className="h-11 w-24 animate-pulse rounded-full bg-cream motion-reduce:animate-none" />
        </div>
      </div>
    );
  }

  return (
    <div
      aria-hidden="true"
      className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-border-soft bg-white"
    >
      <div className="aspect-[16/10] w-full flex-none animate-pulse bg-cream motion-reduce:animate-none" />
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 sm:p-5">
        <div className="h-3 w-1/3 animate-pulse rounded bg-border-soft motion-reduce:animate-none" />
        <div className="h-7 w-3/4 animate-pulse rounded bg-border-soft motion-reduce:animate-none" />
        <div className="h-16 w-full animate-pulse rounded-xl bg-cream motion-reduce:animate-none" />
        <div className="h-4 w-full animate-pulse rounded bg-cream motion-reduce:animate-none" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-cream motion-reduce:animate-none" />
        <div className="mt-auto flex flex-wrap gap-2 pt-3">
          <div className="h-11 w-24 animate-pulse rounded-full bg-cream motion-reduce:animate-none" />
          <div className="h-11 w-28 animate-pulse rounded-full bg-cream motion-reduce:animate-none" />
          <div className="h-11 w-24 animate-pulse rounded-full bg-cream motion-reduce:animate-none" />
        </div>
      </div>
    </div>
  );
}
