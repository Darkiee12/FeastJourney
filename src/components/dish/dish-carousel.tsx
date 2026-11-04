import { Link } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  StoreIcon,
  UtensilsCrossedIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";

import { DishActions, dishRestaurantsSearch } from "@/components/dish/dish-actions";
import { DishMedia } from "@/components/dish/dish-media";
import { usePrefersReducedMotion } from "@/components/home/globe/use-prefers-reduced-motion";
import type { DishCardImage, DishSummary } from "@/modules/food-discovery/server/domain/dish";
import type { PublishedDishImage } from "@/modules/food-discovery/server/operations/dish-media-service";
import type { CarouselCard } from "@/modules/food-discovery/server/operations/dish-service";
import {
  SaveDishButton,
  statusForDish,
  type FavoriteStatusQuery,
} from "@/modules/user/components/save-dish-button";
import type { SessionState } from "@/modules/user/session.functions";
import type { Locale, Messages } from "@/shared/i18n";

/**
 * Items the shared carousel consumes. `CarouselCard` (local discovery
 * projection) and `DishSummary` (recommendations, lists) share the fields
 * the slide renders; the helpers below normalize the optional sides so no
 * caller invents a third DTO.
 */
export type DishCarouselItem = CarouselCard | DishSummary;

/** Default autoplay cadence; discovery passes `autoplay` without a value. */
export const DISH_CAROUSEL_AUTOPLAY_MS = 6000;

/**
 * Stable media/stage geometry tokens (PR13 media slice). Mobile frames the
 * photo at a bounded height so intrinsic image size can never resize the
 * slide; desktop pins the whole slide to a stable stage height (capped
 * against short viewports at the call site) while long text scrolls
 * inside. Applied as custom properties on the carousel section; every
 * `var()` use carries the literal as fallback so geometry holds even if
 * the section style is lost.
 */
export const DISH_FEATURE_MEDIA_MOBILE = "clamp(180px, 48vw, 240px)";
export const DISH_FEATURE_STAGE_DESKTOP = "clamp(330px, 34vw, 410px)";

/**
 * Custom-property geometry for the carousel section. React.CSSProperties
 * carries no index for `--*` tokens; this structural extension keeps the
 * style prop fully typed with no assertion at any call site.
 */
export interface DishCarouselGeometryStyle extends CSSProperties {
  readonly "--dish-feature-media-mobile": string;
  readonly "--dish-feature-stage-desktop": string;
}

export const DISH_CAROUSEL_GEOMETRY: DishCarouselGeometryStyle = {
  "--dish-feature-media-mobile": DISH_FEATURE_MEDIA_MOBILE,
  "--dish-feature-stage-desktop": DISH_FEATURE_STAGE_DESKTOP,
};

const SWIPE_THRESHOLD_PX = 48;
const INGREDIENT_PREVIEW_COUNT = 6;

/** Wrap a slide index into `[0, total)`; empty input stays at 0. */
export const carouselWrappedIndex = (next: number, total: number): number => {
  if (total <= 0) {
    return 0;
  }

  return ((next % total) + total) % total;
};

/** Screen-reader announcement for a manual slide change. */
export const carouselAnnouncement = (copy: Messages, index: number, total: number): string =>
  `${copy.carouselSlide} ${index + 1} ${copy.carouselOf} ${total}`;

export const dishCarouselTitle = (item: DishCarouselItem): string =>
  item.name ?? item.englishName ?? item.slug;

/** Display ingredient names for the slide preview, capped at six. */
export const dishCarouselIngredientNames = (item: DishCarouselItem): Array<string> =>
  (item.ingredients ?? [])
    .map((entry) => entry.name ?? null)
    .filter((name): name is string => name !== null)
    .slice(0, INGREDIENT_PREVIEW_COUNT);

/**
 * Single place owning card-image normalization. Both projections already
 * carry the published+ready shape; every field falls back defensively so
 * older payloads still render (without srcSet/focal/dimensions) instead of
 * crashing. `license` never crosses into the public shape — publication
 * licensing is enforced at the publish boundary. Never invents a photo:
 * absent input projects to null and the slide renders the honest fallback.
 */
