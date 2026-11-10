import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, StoreIcon } from "lucide-react";

import { SaveDishButton, type SaveButtonStatus } from "@/modules/user/components/save-dish-button";
import type { SessionState } from "@/modules/user/session.functions";
import type { Locale, Messages } from "@/shared/i18n";

/**
 * Fixed action identity shared by every dish card layout. Order, icons,
 * and targets never diverge between compact/mobile and full/desktop:
 * Explore (canonical dish details), Save (existing favorite flow), then
 * Find restaurants (restaurant search by canonical dish identity).
 */
export const DISH_ACTION_ORDER = ["explore", "save", "restaurants"] as const;

export type DishActionKind = (typeof DISH_ACTION_ORDER)[number];

/**
 * Restaurant search carrying the canonical dish identity: the numeric
 * `dish` filter id plus the `fromDish` slug back-link, matching the
 * `/restaurants` route schema and the quiz→restaurants bridge. Never a
 * name text-match: serving evidence is decided server-side from
 * `restaurant_eligible_evidence`, so the client asserts no availability.
 */
/** Canonical dish identity for restaurant search (id + slug back-link). */
export interface DishRestaurantsSearch {
  readonly lang: Locale;
  readonly dish: string;
  readonly fromDish: string;
  /** Sales channel the handoff price was computed for. Absent on the
   *  legacy helper, which predates scoped handoffs. */
  readonly channel?: DishSearchChannel | undefined;
  /** Map-handoff scope kind. Absent on the legacy helper. */
  readonly scope?: DishSearchScopeKind | undefined;
  /** Radius in km for `radius` scope. Contract values: 10, 20, 40. */
  readonly radiusKm?: DishRadiusKm | undefined;
  /** City preset id for `city` scope (see restaurant-discovery
   *  `CITY_PRESETS`). Never exact coordinates (privacy). */
  readonly cityPlaceId?: string | undefined;
}

export type DishSearchScopeKind = "radius" | "city";

export type DishRadiusKm = 10 | 20 | 40;

export type DishSearchChannel = "dine_in" | "takeaway" | "delivery";

/**
 * Map-handoff scope for a priced Food Journey recommendation: the rail
 * links "Find on map" with dish identity plus the scope the price was
 * computed for — a radius around the user or a city. Exact coordinates
 * never travel in the URL; the restaurant map resolves the scope to a
 * geographic query on mount.
 */
export type DishSearchScope =
  | { readonly kind: "radius"; readonly radiusKm: DishRadiusKm }
  | { readonly kind: "city"; readonly cityPlaceId: string };

export const dishRestaurantsSearch = (
  dishId: string,
  dishSlug: string,
  lang: Locale,
): DishRestaurantsSearch => ({
  dish: dishId,
  fromDish: dishSlug,
  lang,
});

/**
 * Scoped restaurant search for a priced recommendation handoff: dish
 * identity plus the price scope and channel, matching the `/restaurants`
 * `dish`/`fromDish`/`scope`/`radiusKm`/`cityPlaceId`/`channel` URL
 * contract. The legacy helper stays byte-identical for existing callers.
 */
export const dishRestaurantsSearchWithScope = (
  dishId: string,
  dishSlug: string,
  lang: Locale,
  scope: DishSearchScope,
  channel: DishSearchChannel = "dine_in",
): DishRestaurantsSearch => {
  if (scope.kind === "radius") {
    return {
      dish: dishId,
      fromDish: dishSlug,
      lang,
      channel,
      scope: scope.kind,
      radiusKm: scope.radiusKm,
    };
  }

  return {
    dish: dishId,
    fromDish: dishSlug,
    lang,
    channel,
    scope: scope.kind,
    cityPlaceId: scope.cityPlaceId,
  };
};

export interface DishActionsProps {
  /** Decimal dish id string; passed through as the `dish` search filter. */
  readonly dishId: string;
  /** Canonical dish slug for details links and the `fromDish` back-link. */
  readonly dishSlug: string;
  readonly lang: Locale;
  readonly copy: Messages;
  readonly session: SessionState;
  /** Per-dish status projected from the list-level favorite query. */
  readonly status: SaveButtonStatus;
  readonly returnTo?: string | undefined;
  readonly onSaveSheetOpenChange?: ((open: boolean) => void) | undefined;
  /** Hides the links from tab order on inert (off-screen) slides. */
  readonly tabIndex?: number | undefined;
}

/**
 * One shared dish action row: Explore, Save, Find restaurants. Rendered
 * identically in compact and full carousel layouts — same order, icons,
 * targets, and accessible names. Every button is a 44px circle with a
 * 6px gap, so the row never grows or wraps between layouts. Icon-only
 * buttons carry accessible names and tooltips; the existing favorite
 * flow (guest sheet, idempotent save/unsave) is reused unchanged.
 */
export function DishActions({
  copy,
  dishId,
  dishSlug,
  lang,
  onSaveSheetOpenChange,
  returnTo = "/",
  session,
  status,
  tabIndex,
}: DishActionsProps) {
  return (
    <div className="flex flex-none flex-nowrap items-center gap-1.5">
      <Link
        to="/dishes/$dishId"
        params={{ dishId: dishSlug }}
        search={{ lang }}
        tabIndex={tabIndex}
        aria-label={copy.recExploreShort}
        title={copy.recExploreShort}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-food-orange-strong text-white transition hover:bg-food-orange-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <ArrowUpRightIcon aria-hidden="true" className="size-4 flex-none" />
      </Link>
      <SaveDishButton
        compact
        dishId={dishId}
        onSaveSheetOpenChange={onSaveSheetOpenChange}
        lang={lang}
        returnTo={returnTo}
        session={session}
        status={status}
      />
      <Link
        to="/restaurants"
        search={dishRestaurantsSearch(dishId, dishSlug, lang)}
        tabIndex={tabIndex}
        aria-label={copy.recFindRestaurants}
        title={copy.recFindRestaurants}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border-2 border-ink bg-white text-ink transition hover:bg-ink hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <StoreIcon aria-hidden="true" className="size-4 flex-none" />
      </Link>
    </div>
  );
}
