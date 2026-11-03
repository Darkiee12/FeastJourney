import { Data, Duration, Effect } from "effect";

import { DishService } from "@/modules/food-discovery/server/index";
import type { MenuScanDocument } from "@/modules/restaurant-discovery/menu-scan.schema";
import {
  getRestaurant,
  searchRestaurants,
  type MenuOffering,
  type RestaurantResult,
  type Venue,
} from "@/modules/restaurant-discovery/server/index";
import type { FxRates } from "@/modules/restaurant-discovery/server/operations/fx";
import {
  getMenuScan,
  type ScanPrincipal,
} from "@/modules/restaurant-discovery/server/operations/menu-scans";
import type { Actor } from "@/server/auth/actor";
import type { Database } from "@/server/database/client";
import {
  dishDetailToolSchema,
  dishSearchToolSchema,
  priceCompareToolSchema,
  researchToolSchema,
  scanMenuToolSchema,
  venueDetailToolSchema,
  venueSearchToolSchema,
  type DishDetailToolInput,
  type DishSearchToolInput,
  type PriceCompareToolInput,
  type ResearchToolInput,
  type ScanMenuToolInput,
  type VenueDetailToolInput,
  type VenueSearchToolInput,
} from "@/server/muse-copilot/copilot-schemas";
import { resolveResearchConfig } from "@/server/web-research/research-config";
import { WebResearch } from "@/server/web-research/research-service";
import { ResearchOutcome } from "@/server/web-research/research-types";
import { isAmount, isCurrency } from "@/shared/money";

/**
 * Narrow copilot adapters over existing operations only. Each tool validates
 * its arguments with Zod at this boundary, calls exactly one published
 * operation, and maps every failure to an explicit outcome — provider or
 * database failures become Unavailable, never thrown and never silent.
 * The model never executes SQL: tool choice and argument construction live
 * in copilot-service; these functions only execute pre-shaped calls.
 */

export type CopilotCatalogEnv = Database | DishService;

export type CopilotVenueEnv = Database | DishService | FxRates;

export type CopilotScanEnv = Database;

export type CopilotResearchEnv = WebResearch;

const TOOL_TIMEOUT_MS = 15000;

const withToolTimeout = <A, R>(
  effect: Effect.Effect<A, never, R>,
  operation: string,
): Effect.Effect<A | null, never, R> =>
  Effect.raceFirst(
    Effect.map(effect, (value): A | null => value),
    Effect.succeed<A | null>(null).pipe(Effect.delay(Duration.millis(TOOL_TIMEOUT_MS))),
  ).pipe(
    Effect.tap((value) =>
      value === null
        ? Effect.logWarning("Copilot tool timed out").pipe(Effect.annotateLogs({ operation }))
        : Effect.void,
    ),
  );

export interface CopilotDishHit {
  readonly id: string;
  readonly slug: string;
  readonly name: string | undefined;
}

export type DishLookup = Data.TaggedEnum<{
  DishesFound: { readonly dishes: ReadonlyArray<CopilotDishHit> };
  DishesEmpty: {};
  DishesUnavailable: { readonly reason: string };
}>;

export const DishLookup = Data.taggedEnum<DishLookup>();

export const searchDishesTool = Effect.fn("copilot.tool.searchDishes")(function* (
  input: DishSearchToolInput,
  _actor: Actor,
) {
  const parsed = dishSearchToolSchema.safeParse(input);

  if (!parsed.success) {
    yield* Effect.logWarning("Copilot dish search got invalid arguments").pipe(
      Effect.annotateLogs({ operation: "searchDishes" }),
    );

    return DishLookup.DishesEmpty();
  }

  const program: Effect.Effect<DishLookup, never, CopilotCatalogEnv> = Effect.flatMap(
    DishService,
    (service) =>
      service.searchDishes({ q: parsed.data.q, locale: "en", limit: parsed.data.limit }).pipe(
        Effect.map((output): DishLookup => {
          if (output.items.length === 0) {
            return DishLookup.DishesEmpty();
          }

          return DishLookup.DishesFound({
            dishes: output.items.map((item): CopilotDishHit => ({
              id: item.id,
              slug: item.slug,
              name: item.name,
            })),
          });
        }),
        Effect.catchTags({
          DishNotFound: () => Effect.succeed(DishLookup.DishesEmpty()),
          InvalidLocale: () => Effect.succeed(DishLookup.DishesEmpty()),
          InvalidSearchFilter: () => Effect.succeed(DishLookup.DishesEmpty()),
          PlaceNotFound: () => Effect.succeed(DishLookup.DishesEmpty()),
        }),
        Effect.catch(() =>
          Effect.succeed(
            DishLookup.DishesUnavailable({ reason: "Dish lookup is temporarily unavailable." }),
          ),
        ),
      ),
  );

  const result = yield* withToolTimeout(program, "searchDishes");

  if (result === null) {
    return DishLookup.DishesUnavailable({ reason: "Dish lookup timed out. Please retry." });
  }

  return result;
});

