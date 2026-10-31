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
 * Branded fallback for venues with no published photos. Same footprint
 * contract as a photo (initial tile), so cards keep their shape without
 * inventing imagery for real restaurants.
 */
export function RestaurantPhotoFallback({
  name,
  className,
}: {
  readonly name: string;
  readonly className?: string | undefined;
}) {
  const initial = name.charAt(0).toUpperCase() || "•";

  return (
    <div className={className} aria-hidden="true" role="presentation">
      <span>{initial}</span>
    </div>
  );
}

/**
 * Detail gallery: primary photo first, the published set in sort order.
 * Empty sets render one branded fallback tile, never an empty frame.
 */
export function RestaurantPhotoGallery({
  photos,
  venueName,
}: {
  readonly photos: ReadonlyArray<PhotoRef>;
  readonly venueName: string;
}) {
  if (photos.length === 0) {
    return (
      <div className="res-gallery-empty" aria-live="polite">
        <RestaurantPhotoFallback name={venueName} className="res-photo" />
        <p>No verified venue photos have been published for this branch yet.</p>
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