export const toCarouselPublishedImage = (
  image: DishCardImage | PublishedDishImage | null | undefined,
  dishId: string,
): PublishedDishImage | null => {
  if (image === null || image === undefined) {
    return null;
  }

  return {
    id: image.id ?? dishId,
    dishId: image.dishId ?? dishId,
    url: image.url,
    srcSet: image.srcSet ?? null,
    alt: image.alt,
    attribution: image.attribution,
    focalX: image.focalX ?? null,
    focalY: image.focalY ?? null,
    width: image.width ?? null,
    height: image.height ?? null,
  };
};

/** Maximum dot buttons rendered; the compact counter carries the exact total. */
export const MAX_VISIBLE_CAROUSEL_DOTS = 5;

/**
 * Windowed dot indexes around the active slide. Small sets render every
 * dot; large sets render a sliding window of five so the control row never
 * turns into dot noise. The full range stays reachable via prev/next,
 * arrows, and swipe. Exported pure so the windowing is unit-testable
 * without a DOM renderer.
 */
export const carouselVisibleDots = (total: number, active: number): Array<number> => {
  if (total <= MAX_VISIBLE_CAROUSEL_DOTS) {
    return Array.from({ length: Math.max(total, 0) }, (_, dot) => dot);
  }

  const start = Math.min(Math.max(active - 2, 0), total - MAX_VISIBLE_CAROUSEL_DOTS);

  return Array.from({ length: MAX_VISIBLE_CAROUSEL_DOTS }, (_, offset) => start + offset);
};

/**
 * Visible progress noun ("Dish"/"Món"). Inline until the coordinator-owned
 * i18n key lands (reported: `carouselDish`); mirrors the existing inline
 * `lang === "vi"` precedent in discovery-section.
 */
export const dishCounterNoun = (lang: Locale): string => (lang === "vi" ? "Món" : "Dish");

/** Display index resolution shared by both carousel modes. The controlled
 * `activeIndex` wins when provided; otherwise the internal fallback (the
 * uncontrolled state) shows. Out-of-range values wrap; empty input stays
 * at 0. Exported so the controlled-mode contract is unit-testable without
 * a DOM renderer. */
export const carouselDisplayIndex = (
  activeIndex: number | undefined,
  fallbackIndex: number,
  total: number,
): number => carouselWrappedIndex(activeIndex ?? fallbackIndex, total);

export interface DishCarouselProps {
  /** One to ten dishes; empty states stay with the caller (no empty carousel). */
  readonly items: ReadonlyArray<DishCarouselItem>;
  readonly copy: Messages;
  readonly lang: Locale;
  readonly session: SessionState;
  readonly favoriteStatus: FavoriteStatusQuery;
  /** Accessible name for the carousel region (the visible heading text). */
  readonly label: string;
  /**
   * Controlled selected slide. When set, the parent owns the index: the
   * carousel renders it (wrapped into range) and reports every user or
   * autoplay change through `onIndexChange` instead of moving internal
   * state. Omit for the default uncontrolled behavior (Discover).
   */
  readonly activeIndex?: number | undefined;
  /**
   * Fires with the wrapped index on every slide change — prev/next, dots,
   * arrows, swipe, and autoplay — in both modes. The rail parent passes a
   * state setter here; uncontrolled callers may omit it.
   */
  readonly onIndexChange?: ((index: number) => void) | undefined;
  /** Autoplay timer; defaults to off (recommendation results stay still). */
  readonly autoplay?: boolean | undefined;
  readonly autoplayMs?: number | undefined;
  /** Index resets to the first slide whenever this value changes. */
  readonly resetKey?: string | number | undefined;
  /**
   * Reports guest save-sheet open state upward (e.g. so a hosting drawer
   * can defer its own Escape handling while the nested sheet owns the key).
   * Optional; omitted callers are unaffected.
   */
  readonly onSaveSheetOpenChange?: ((open: boolean) => void) | undefined;
  /**
   * Slide presentation. `full` is the featured stacked/side-by-side card
   * for desktop and discovery. `compact` is the drawer-first horizontal
   * thumbnail row (fixed square thumbnail left, dish details right,
   * arrows only) sized to fit a ~46dvh bottom sheet without scrolling.
   * State, autoplay, swipe, and keyboard handling are identical in both.
   * `compact` never renders the full-bleed photo, the overlay Save, or a
   * second region line: one thumbnail, one footer Save, one region label.
   */
  readonly layout?: DishCarouselLayout | undefined;
  /**
   * Optional per-render reason/explanation node (the active dish's Muse
   * reason). Rendered as a full-width top strip INSIDE every full-layout
   * card — above the image and details, sharing the card border — with a
   * reserved height (fixed on desktop, three-line clamp on mobile), so
   * reason length never resizes the slide or stage across slide changes.
   * In compact layout the same node renders inline inside the text
   * column (concise, no reserved box). Omit when unavailable: no empty
   * strip is reserved, so deterministic and degraded results render no
   * Muse container at all.
   */
  readonly reason?: ReactNode | undefined;
}

