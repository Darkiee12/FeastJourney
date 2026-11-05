import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
  carouselWrappedIndex,
  dishCarouselTitle,
  toCarouselPublishedImage,
  type DishCarouselItem,
} from "@/components/dish/dish-carousel";
import { DishMedia } from "@/components/dish/dish-media";
import { previewDescription, NearbyPriceLine } from "@/components/home/dish-recommendation-card";
import { usePrefersReducedMotion } from "@/components/home/globe/use-prefers-reduced-motion";
import {
  useNearbyPrices,
  type NearbyPriceRequest,
} from "@/components/home/recommend/use-nearby-prices";
import type { Locale, Messages } from "@/shared/i18n";

/**
 * Thumbnail sizes for the rail. Narrow on purpose: the rail must never
 * pull the full-bleed featured image (1600px candidates stay out of the
 * pick) and every thumbnail loads lazily.
 */
export const RECOMMENDATION_RAIL_THUMB_SIZES = "(max-width: 640px) 40vw, 160px";

export interface RecommendationRailProps {
  /**
   * The SAME ordered list the featured carousel renders (up to ten
   * dishes). Selection is by position, so both components must receive
   * the identical array reference or an identically ordered slice.
   */
  readonly items: ReadonlyArray<DishCarouselItem>;
  /** Shared selected slide; the rail mirrors it, never owns it. */
  readonly activeIndex: number;
  /** Fires with the tapped thumbnail's position; the parent sets the shared index. */
  readonly onSelect: (index: number) => void;
  readonly copy: Messages;
  readonly lang: Locale;
  /**
   * Visible heading + accessible name for the rail (e.g. the "More
   * recommendations" string). Passed in because the i18n key lands with
   * the lead's wiring, not this component.
   */
  readonly label: string;
  /**
   * Optional post-ranking enrichment for precise ("Near me") runs. When
   * present the rail fires the nearby-price lookup keyed by `runId` and
   * renders a price line under each priced dish. Null/omitted keeps the
   * rail exactly as before — no fetch, no placeholders. Ranking order and
   * selection never wait on prices.
   */
  readonly priceRequest?: NearbyPriceRequest | null | undefined;
}

/**
 * Synchronized "More recommendations" thumbnail rail. A horizontal
 * scroller of real dishes only — no placeholders, no filler cards, no
 * "see all" link, no ratings or scores. Tapping a thumbnail selects the
 * featured slide; the active thumbnail stays scrolled into view. The rail
 * renders nothing for empty or single-dish result sets.
 *
 * Uniform heights: every `li` stretches to the row height, each card is a
 * full-height flex column with reserved slots (region, two-line title,
 * one-line native name, two-line description preview), so no card can
 * drive its own height — no staircase. Prev/next controls render only
 * when the row actually overflows.
 */
