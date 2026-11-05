/**
 * Shared contract for batched nearby dish prices ("Near me" dish cards).
 *
 * One lookup covers up to twelve dishes against a single origin: each dish
 * independently resolves its first eligible scope (10km, then 20km, then
 * 40km, then the requested city). Every other layer (Effect operation,
 * server function, card UI) builds on these shapes; the SQL projection in
 * `server/repository/sql/nearby-dish-prices.sql` is the persistence side.
 *
 * City-scope honesty rule: the places registry carries display-only
 * coordinates, never boundary polygons, and no venue-to-city membership
 * table exists. A `city` scope therefore means registry-verified
 * area-name membership (the venue's stored area exactly matches a registry
 * name of the requested city locality, preferred or alias) and is
 * classified `verified-city-membership`. `exact-city-boundary` is reserved
 * for a future boundary-polygon source and is never emitted today; the
 * approximate kinds (`approximate-city-area`, `unresolved-city`) are
 * deliberately absent so no caller can claim a city bounding that was
 * never verified.
 */

/** Eligible radii in kilometers, narrowest first. The SQL candidate pool covers the widest. */
export const NEARBY_PRICE_RADII_KM = [10, 20, 40] as const;

export type NearbyPriceRadiusKm = (typeof NEARBY_PRICE_RADII_KM)[number];

/** Sales channel for price eligibility. The lookup defaults to dine-in. */
export type NearbyPriceChannel = "dine_in" | "takeaway" | "delivery";

export type NearbyPriceScope =
  | { readonly kind: "radius"; readonly radiusKm: NearbyPriceRadiusKm }
  | {
      readonly kind: "city";
      readonly cityPlaceId: string;
      readonly cityLabel: string;
      readonly classification: "exact-city-boundary" | "verified-city-membership";
    };

export type NearbyPriceOutcome =
  | "priced"
  | "serving-without-price"
  | "no-serving"
  | "unavailable"
  | "unsupported-location";

export interface NearbyDishPrice {
  readonly dishId: string;
  readonly outcome: NearbyPriceOutcome;
  readonly scope?: NearbyPriceScope;
  readonly venueCount?: number;
  readonly pricedVenueCount?: number;
  readonly price?: {
    readonly amount: string;
    readonly currency: string;
    readonly kind: "listed";
    readonly channel: string;
    readonly taxTreatment: string;
    readonly observedAt: string;
    readonly validUntil?: string;
  };
  readonly variant?: {
    readonly itemId: string;
    readonly variantId: string;
    readonly name: string;
  };
  readonly venue?: {
    readonly venueId: string;
    readonly branchName: string;
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly range?: {
    readonly min: { readonly amount: string; readonly currency: string };
    readonly max: { readonly amount: string; readonly currency: string };
    readonly venueCount: number;
  };
  readonly reason?: string;
}

/**
 * Operation input for `lookupNearbyDishPrices`. Dish and city-place ids are
 * decimal strings (transport projection of stored bigint identities);
 * coordinates are null when the caller has no fix, which yields
 * `unsupported-location` per dish instead of a database read.
 */
export interface NearbyDishPriceLookup {
  readonly dishIds: ReadonlyArray<string>;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly channel: NearbyPriceChannel;
  readonly cityPlaceId?: string | null;
}