/**
 * Typed explicit presentation variant for dish surfaces. `full` is the
 * featured card (desktop/discovery); `compact` is the sheet-compact
 * thumbnail row (bottom sheets, quiz drawer results). The rail
 * (`RecommendationRail`) is the third surface: a selection mirror with
 * no state of its own. Callers pick one variant explicitly — no viewport
 * sniffing inside components.
 */
export type DishCarouselLayout = "full" | "compact";

/**
 * Shared featured-slide dish carousel: one large image+info slide at a
 * time (bounded-height frame on mobile, side-by-side on desktop with a
 * stable stage height), prev/next arrows, arrow-key and touch-swipe
 * navigation, autoplay that pauses on hidden tabs and never runs under
 * reduced motion, and inert+hidden inactive slides so keyboard focus
 * never lands off-screen. Media frames reserve geometry up front and
 * fill with object-cover, so intrinsic image size, missing photos, and
 * skeletons share the same footprint. Actions ride one shared
 * `DishActions` row (Explore, Save, Find restaurants) with identical
 * order, icons, and targets in both layouts. Recommendation-specific
 * content (AI note, summary, warnings) stays with the caller, outside
 * this component, except for the reserved `reason` slot: a top strip in
 * full layout, an inline concise block in the compact text column.
 */
export function DishCarousel({
  activeIndex,
  autoplay = false,
  autoplayMs = DISH_CAROUSEL_AUTOPLAY_MS,
  copy,
  favoriteStatus,
  items,
  label,
  lang,
  layout = "full",
  onIndexChange,
  onSaveSheetOpenChange,
  reason,
  resetKey,
  session,
}: DishCarouselProps): ReactNode {
  const controlled = activeIndex !== undefined;
  const [uncontrolledIndex, setUncontrolledIndex] = useState(0);
  const [activeResetKey, setActiveResetKey] = useState(resetKey);

  const [tabVisible, setTabVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );

  const [announcement, setAnnouncement] = useState("");
  const touchStartX = useRef<number | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  // Render-time reset (the endorsed pattern): the discarded render never
  // commits, so no stale-index frame paints when the scope or rotation
  // changes underneath the carousel. Controlled parents own the reset and
  // return `activeIndex` to 0 alongside the new `resetKey`; uncontrolled
  // mode resets its internal index here.
  if (resetKey !== activeResetKey) {
    setActiveResetKey(resetKey);

    if (!controlled) {
      setUncontrolledIndex(0);
    }
  }

  const total = items.length;

  // The ONLY automatic suspension conditions are reduced motion, a hidden
  // browser tab, and opt-out/single-slide states. No hover, focus, or
  // offscreen stopping: pausing on hover made autoplay look broken.
  const running = autoplay && tabVisible && !reducedMotion && total > 1 && autoplayMs > 0;

  useEffect(() => {
    const onVisibilityChange = (): void => {
      setTabVisible(document.visibilityState === "visible");
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const safeIndex = carouselDisplayIndex(activeIndex, uncontrolledIndex, total);

  // Callback-identity guard: an inline `onIndexChange` must never wedge the
  // cadence, so the timer reads it through a ref while depending only on
  // values it actually consumes.
  const onIndexChangeRef = useRef(onIndexChange);
  useEffect(() => {
    onIndexChangeRef.current = onIndexChange;
  });

  useEffect(() => {
    if (!running) {
      return undefined;
    }

    // Self-perpetuating one-shot: every committed transition (auto or
    // manual) changes `safeIndex`, which reschedules a fresh full delay —
    // so the timer can neither stall (while the index keeps moving) nor
    // double-fire, and a manual pick never jumps immediately. Exactly one
    // timeout exists at a time; cleanup clears it on re-run and unmount
    // (StrictMode-safe). `controlled` is read directly (a stable boolean);
    // the callback goes through a ref. Autoplay advances silently: manual
    // navigation announces via the live region, the timer never spams
    // screen readers.
    const timer = window.setTimeout(() => {
      const wrapped = carouselWrappedIndex(safeIndex + 1, total);

      if (!controlled) {
        setUncontrolledIndex(wrapped);
      }

      onIndexChangeRef.current?.(wrapped);
    }, autoplayMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [running, total, autoplayMs, safeIndex, controlled]);

  // Empty states stay with the caller; every hook above still ran.
  if (total === 0) {
    return null;
  }

  const goTo = (next: number): void => {
    const wrapped = carouselWrappedIndex(next, total);

    // The index change reschedules the autoplay timer for a full delay,
    // so a manual pick never jumps immediately.
    if (!controlled) {
      setUncontrolledIndex(wrapped);
    }

    onIndexChange?.(wrapped);
    setAnnouncement(carouselAnnouncement(copy, wrapped, total));
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === "ArrowLeft") {
      goTo(safeIndex - 1);
    } else if (event.key === "ArrowRight") {
      goTo(safeIndex + 1);
    }
  };

  const handleTouchStart = (event: ReactTouchEvent<HTMLElement>): void => {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  };

  const handleTouchEnd = (event: ReactTouchEvent<HTMLElement>): void => {
    const start = touchStartX.current;
    const end = event.changedTouches[0]?.clientX ?? null;
    touchStartX.current = null;

    if (start === null || end === null) {
      return;
    }

    const delta = end - start;

    if (delta <= -SWIPE_THRESHOLD_PX) {
      goTo(safeIndex + 1);
    } else if (delta >= SWIPE_THRESHOLD_PX) {
      goTo(safeIndex - 1);
    }
  };

  if (layout === "compact") {
    return (
      <section aria-roledescription="carousel" aria-label={label} style={DISH_CAROUSEL_GEOMETRY}>
        <output aria-live="polite" className="sr-only">
          {announcement}
        </output>
        <div className="mb-1.5 flex min-w-0 items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-[11px] font-bold tracking-[0.14em] text-food-orange-strong uppercase">
            {label}
          </p>
          {total > 1 ? (
            <>
              <button
                type="button"
                onClick={() => {
                  goTo(safeIndex - 1);
                }}
                onKeyDown={handleKeyDown}
                aria-label={copy.carouselPrev}
                className="inline-flex min-h-11 min-w-11 flex-none cursor-pointer items-center justify-center rounded-full border-2 border-ink bg-white px-2 text-sm font-bold text-ink transition hover:bg-ink hover:text-white"
              >
                <ChevronLeftIcon aria-hidden="true" className="size-4 flex-none" />
              </button>
              <button
                type="button"
                onClick={() => {
                  goTo(safeIndex + 1);
                }}
                onKeyDown={handleKeyDown}
                aria-label={copy.carouselNext}
                className="inline-flex min-h-11 min-w-11 flex-none cursor-pointer items-center justify-center rounded-full border-2 border-ink bg-white px-2 text-sm font-bold text-ink transition hover:bg-ink hover:text-white"
              >
                <ChevronRightIcon aria-hidden="true" className="size-4 flex-none" />
              </button>
            </>
          ) : null}
        </div>
        {/* The two arrows above are the entire visible compact navigation:
            no dots, counters, progress bars, or rails. Screen-reader
            announcements and slide labels keep carousel semantics. */}
        <div
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          className="discover-carousel-viewport touch-pan-y"
        >
          <div
            className="discover-carousel-track"
            style={{ transform: `translateX(-${safeIndex * 100}%)` }}
          >
            {items.map((dish, slide) => {
              const title = dishCarouselTitle(dish);
              const shown = slide === safeIndex;
              const description = dish.description ?? null;

              const descriptionLanguage =
                dish.descriptionLanguage !== null &&
                dish.descriptionLanguage !== undefined &&
                dish.descriptionLanguage !== lang
                  ? dish.descriptionLanguage
                  : undefined;

              // Alternate name only when distinct: identical names never
              // render twice.
              const nativeName =
                dish.nativeName !== undefined && dish.nativeName !== title ? dish.nativeName : null;

              // The ONLY region label in compact: the header above names
              // the section, so the eyebrow here is the single
              // cuisine/origin line per card.
              const regions =
                dish.regionNames.length > 0 ? dish.regionNames.slice(0, 2).join(" · ") : null;

              return (
                <article
                  key={dish.id}
                  aria-label={`${copy.carouselSlide} ${slide + 1} ${copy.carouselOf} ${total}`}
                  aria-hidden={shown ? undefined : true}
                  inert={shown ? undefined : true}
                  className="w-full flex-none overflow-hidden rounded-2xl border border-border-soft bg-white shadow-[0_12px_28px_rgba(194,65,12,0.08)]"
                >
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
                          eager={slide === 0}
                          sizes="(max-width: 400px) 96px, 120px"
                          unavailableLabel={copy.carouselPhotoSoon}
                          loadingLabel={title}
                          className="absolute inset-0 h-full w-full"
                        />
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {regions !== null ? (
                        <p className="truncate text-[11px] font-bold tracking-[0.14em] text-food-orange-strong uppercase">
                          {regions}
                        </p>
                      ) : null}
                      <h3 className="font-display line-clamp-2 min-h-[2.5em] min-w-0 text-lg leading-snug text-balance break-words text-ink">
                        {title}
                      </h3>
                      {nativeName !== null ? (
                        <p
                          lang={dish.nativeLanguageTag}
                          className="truncate text-[13px] font-semibold text-ink"
                        >
                          {nativeName}
                        </p>
                      ) : null}
                      {reason !== undefined ? <div className="min-w-0">{reason}</div> : null}
                      {description !== null ? (
                        <p
                          lang={descriptionLanguage}
                          className="line-clamp-2 min-h-[2.6em] text-[13px] leading-relaxed break-words text-ink"
                        >
                          {description}
                        </p>
                      ) : (
                        <p className="min-h-[2.6em] text-[13px] text-muted italic">
                          {copy.carouselNoDescription}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 border-t border-border-soft px-3 py-2.5">
                    <SaveDishButton
                      dishId={dish.id}
                      lang={lang}
                      onSaveSheetOpenChange={onSaveSheetOpenChange}
                      returnTo="/"
                      session={session}
                      status={statusForDish(favoriteStatus, dish.id)}
                    />
                    <Link
                      to="/restaurants"
                      search={dishRestaurantsSearch(dish.id, dish.slug, lang)}
                      tabIndex={shown ? undefined : -1}
                      aria-label={copy.recFindRestaurants}
                      title={copy.recFindRestaurants}
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-full border-2 border-ink bg-white px-4 text-sm font-bold text-ink transition hover:bg-ink hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    >
                      <StoreIcon aria-hidden="true" className="size-4 flex-none" />
                      {copy.recFindRestaurants}
                    </Link>
                    <Link
                      to="/dishes/$dishId"
                      params={{ dishId: dish.slug }}
                      search={{ lang }}
                      tabIndex={shown ? undefined : -1}
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-full border-2 border-food-orange-strong bg-food-orange-strong px-4 text-sm font-bold text-white transition hover:bg-food-orange-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    >
                      <ArrowUpRightIcon aria-hidden="true" className="size-4 flex-none" />
                      {copy.recViewDish}
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-roledescription="carousel" aria-label={label} style={DISH_CAROUSEL_GEOMETRY}>
      <output aria-live="polite" className="sr-only">
        {announcement}
      </output>
      <div
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className="discover-carousel-viewport touch-pan-y"
      >
        <div
          className="discover-carousel-track"
          style={{ transform: `translateX(-${safeIndex * 100}%)` }}
        >
          {items.map((dish, slide) => {
            const title = dishCarouselTitle(dish);
            const shown = slide === safeIndex;
            const ingredientNames = dishCarouselIngredientNames(dish);
            const description = dish.description ?? null;

            const descriptionLanguage =
              dish.descriptionLanguage !== null &&
              dish.descriptionLanguage !== undefined &&
              dish.descriptionLanguage !== lang
                ? dish.descriptionLanguage
                : undefined;

            return (
              <article
                key={dish.id}
                aria-label={`${copy.carouselSlide} ${slide + 1} ${copy.carouselOf} ${total}`}
                aria-hidden={shown ? undefined : true}
                inert={shown ? undefined : true}
                className="grid w-full flex-none gap-0 overflow-hidden rounded-3xl border border-border-soft bg-white shadow-[0_12px_28px_rgba(194,65,12,0.08)] md:h-[var(--dish-feature-stage-desktop,clamp(330px,34vw,410px))] md:max-h-[calc(100svh-8rem)] md:grid-cols-[45%_55%] md:grid-rows-[auto_minmax(0,1fr)]"
              >
                {reason !== undefined ? (
                  <div className="max-h-44 overflow-y-auto border-b border-border-soft bg-cream/60 px-6 py-3 sm:px-8 md:col-span-2 md:h-32 md:max-h-none">
                    {reason}
                  </div>
                ) : null}
                <div
                  className="relative h-[var(--dish-feature-media-mobile,clamp(180px,48vw,240px))] w-full overflow-hidden bg-gradient-to-br from-food-orange-strong via-food-orange to-mango md:h-full md:min-h-0"
                  title={dish.image?.attribution ?? undefined}
                >
                  <DishMedia
                    image={toCarouselPublishedImage(dish.image ?? null, dish.id)}
                    eager={slide === 0}
                    sizes="(max-width:640px) 100vw, 50vw"
                    unavailableLabel={copy.carouselPhotoSoon}
                    loadingLabel={copy.discoverLocalLoading}
                    className="absolute inset-0 h-full w-full"
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-2 p-6 sm:p-8 md:min-h-0 md:overflow-hidden">
                  {dish.regionNames.length > 0 ? (
                    <p className="text-xs font-bold tracking-[0.18em] text-food-orange-strong uppercase">
                      {dish.regionNames.slice(0, 2).join(" · ")}
                    </p>
                  ) : null}
                  <h3 className="font-display text-4xl leading-none tracking-wide text-balance sm:text-5xl">
                    {title}
                  </h3>
                  {dish.nativeName !== undefined ? (
                    <p lang={dish.nativeLanguageTag} className="text-xl font-bold text-ink">
                      {dish.nativeName}
                    </p>
                  ) : null}
                  <div className="mt-1 min-h-0 md:flex-1 md:overflow-y-auto md:overscroll-contain">
                    {description !== null ? (
                      <p
                        lang={descriptionLanguage}
                        className="line-clamp-4 text-[0.95rem] leading-relaxed text-ink"
                      >
                        {description}
                      </p>
                    ) : (
                      <p className="text-sm text-muted italic">{copy.carouselNoDescription}</p>
                    )}
                    {ingredientNames.length > 0 ? (
                      <div className="mt-1">
                        <p className="text-xs font-bold tracking-[0.18em] text-muted uppercase">
                          {copy.carouselIngredients}
                        </p>
                        <p className="mt-1 text-sm font-semibold text-ink">
                          {ingredientNames.join(" · ")}
                        </p>
                      </div>
                    ) : (
                      <p className="mt-1 text-sm text-muted italic">{copy.carouselNoIngredients}</p>
                    )}
                  </div>
                  <div className="mt-auto flex-none pt-4">
                    <DishActions
                      copy={copy}
                      dishId={dish.id}
                      dishSlug={dish.slug}
                      lang={lang}
                      onSaveSheetOpenChange={onSaveSheetOpenChange}
                      returnTo="/"
                      session={session}
                      status={statusForDish(favoriteStatus, dish.id)}
                      tabIndex={shown ? undefined : -1}
                    />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
      {total > 1 ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              goTo(safeIndex - 1);
            }}
            onKeyDown={handleKeyDown}
            aria-label={copy.carouselPrev}
            className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full border-2 border-ink bg-white px-3 text-sm font-bold text-ink transition hover:bg-ink hover:text-white"
          >
            <ChevronLeftIcon aria-hidden="true" className="size-4 flex-none" />
          </button>
          <button
            type="button"
            onClick={() => {
              goTo(safeIndex + 1);
            }}
            onKeyDown={handleKeyDown}
            aria-label={copy.carouselNext}
            className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full border-2 border-ink bg-white px-3 text-sm font-bold text-ink transition hover:bg-ink hover:text-white"
          >
            <ChevronRightIcon aria-hidden="true" className="size-4 flex-none" />
          </button>
          {/* No dots, counter, progress bar, or pause control by design:
              two arrows are the entire visible navigation. Screen-reader
              announcements and slide labels keep carousel semantics. */}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Compact loading skeleton mirroring the compact thumbnail-row card: label
 * bar plus arrows, a fixed square thumbnail with region/title/description
 * lines, and the title-aligned action row as three 44px round placeholders
 * (Explore, Save, Find via the shared DishActions row) — never footer
 * pills — so content resolves without layout shift. Announced once via
 * the caller's loading region, not here.
 */
export function DishCarouselCompactSkeleton(): ReactNode {
  return (
    <div aria-hidden="true" style={DISH_CAROUSEL_GEOMETRY}>
      <div className="mb-1.5 flex items-center gap-2">
        <div className="h-2.5 min-w-0 flex-1 animate-pulse rounded bg-border-soft motion-reduce:animate-none" />
        <div className="min-h-11 min-w-11 flex-none animate-pulse rounded-full bg-border-soft motion-reduce:animate-none" />
        <div className="min-h-11 min-w-11 flex-none animate-pulse rounded-full bg-border-soft motion-reduce:animate-none" />
      </div>
      <div className="w-full overflow-hidden rounded-2xl border border-border-soft bg-white">
        <div className="flex gap-3 p-3">
          <div className="h-20 w-20 flex-none animate-pulse rounded-xl bg-border-soft motion-reduce:animate-none min-[400px]:h-24 min-[400px]:w-24 sm:h-[104px] sm:w-[104px]" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
            <div className="h-2.5 w-1/3 animate-pulse rounded bg-border-soft motion-reduce:animate-none" />
            <div className="flex min-w-0 items-start gap-2">
              <div className="h-6 min-w-0 flex-1 animate-pulse rounded bg-border-soft motion-reduce:animate-none" />
              <div className="h-11 w-11 flex-none animate-pulse rounded-full bg-cream motion-reduce:animate-none" />
              <div className="h-11 w-11 flex-none animate-pulse rounded-full bg-cream motion-reduce:animate-none" />
              <div className="h-11 w-11 flex-none animate-pulse rounded-full bg-cream motion-reduce:animate-none" />
            </div>
            <div className="h-3.5 w-full animate-pulse rounded bg-cream motion-reduce:animate-none" />
            <div className="h-3.5 w-5/6 animate-pulse rounded bg-cream motion-reduce:animate-none" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Loading skeleton mirroring the featured-slide layout: bounded-height
 * media frame plus text lines at the same padding, so content resolves
 * without layout shift. Announced once via the caller's loading region,
 * not here.
 */
export function DishCarouselSkeleton(): ReactNode {
  return (
    <div
      aria-hidden="true"
      style={DISH_CAROUSEL_GEOMETRY}
      className="grid w-full gap-0 overflow-hidden rounded-3xl border border-border-soft bg-white md:h-[var(--dish-feature-stage-desktop,clamp(330px,34vw,410px))] md:grid-cols-[45%_55%]"
    >
      <div className="h-[var(--dish-feature-media-mobile,clamp(180px,48vw,240px))] w-full animate-pulse bg-border-soft motion-reduce:animate-none md:h-full md:min-h-0" />
      <div
        className="flex min-w-0 flex-1 flex-col gap-2 p-6 sm:p-8 md:min-h-0 md:overflow-hidden"
        aria-hidden="true"
      >
        <div className="h-3 w-1/3 animate-pulse rounded bg-border-soft motion-reduce:animate-none" />
        <div className="h-10 w-3/4 animate-pulse rounded bg-border-soft motion-reduce:animate-none" />
        <div className="h-4 w-full animate-pulse rounded bg-cream motion-reduce:animate-none" />
        <div className="h-4 w-full animate-pulse rounded bg-cream motion-reduce:animate-none" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-cream motion-reduce:animate-none" />
        <div className="mt-auto flex flex-none items-center gap-1.5 pt-4">
          <div className="h-11 w-11 animate-pulse rounded-full bg-cream motion-reduce:animate-none" />
          <div className="h-11 w-11 animate-pulse rounded-full bg-cream motion-reduce:animate-none" />
          <div className="h-11 w-11 animate-pulse rounded-full bg-cream motion-reduce:animate-none" />
        </div>
      </div>
    </div>
  );
}