export interface CopilotDishDetail {
  readonly id: string;
  readonly slug: string;
  readonly name: string | undefined;
  readonly description: string | null;
  readonly regionNames: ReadonlyArray<string>;
}

export type DishDetailLookup = Data.TaggedEnum<{
  DishDetailFound: { readonly dish: CopilotDishDetail };
  DishDetailEmpty: {};
  DishDetailUnavailable: { readonly reason: string };
}>;

export const DishDetailLookup = Data.taggedEnum<DishDetailLookup>();

export const getDishTool = Effect.fn("copilot.tool.getDish")(function* (
  input: DishDetailToolInput,
  _actor: Actor,
) {
  const parsed = dishDetailToolSchema.safeParse(input);

  if (!parsed.success) {
    yield* Effect.logWarning("Copilot dish detail got invalid arguments").pipe(
      Effect.annotateLogs({ operation: "getDish" }),
    );

    return DishDetailLookup.DishDetailEmpty();
  }

  const program: Effect.Effect<DishDetailLookup, never, CopilotCatalogEnv> = Effect.flatMap(
    DishService,
    (service) =>
      service.getDish(parsed.data.id, "en").pipe(
        Effect.map((profile): DishDetailLookup =>
          DishDetailLookup.DishDetailFound({
            dish: {
              id: profile.id,
              slug: profile.slug,
              name: profile.name,
              description: profile.description,
              regionNames: profile.places
                .map((place) => place.name)
                .filter((name): name is string => name !== undefined),
            },
          }),
        ),
        Effect.catchTags({
          DishNotFound: () => Effect.succeed(DishDetailLookup.DishDetailEmpty()),
          InvalidLocale: () => Effect.succeed(DishDetailLookup.DishDetailEmpty()),
          InvalidSearchFilter: () => Effect.succeed(DishDetailLookup.DishDetailEmpty()),
          PlaceNotFound: () => Effect.succeed(DishDetailLookup.DishDetailEmpty()),
        }),
        Effect.catch(() =>
          Effect.succeed(
            DishDetailLookup.DishDetailUnavailable({
              reason: "Dish lookup is temporarily unavailable.",
            }),
          ),
        ),
      ),
  );

  const result = yield* withToolTimeout(program, "getDish");

  if (result === null) {
    return DishDetailLookup.DishDetailUnavailable({
      reason: "Dish lookup timed out. Please retry.",
    });
  }

  return result;
});

export interface CopilotVenueHit {
  readonly id: string;
  readonly name: string;
  readonly area: string;
}

const toVenueHit = (row: RestaurantResult): CopilotVenueHit => ({
  id: row.id,
  name: row.name,
  area: row.area,
});

export type VenueLookup = Data.TaggedEnum<{
  VenuesFound: { readonly venues: ReadonlyArray<CopilotVenueHit> };
  VenuesEmpty: {};
  VenuesUnavailable: { readonly reason: string };
}>;

export const VenueLookup = Data.taggedEnum<VenueLookup>();

