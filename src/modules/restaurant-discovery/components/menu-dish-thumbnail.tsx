import { UtensilsCrossed } from "lucide-react";

/**
 * Dish thumbnail for compact menu rows and detail views (Agent C).
 *
 * Contract: Agent A renders this inside rows and detail views. Agent A owns
 * layout and data fetching; this component owns only the 68px thumbnail
 * footprint and the photo-vs-fallback decision. It never fetches, never
 * invents imagery, and never imports server code.
 *
 * Three photo kinds stay distinct — this component renders ONLY a resolved,
 * published, item-associated dish photograph passed in as `media`:
 * - restaurant (venue) photos are venue-level (`PhotoRef`, `/api/v1/restaurant-images/...`);
 * - menu-page photographs are page-level (`MenuPagePublicView`, `/api/v1/menu-pages/...`);
 * - canonical dish photos are dish-level (`PublishedDishImage`, `/api/v1/dish-images/...`).
 * Never pass any of those as `media`. A menu-page scan, a storefront photo,
 * a stock photo, or a canonical-dish photo is not an item thumbnail.
 *
 * No published item-associated photos exist in restaurant-discovery today
 * (`menu.sql` carries item/variant/dish ids but zero photo columns; reviewed
 * `presentReviewed` sets `assetIds: []`; `getRestaurant` returns venue-level
 * photos only). Until a small additive item-photo association lands in the
 * existing media ownership/editorial pipeline (draft → review → published
 * with license/attribution/alt/dimension/derivative gates + audit, same as
 * the venue/menu-page/dish pipelines), callers pass `media: null` and this
 * renders the neutral icon fallback. The compact-list redesign must NOT
 * depend on that future association.
 *
 * When `media` is present, the caller guarantees it came from the authorized
 * same-origin delivery service only, for a published row: reserved `width` /
 * `height` (> 0), non-empty `alt`, responsive `srcSet`/`sizes` where
 * available, `loading="lazy"` + `decoding="async"`, fixed 68px footprint so
 * rows never shift layout. Attribution rides as `title` (detail views may
 * render `media.attribution` in full); the thumbnail itself stays 68px.
 */

export const MENU_DISH_THUMBNAIL_PX = 68;

export interface MenuDishThumbnailMedia {
  readonly src: string;
  readonly srcSet?: string | undefined;
  readonly sizes?: string | undefined;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
  readonly attribution?: string | null | undefined;
}

export type MenuDishThumbnailFallback = "icon";

export interface MenuDishThumbnailProps {
  readonly itemId: string;
  readonly itemName: string;
  readonly media: MenuDishThumbnailMedia | null;
  readonly fallbackMode?: MenuDishThumbnailFallback | undefined;
  readonly eager?: boolean | undefined;
  readonly className?: string | undefined;
  readonly fallbackLabel?: string | undefined;
}

const isRenderableMedia = (media: MenuDishThumbnailMedia): boolean => {
  if (media.src.trim().length === 0) {
    return false;
  }

  if (!Number.isFinite(media.width) || !Number.isFinite(media.height)) {
    return false;
  }

  if (media.width <= 0 || media.height <= 0) {
    return false;
  }

  if (media.alt.trim().length === 0) {
    return false;
  }

  return true;
};

export function MenuDishThumbnail({
  itemId,
  itemName,
  media,
  fallbackMode = "icon",
  eager = false,
  className,
  fallbackLabel,
}: MenuDishThumbnailProps): React.ReactNode {
  const boxStyle: React.CSSProperties = {
    aspectRatio: "1 / 1",
    height: MENU_DISH_THUMBNAIL_PX,
    width: MENU_DISH_THUMBNAIL_PX,
  };

  if (media === null || !isRenderableMedia(media)) {
    const label = fallbackLabel ?? `No verified photo for ${itemName}`;

    return (
      <div
        className={
          className ??
          "flex flex-none items-center justify-center rounded-xl border border-border-soft bg-cream/40"
        }
        data-fallback-mode={fallbackMode}
        data-item-id={itemId}
        data-thumbnail="fallback"
        title={label}
        style={boxStyle}
      >
        <UtensilsCrossed aria-hidden="true" className="size-6 text-muted" />
        <span className="sr-only">{label}</span>
      </div>
    );
  }

  const attribution =
    media.attribution !== null &&
    media.attribution !== undefined &&
    media.attribution.trim().length > 0
      ? media.attribution
      : undefined;

  return (
    <div
      className={className ?? "flex-none overflow-hidden rounded-xl border border-border-soft"}
      data-fallback-mode={fallbackMode}
      data-item-id={itemId}
      data-thumbnail="photo"
      style={boxStyle}
    >
      <img
        src={media.src}
        srcSet={media.srcSet}
        sizes={
          media.srcSet !== undefined ? (media.sizes ?? `${MENU_DISH_THUMBNAIL_PX}px`) : undefined
        }
        width={media.width}
        height={media.height}
        alt={media.alt}
        title={attribution}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        draggable={false}
        style={{ aspectRatio: `${media.width} / ${media.height}`, height: "100%", width: "100%" }}
      />
      {attribution !== undefined ? <span className="sr-only">{attribution}</span> : null}
    </div>
  );
}
