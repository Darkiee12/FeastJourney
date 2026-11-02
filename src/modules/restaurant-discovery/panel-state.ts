/**
 * Panel state for the map-first Restaurant Discovery experience.
 *
 * The map stays mounted. All venue content (overview, menu, reviews)
 * renders inside the existing mobile sheet / desktop drawer. One selected
 * venue id drives every panel; switching panels never clears it.
 */
export type RestaurantPanel =
  | { readonly kind: "browse" }
  | { readonly kind: "overview"; readonly venueId: string }
  | { readonly kind: "menu"; readonly venueId: string }
  | { readonly kind: "reviews"; readonly venueId: string };

export const browsePanel: RestaurantPanel = { kind: "browse" };

export const overviewPanel = (venueId: string): RestaurantPanel => ({
  kind: "overview",
  venueId,
});

export const menuPanel = (venueId: string): RestaurantPanel => ({
  kind: "menu",
  venueId,
});

export const reviewsPanel = (venueId: string): RestaurantPanel => ({
  kind: "reviews",
  venueId,
});

export const panelVenueId = (panel: RestaurantPanel): string | null =>
  panel.kind === "browse" ? null : panel.venueId;

export const withVenue = (panel: RestaurantPanel, venueId: string): RestaurantPanel => {
  if (panel.kind === "browse") return overviewPanel(venueId);

  return { ...panel, venueId };
};