export const searchVenuesTool = Effect.fn("copilot.tool.searchVenues")(function* (
  input: VenueSearchToolInput,
  _actor: Actor,
) {
  const parsed = venueSearchToolSchema.safeParse(input);

  if (!parsed.success) {
    yield* Effect.logWarning("Copilot venue search got invalid arguments").pipe(
      Effect.annotateLogs({ operation: "searchVenues" }),
    );

    return VenueLookup.VenuesEmpty();
  }

  const program: Effect.Effect<VenueLookup, never, CopilotVenueEnv> = searchRestaurants({
    q: parsed.data.q,
    area: parsed.data.area,
    cuisine: "",
    radius: 5000,
    channel: "dine_in",
    sort: "recommended",
    limit: parsed.data.limit,
  }).pipe(
    Effect.map((output): VenueLookup => {
      if (output.items.length === 0) {
        return VenueLookup.VenuesEmpty();
      }

      return VenueLookup.VenuesFound({ venues: output.items.map(toVenueHit) });
    }),
    Effect.catchTag("RestaurantInputError", () => Effect.succeed(VenueLookup.VenuesEmpty())),
    Effect.catch(() =>
      Effect.succeed(
        VenueLookup.VenuesUnavailable({ reason: "Restaurant lookup is temporarily unavailable." }),
      ),
    ),
  );

  const result = yield* withToolTimeout(program, "searchVenues");

  if (result === null) {
    return VenueLookup.VenuesUnavailable({ reason: "Restaurant lookup timed out. Please retry." });
  }

  return result;
});

export interface CopilotVenueDetail {
  readonly venue: Venue;
  readonly offerings: ReadonlyArray<MenuOffering>;
}

export type VenueDetailLookup = Data.TaggedEnum<{
  VenueDetailFound: { readonly detail: CopilotVenueDetail };
  VenueDetailEmpty: {};
  VenueDetailUnavailable: { readonly reason: string };
}>;

export const VenueDetailLookup = Data.taggedEnum<VenueDetailLookup>();

export const getVenueTool = Effect.fn("copilot.tool.getVenue")(function* (
  input: VenueDetailToolInput,
  _actor: Actor,
) {
  const parsed = venueDetailToolSchema.safeParse(input);

  if (!parsed.success) {
    yield* Effect.logWarning("Copilot venue detail got invalid arguments").pipe(
      Effect.annotateLogs({ operation: "getVenue" }),
    );

    return VenueDetailLookup.VenueDetailEmpty();
  }

  const program: Effect.Effect<VenueDetailLookup, never, CopilotVenueEnv> = getRestaurant(
    parsed.data.venueId,
    "dine_in",
  ).pipe(
    Effect.map((detail): VenueDetailLookup =>
      VenueDetailLookup.VenueDetailFound({
        detail: { venue: detail.venue, offerings: detail.offerings },
      }),
    ),
    Effect.catchTag("RestaurantNotFound", () =>
      Effect.succeed(VenueDetailLookup.VenueDetailEmpty()),
    ),
    Effect.catch(() =>
      Effect.succeed(
        VenueDetailLookup.VenueDetailUnavailable({
          reason: "Restaurant lookup is temporarily unavailable.",
        }),
      ),
    ),
  );

  const result = yield* withToolTimeout(program, "getVenue");

  if (result === null) {
    return VenueDetailLookup.VenueDetailUnavailable({
      reason: "Restaurant lookup timed out. Please retry.",
    });
  }

  return result;
});

export interface CopilotScanSummary {
  readonly scanId: string;
  readonly venueId: string | null;
  readonly venueName: string | null;
  readonly document: MenuScanDocument;
}

export type ScanLookup = Data.TaggedEnum<{
  ScanFound: { readonly scan: CopilotScanSummary };
  ScanEmpty: {};
  ScanDenied: { readonly reason: string };
  ScanUnavailable: { readonly reason: string };
}>;

export const ScanLookup = Data.taggedEnum<ScanLookup>();

const GUEST_SCAN_DENIED_REASON =
  "Private scans cannot be opened in the copilot without a signed-in owner. Open this scan in the menu scanner instead.";

export const getScanMenuTool = Effect.fn("copilot.tool.getScanMenu")(function* (
  input: ScanMenuToolInput,
  principal: ScanPrincipal | null,
) {
  const parsed = scanMenuToolSchema.safeParse(input);

  if (!parsed.success) {
    yield* Effect.logWarning("Copilot scan lookup got invalid arguments").pipe(
      Effect.annotateLogs({ operation: "getScanMenu" }),
    );

    return ScanLookup.ScanEmpty();
  }

  if (principal === null) {
    return ScanLookup.ScanDenied({ reason: GUEST_SCAN_DENIED_REASON });
  }

  const program: Effect.Effect<ScanLookup, never, CopilotScanEnv> = getMenuScan(
    principal,
    parsed.data.scanId,
  ).pipe(
    Effect.map((state): ScanLookup => {
      if (state.document === null) {
        return ScanLookup.ScanEmpty();
      }

      return ScanLookup.ScanFound({
        scan: {
          scanId: parsed.data.scanId,
          venueId: state.scan.venue_id,
          venueName: state.scan.venue_name,
          document: state.document,
        },
      });
    }),
    Effect.catchTag("ScanNotFound", () => Effect.succeed(ScanLookup.ScanEmpty())),
    Effect.catch(() =>
      Effect.succeed(
        ScanLookup.ScanUnavailable({ reason: "Menu scan lookup is temporarily unavailable." }),
      ),
    ),
  );

  const result = yield* withToolTimeout(program, "getScanMenu");

  if (result === null) {
    return ScanLookup.ScanUnavailable({ reason: "Menu scan lookup timed out. Please retry." });
  }

  return result;
});

