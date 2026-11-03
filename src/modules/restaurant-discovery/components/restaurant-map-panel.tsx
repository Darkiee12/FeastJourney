import { ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";

const RestaurantMap = lazy(
  () => import("@/modules/restaurant-discovery/components/restaurant-map"),
);

/** Mount-once map shell: ClientOnly + Suspense load the browser map a
 *  single time. The parent keeps this panel mounted across empty /
 *  loading / error / results / detail states, so the MapLibre instance
 *  is never recreated on panel transitions — only the sheet/drawer
 *  content changes. Never add a key or conditional that remounts it. */
export function RestaurantMapPanel(props: ComponentProps<typeof RestaurantMap>) {
  const fallback = (
    <div className="discovery-map-fallback" aria-live="polite">
      Loading map. Restaurant names and addresses are available in the list.
    </div>
  );

  return (
    <ClientOnly fallback={fallback}>
      <Suspense fallback={fallback}>
        <RestaurantMap {...props} />
      </Suspense>
    </ClientOnly>
  );
}
