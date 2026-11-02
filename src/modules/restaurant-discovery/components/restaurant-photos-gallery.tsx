import { Store } from "lucide-react";

import type { PhotoRef } from "@/modules/restaurant-discovery/components/restaurant-photos";

/**
 * One published venue photo. Width/height attributes reserve the exact
 * aspect before bytes arrive, so the card never shifts layout. `srcSet`
 * serves the smallest adequate derivative; nothing here invents photos —
 * parents render the branded fallback when the set is empty.
 */
export function RestaurantPhoto({
  photo,
  className,
  eager,
}: {
  readonly photo: PhotoRef;
  readonly className?: string | undefined;
  readonly eager?: boolean | undefined;
}) {
  const largest = photo.variants[photo.variants.length - 1];

  if (largest === undefined) {
    return null;
  }

  return (
    <img
      className={className}
      src={largest.url}
      srcSet={photo.variants.map((variant) => `${variant.url} ${variant.width}w`).join(", ")}
      sizes="(max-width: 640px) 100vw, 400px"
      width={photo.width}
      height={photo.height}
      alt={photo.alt}
      loading={eager === true ? "eager" : "lazy"}
      decoding="async"
    />
  );
}

/**
 * Compact branded fallback for venues with no published photos. A small
 * Store icon tile with the same footprint contract as a photo, plus a
 * screen-reader label — never a giant initial banner, never invented
 * imagery.
 */
export function RestaurantPhotoFallback({
  name,
  className,
  label,
}: {
  readonly name: string;
  readonly className?: string | undefined;
  readonly label?: string | undefined;
}) {
  return (
    <div className={className} role="presentation">
      <Store aria-hidden="true" />
      <span className="sr-only">{label ?? `No verified photo for ${name}`}</span>
    </div>
  );
}

/**
 * Detail gallery: primary photo first, the published set in sort order.
 * Empty sets render one compact fallback tile with a screen-reader label,
 * never an empty frame or a photo-unavailable paragraph.
 */
export function RestaurantPhotoGallery({
  photos,
  venueName,
  emptyLabel,
}: {
  readonly photos: ReadonlyArray<PhotoRef>;
  readonly venueName: string;
  readonly emptyLabel?: string | undefined;
}) {
  if (photos.length === 0) {
    return (
      <div className="res-gallery-empty" aria-live="polite">
        <RestaurantPhotoFallback
          name={venueName}
          className="res-photo"
          label={emptyLabel ?? `No verified photo for ${venueName}`}
        />
      </div>
    );
  }

  return (
    <ul className="res-gallery" aria-label={`Photos of ${venueName}`}>
      {photos.map((photo, index) => (
        <li key={photo.assetId} className="res-gallery-item">
          <figure>
            <RestaurantPhoto photo={photo} className="res-gallery-img" eager={index === 0} />
            <figcaption className="res-gallery-cap">{photo.alt}</figcaption>
          </figure>
        </li>
      ))}
    </ul>
  );
}