export interface CopilotResearchSource {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface CopilotResearchFinding {
  readonly title: string;
  readonly summary: string;
  readonly sources: ReadonlyArray<CopilotResearchSource>;
}

export type ResearchLookup = Data.TaggedEnum<{
  ResearchFound: { readonly findings: ReadonlyArray<CopilotResearchFinding> };
  ResearchEmpty: {};
  ResearchSkipped: { readonly reason: string };
  ResearchUnavailable: { readonly reason: string };
}>;

export const ResearchLookup = Data.taggedEnum<ResearchLookup>();

export type ResearchKind = "dishes" | "restaurants";

export const researchTool = Effect.fn("copilot.tool.research")(function* (
  kind: ResearchKind,
  input: ResearchToolInput,
  firstPartyInsufficient: boolean,
) {
  const parsed = researchToolSchema.safeParse(input);

  if (!parsed.success) {
    yield* Effect.logWarning("Copilot research got invalid arguments").pipe(
      Effect.annotateLogs({ operation: "research" }),
    );

    return ResearchLookup.ResearchEmpty();
  }

  if (!firstPartyInsufficient) {
    return ResearchLookup.ResearchSkipped({
      reason: "First-party results already answer this question.",
    });
  }

  const config = resolveResearchConfig(process.env);

  if (!config.enabled) {
    yield* Effect.logInfo("Copilot research skipped").pipe(
      Effect.annotateLogs({ operation: "research", reason: "disabled" }),
    );

    return ResearchLookup.ResearchSkipped({ reason: "Web research is disabled." });
  }

  const program: Effect.Effect<ResearchLookup, never, CopilotResearchEnv> = Effect.flatMap(
    WebResearch,
    (service) => {
      const scope = {
        city: parsed.data.city,
        country: parsed.data.country,
        language: parsed.data.language,
      };

      const outcome =
        kind === "dishes"
          ? service.researchDishes(scope)
          : service.researchRestaurants({ ...scope, dish: parsed.data.dish });

      return Effect.map(outcome, (result): ResearchLookup =>
        ResearchOutcome.$match(result, {
          ResearchFound: ({ findings }) => {
            if (findings.length === 0) {
              return ResearchLookup.ResearchEmpty();
            }

            return ResearchLookup.ResearchFound({
              findings: findings.map((finding) => ({
                title: finding.title,
                summary: finding.summary,
                sources: finding.sources
                  .filter((source) => source.url.startsWith("http"))
                  .map((source) => ({
                    title: source.title,
                    url: source.url,
                    snippet: source.snippet,
                  })),
              })),
            });
          },
          ResearchEmpty: () => ResearchLookup.ResearchEmpty(),
          ResearchUnavailable: ({ reason }) => ResearchLookup.ResearchUnavailable({ reason }),
          ResearchSkipped: ({ reason }) => ResearchLookup.ResearchSkipped({ reason }),
        }),
      );
    },
  );

  const result = yield* withToolTimeout(program, "research");

  if (result === null) {
    return ResearchLookup.ResearchUnavailable({ reason: "Web research timed out. Please retry." });
  }

  return result;
});

/** Where a compared price was observed. Web evidence arrives via research, never this tool. */
export type PriceProvenance = "printed" | "reviewed" | "unknown";

export interface CopilotPriceLine {
  readonly venueId: string;
  readonly venueName: string;
  readonly area: string;
  readonly itemName: string;
  readonly variantName: string | null;
  readonly portion: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly provenance: PriceProvenance;
  readonly currentEnough: boolean;
}

export interface CopilotPriceRange {
  readonly currency: string;
  readonly minimum: string;
  readonly maximum: string;
  readonly venueCount: number;
}

export type PriceLookup = Data.TaggedEnum<{
  PricesFound: {
    readonly dishId: string;
    readonly dishSlug: string;
    readonly dishName: string | undefined;
    readonly lines: ReadonlyArray<CopilotPriceLine>;
    readonly ranges: ReadonlyArray<CopilotPriceRange>;
  };
  PricesEmpty: {};
  PricesUnavailable: { readonly reason: string };
}>;

export const PriceLookup = Data.taggedEnum<PriceLookup>();

/** A range needs a market, not an anecdote: mirrors the SQL minimum-venues gate. */
const MIN_RANGE_VENUES = 3;

const provenanceOf = (sourceCategory: string | null, priceKind: string | null): PriceProvenance => {
  if (sourceCategory === "receipt" || priceKind === "paid_unit") {
    return "reviewed";
  }

  if (sourceCategory === "official_menu" || sourceCategory === "menu_photo") {
    return "printed";
  }

  if (sourceCategory === "authorized_provider") {
    return "reviewed";
  }

  return "unknown";
};

export const comparePricesTool = Effect.fn("copilot.tool.comparePrices")(function* (
  input: PriceCompareToolInput,
  _actor: Actor,
) {
  const parsed = priceCompareToolSchema.safeParse(input);

  if (!parsed.success) {
    yield* Effect.logWarning("Copilot price comparison got invalid arguments").pipe(
      Effect.annotateLogs({ operation: "comparePrices" }),
    );

    return PriceLookup.PricesEmpty();
  }

  const program: Effect.Effect<PriceLookup, never, CopilotVenueEnv> = searchRestaurants({
    q: "",
    area: parsed.data.area,
    cuisine: "",
    radius: 5000,
    channel: parsed.data.channel,
    dish: parsed.data.dishId,
    portion: parsed.data.portion,
    sort: "recommended",
    limit: parsed.data.limit,
  }).pipe(
    Effect.map((output): PriceLookup => {
      if (output.dish === null) {
        return PriceLookup.PricesEmpty();
      }

      const lines: Array<CopilotPriceLine> = [];

      for (const row of output.dishItems) {
        if (row.amount === null || !isAmount(row.amount)) {
          continue;
        }

        if (row.currency === null || !isCurrency(row.currency)) {
          continue;
        }

        lines.push({
          venueId: row.id,
          venueName: row.name,
          area: row.area,
          itemName: row.item_name,
          variantName: row.variant_name,
          portion: row.comparison_key,
          amount: row.amount,
          currency: row.currency,
          provenance: provenanceOf(row.source_category, row.price_kind),
          currentEnough: row.current_enough ?? false,
        });
      }

      if (lines.length === 0) {
        return PriceLookup.PricesEmpty();
      }

      const ranges: Array<CopilotPriceRange> = [];

      for (const range of output.ranges) {
        if (
          range.currency === null ||
          !isCurrency(range.currency) ||
          range.minimum === null ||
          !isAmount(range.minimum) ||
          range.maximum === null ||
          !isAmount(range.maximum) ||
          range.venue_count < MIN_RANGE_VENUES
        ) {
          continue;
        }

        ranges.push({
          currency: range.currency,
          minimum: range.minimum,
          maximum: range.maximum,
          venueCount: range.venue_count,
        });
      }

      return PriceLookup.PricesFound({
        dishId: output.dish.id,
        dishSlug: output.dish.slug,
        dishName: output.dish.name,
        lines,
        ranges,
      });
    }),
    Effect.catchTags({
      DishNotFound: () => Effect.succeed(PriceLookup.PricesEmpty()),
      InvalidLocale: () => Effect.succeed(PriceLookup.PricesEmpty()),
      InvalidSearchFilter: () => Effect.succeed(PriceLookup.PricesEmpty()),
      PlaceNotFound: () => Effect.succeed(PriceLookup.PricesEmpty()),
      RestaurantInputError: () => Effect.succeed(PriceLookup.PricesEmpty()),
    }),
    Effect.catch(() =>
      Effect.succeed(
        PriceLookup.PricesUnavailable({ reason: "Price comparison is temporarily unavailable." }),
      ),
    ),
  );

  const result = yield* withToolTimeout(program, "comparePrices");

  if (result === null) {
    return PriceLookup.PricesUnavailable({ reason: "Price comparison timed out. Please retry." });
  }

  return result;
});
