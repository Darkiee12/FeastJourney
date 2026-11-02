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

/**
 * Derive the in-map panel from URL search state. Unknown or venue-less
 * views fall back to browse; validation rejects view-without-venue at the
 * route boundary, so this is a safe display default only.
 */
export function panelForRoute(search: {
  readonly venue?: string | undefined;
  readonly view: "browse" | "overview" | "menu" | "reviews";
}): RestaurantPanel {
  if (search.view === "overview" && search.venue !== undefined) return overviewPanel(search.venue);

  if (search.view === "menu" && search.venue !== undefined) return menuPanel(search.venue);

  if (search.view === "reviews" && search.venue !== undefined) return reviewsPanel(search.venue);

  return browsePanel;
}
