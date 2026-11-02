import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { DiscoveryError } from "@/modules/restaurant-discovery/components/discovery-error";
import { RestaurantSearchPage } from "@/modules/restaurant-discovery/components/restaurant-search-page";
import {
  restaurantAreasFn,
  restaurantFacetsFn,
  searchRestaurantsFn,
} from "@/modules/restaurant-discovery/restaurant.functions";
import { restaurantSearchSchema } from "@/modules/restaurant-discovery/restaurant.schema";

// Carried from the main-track worktree (dish→restaurant bridge): preserves
// the fromDish slug through restaurant search. Owner sign-off still needed.
const restaurantIndexSearchSchema = restaurantSearchSchema.and(
  z.object({ fromDish: z.string().min(1).max(120).optional() }),
);

export const Route = createFileRoute("/restaurants/")({
  validateSearch: restaurantIndexSearchSchema,
  loaderDeps: ({ search }) => restaurantSearchSchema.parse(search),
  loader: async ({ deps }) => {
    const [results, areas, cuisines] = await Promise.all([
      searchRestaurantsFn({ data: deps }),
      restaurantAreasFn(),
      restaurantFacetsFn(),
    ]);

    return { results, areas, cuisines };
  },
  pendingMs: 300,
  pendingComponent: () => (
    <div className="discovery-empty" aria-live="polite">
      Finding sourced restaurant records…
    </div>
  ),
  errorComponent: DiscoveryError,
  component: RestaurantSearchPage,
});
