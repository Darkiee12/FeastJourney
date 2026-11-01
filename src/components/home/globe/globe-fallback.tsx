import { useEffect, useRef, useState } from "react";

import { FOOD_LOCATIONS, localizedDishText } from "@/components/home/globe/food-locations";
import { usePrefersReducedMotion } from "@/components/home/globe/use-prefers-reduced-motion";
import type { Locale } from "@/shared/i18n";

/** Static rotation cadence for the non-WebGL featured dish, mirroring the live globe rhythm. */
const STATIC_ROTATION_MS = 6000;

/**
 * Static planet for SSR, reduced motion, and WebGL/chunk failures.
 *
 * Four-stage reveal:
 * A. Immediate blue sphere: pure-CSS ocean gradient matching earth-texture.ts
 *    hues, exact computeGlobeLayout geometry, no fake continents.
 * B. Accurate texture: after mount, globe-static-preview.ts lazily paints the
 *    real land mask (same data as the WebGL globe) onto the canvas below.
 *    SSR/first paint keep the Stage A sphere, so there is never an empty slot.
 * C. Reveal: GlobeScene keeps this mounted over WebGL and crossfades it out
 *    ~700ms after the first frame.
 * D. Failure/reduced-motion: this is the permanent planet when WebGL or the
 *    chunk fails, or when the user prefers reduced motion (no WebGL chunk is
 *    ever downloaded on that path).
 */
export function GlobeFallback({ label, lang }: { label: string; lang?: Locale }) {
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [featured, setFeatured] = useState(0);

  useEffect(() => {
    let cancelled = false;

    import("@/components/home/globe/globe-static-preview")
      .then(({ renderStaticPreview }) => {
        const canvas = previewRef.current;

        if (!cancelled && canvas) {
          try {
            renderStaticPreview(canvas);
          } catch {
            // 2D canvas unavailable: keep the Stage A blue sphere.
          }
        }
      })
      .catch(() => {
        // Preview chunk failed to load: keep the Stage A blue sphere.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Static featured-dish rotation for WebGL-disabled devices: the same
  // curated anchors the live globe spotlights, cycling at the same reading
  // pace. Reduced motion shows the first dish only — content stays usable
  // without animation. Never navigates on its own.
  useEffect(() => {
    if (reducedMotion || FOOD_LOCATIONS.length <= 1) {
      return () => undefined;
    }

    const timer = window.setInterval(() => {
      setFeatured((current) => (current + 1) % FOOD_LOCATIONS.length);
    }, STATIC_ROTATION_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [reducedMotion]);

  const dish = FOOD_LOCATIONS[featured];

  return (
    <figure aria-label={label} className="fallback-frame absolute inset-0 m-0 overflow-hidden">
      <div aria-hidden="true" className="fallback-planet">
        <canvas ref={previewRef} width={512} height={512} className="fallback-preview" />
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent via-space-deep/40 to-space-deep/25"
      />
      {dish && lang !== undefined ? (
        <figcaption className="absolute bottom-[max(4.5rem,calc(env(safe-area-inset-bottom)+4.5rem))] left-1/2 z-[2] w-[min(19rem,78vw)] -translate-x-1/2 rounded-2xl border border-border-soft bg-white px-4 py-3 text-left text-ink shadow-[0_16px_40px_rgba(3,10,30,0.45)]">
          <p className="flex items-center gap-2 text-base leading-tight font-extrabold">
            <span aria-hidden="true" className="text-xl leading-none">
              {dish.emoji}
            </span>
            {dish.name}
          </p>
          <p className="mt-0.5 pl-8 text-sm text-muted">
            {localizedDishText(dish.country, lang)} · {localizedDishText(dish.region, lang)}
          </p>
        </figcaption>
      ) : null}
    </figure>
  );
}