export function RecommendationRail({
  activeIndex,
  copy,
  items,
  label,
  lang,
  onSelect,
  priceRequest,
}: RecommendationRailProps) {
  const total = items.length;
  const headingId = useId();
  const reducedMotion = usePrefersReducedMotion();
  const nearby = useNearbyPrices(priceRequest ?? null);
  const thumbRefs = useRef(new Map<number, HTMLButtonElement>());
  const scrollerRef = useRef<HTMLUListElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const reducedMotionRef = useRef(reducedMotion);

  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);

  const safeActive = carouselWrappedIndex(activeIndex, total);

  // Keep the active thumbnail visible with an explicit horizontal scroll
  // of the rail container only. Never call scrollIntoView: the featured
  // carousel auto-advances, and any vertical scroll would hijack the
  // document scroll position. Nearest-edge horizontal scrolling only;
  // reduced motion gets an instant jump instead of a smooth scroll.
  useEffect(() => {
    if (total <= 1) {
      return;
    }

    const scroller = scrollerRef.current;
    const thumb = thumbRefs.current.get(safeActive);

    if (scroller === null || thumb === undefined) {
      return;
    }

    const thumbLeft = thumb.offsetLeft;
    const thumbRight = thumbLeft + thumb.offsetWidth;
    const viewLeft = scroller.scrollLeft;
    const viewRight = viewLeft + scroller.clientWidth;
    const behavior = reducedMotionRef.current ? "auto" : "smooth";

    if (thumbLeft < viewLeft) {
      scroller.scrollTo({ left: thumbLeft - 12, behavior });
    } else if (thumbRight > viewRight) {
      scroller.scrollTo({ left: thumbRight - scroller.clientWidth + 12, behavior });
    }
  }, [safeActive, total]);

  // Measure overflow: nav controls exist only while the row scrolls.
  // Re-measured on scroll, resize, and item-count change.
  useEffect(() => {
    const scroller = scrollerRef.current;

    if (scroller !== null && total > 1) {
      const updateNav = (): void => {
        const max = scroller.scrollWidth - scroller.clientWidth;
        setCanScrollLeft(scroller.scrollLeft > 4);
        setCanScrollRight(scroller.scrollLeft < max - 4);
      };

      updateNav();
      scroller.addEventListener("scroll", updateNav, { passive: true });
      window.addEventListener("resize", updateNav);

      const observer =
        typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateNav);

      observer?.observe(scroller);

      return () => {
        scroller.removeEventListener("scroll", updateNav);
        window.removeEventListener("resize", updateNav);
        observer?.disconnect();
      };
    }

    return undefined;
  }, [total]);

  if (total <= 1) {
    return null;
  }

  const canScroll = canScrollLeft || canScrollRight;

  const scrollRail = (direction: 1 | -1): void => {
    const scroller = scrollerRef.current;

    if (scroller === null) {
      return;
    }

    scroller.scrollBy({
      left: direction * scroller.clientWidth * 0.8,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  };

  const handleThumbKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }

    event.preventDefault();

    const next =
      event.key === "ArrowRight"
        ? carouselWrappedIndex(safeActive + 1, total)
        : carouselWrappedIndex(safeActive - 1, total);

    onSelect(next);
    thumbRefs.current.get(next)?.focus();
  };

  return (
    <section aria-labelledby={headingId}>
      <div className="flex items-center justify-between gap-3">
        <h3 id={headingId} className="text-lg font-extrabold text-ink">
          {label}
        </h3>
        {canScroll ? (
          <div className="flex flex-none items-center gap-2">
            <button
              type="button"
              disabled={!canScrollLeft}
              aria-label={copy.carouselPrev}
              onClick={() => {
                scrollRail(-1);
              }}
              className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full border-2 border-ink bg-white px-3 text-sm font-bold text-ink transition hover:bg-ink hover:text-white disabled:cursor-default disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-ink motion-reduce:transition-none"
            >
              ←
            </button>
            <button
              type="button"
              disabled={!canScrollRight}
              aria-label={copy.carouselNext}
              onClick={() => {
                scrollRail(1);
              }}
              className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full border-2 border-ink bg-white px-3 text-sm font-bold text-ink transition hover:bg-ink hover:text-white disabled:cursor-default disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-ink motion-reduce:transition-none"
            >
              →
            </button>
          </div>
        ) : null}
      </div>
      <ul ref={scrollerRef} className="mt-3 flex items-stretch gap-3 overflow-x-auto pb-2">
        {items.map((dish, thumb) => {
          const title = dishCarouselTitle(dish);
          const selected = thumb === safeActive;

          const regions =
            dish.regionNames.length > 0 ? dish.regionNames.slice(0, 2).join(" · ") : null;

          const preview =
            dish.description === null || dish.description === undefined
              ? null
              : previewDescription(dish.description);

          // Priced dishes gain a glanceable line; every other state
          // (loading, failed, unpriced outcome) renders nothing so the
          // thumbnail keeps its current geometry.
          const nearbyPrice = nearby.prices.get(dish.id) ?? null;

          const descriptionLanguage =
            dish.descriptionLanguage !== null &&
            dish.descriptionLanguage !== undefined &&
            dish.descriptionLanguage !== lang
              ? dish.descriptionLanguage
              : undefined;

          return (
            <li key={dish.id} className="flex w-40 flex-none sm:w-52 lg:w-60">
              <button
                ref={(node) => {
                  if (node !== null) {
                    thumbRefs.current.set(thumb, node);
                  } else {
                    thumbRefs.current.delete(thumb);
                  }
                }}
                type="button"
                aria-current={selected ? true : undefined}
                aria-label={`${copy.carouselGoTo} ${thumb + 1}: ${title}`}
                onClick={() => {
                  onSelect(thumb);
                }}
                onKeyDown={handleThumbKeyDown}
                className={`group flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-2xl border-2 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink motion-reduce:transition-none ${
                  selected
                    ? "border-food-orange-strong bg-cream shadow-[0_8px_20px_rgba(194,65,12,0.22)]"
                    : "border-border-soft bg-white hover:border-food-orange"
                }`}
              >
                <span className="relative block aspect-[4/3] w-full shrink-0 overflow-hidden bg-gradient-to-br from-food-orange-strong via-food-orange to-mango">
                  {dish.image === undefined || dish.image === null ? (
                    <span
                      aria-hidden="true"
                      className="font-display grid h-full w-full place-items-center text-3xl text-white"
                    >
                      {title.slice(0, 1).toUpperCase()}
                    </span>
                  ) : (
                    <DishMedia
                      image={toCarouselPublishedImage(dish.image, dish.id)}
                      sizes={RECOMMENDATION_RAIL_THUMB_SIZES}
                      unavailableLabel={copy.carouselPhotoSoon}
                      loadingLabel={title}
                      className="absolute inset-0 h-full w-full"
                    />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col p-3">
                  <span className="block min-h-4 truncate text-[0.65rem] leading-4 font-bold tracking-[0.14em] text-food-orange-strong uppercase">
                    {regions ?? ""}
                  </span>
                  <span
                    title={title}
                    className="mt-0.5 line-clamp-2 block min-h-[2.75em] text-sm leading-snug font-extrabold break-words text-ink"
                  >
                    {title}
                  </span>
                  <span
                    lang={dish.nativeLanguageTag ?? undefined}
                    className="mt-0.5 block min-h-4 truncate text-xs font-semibold text-food-orange-strong"
                  >
                    {dish.nativeName ?? ""}
                  </span>
                  <span
                    lang={descriptionLanguage}
                    className="mt-1 line-clamp-2 block min-h-[3.25em] text-xs leading-relaxed break-words text-muted"
                  >
                    {preview ?? ""}
                  </span>
                  {nearbyPrice === null ? null : (
                    <NearbyPriceLine
                      dishId={dish.id}
                      dishSlug={dish.slug}
                      lang={lang}
                      price={nearbyPrice}
                    />
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
