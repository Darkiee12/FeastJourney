import { createFileRoute } from "@tanstack/react-router";

import { DiscoveryError } from "@/modules/restaurant-discovery/components/discovery-error";
import { RestaurantSearchPage } from "@/modules/restaurant-discovery/components/restaurant-search-page";
import {
  restaurantAreasFn,
  restaurantFacetsFn,
  searchRestaurantsFn,
} from "@/modules/restaurant-discovery/restaurant.functions";
import {
  restaurantSearchSchema,
  restaurantVenueViewSchema,
} from "@/modules/restaurant-discovery/restaurant.schema";

// Canonical venue panel state (venue/view/item) plus the carried
// dish→restaurant fromDish bridge. Panel identity rides in the URL for
// shareability and Back semantics; loaderDeps strips it so panel
// transitions never refetch the result list. Owner sign-off still needed
// for the fromDish bridge.
const restaurantIndexSearchSchema = restaurantSearchSchema.and(restaurantVenueViewSchema);

export const Route = createFileRoute("/restaurants/")({
  validateSearch: restaurantIndexSearchSchema,
  // Venue panel identity (venue/view/item) and the dish back-link ride in
  // the URL for shareability and Back semantics, but never refetch the
  // result list: parsing through the base schema strips them from deps.
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
