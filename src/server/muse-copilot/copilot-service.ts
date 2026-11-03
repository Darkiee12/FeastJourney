import { Data, Effect } from "effect";

import type { DishService } from "@/modules/food-discovery/server/index";
import type { FxRates } from "@/modules/restaurant-discovery/server/operations/fx";
import type { Actor } from "@/server/auth/actor";
import type { Database } from "@/server/database/client";
import type {
  CopilotCard,
  CopilotChatOutput,
  CopilotContext,
  CopilotDraftOrderOutput,
  CopilotTask,
} from "@/server/muse-copilot/copilot-schemas";
import {
  comparePricesTool,
  DishDetailLookup,
  DishLookup,
  getDishTool,
  getScanMenuTool,
  getVenueTool,
  PriceLookup,
  researchTool,
  ResearchLookup,
  searchDishesTool,
  searchVenuesTool,
  ScanLookup,
  VenueDetailLookup,
  VenueLookup,
  type CopilotDishDetail,
  type CopilotDishHit,
  type CopilotPriceLine,
  type CopilotPriceRange,
  type PriceProvenance,
  type CopilotResearchFinding,
  type CopilotVenueHit,
  type ResearchKind,
} from "@/server/muse-copilot/copilot-tools";
import type { WebResearch } from "@/server/web-research/research-service";
import { currencyDigits, formatMoney, isAmount, isCurrency } from "@/shared/money";

/**
 * Copilot orchestration over the narrow tool adapters. The plan is
 * deterministic code, never model output: the task hint plus the request
 * context select a bounded stage list, evidence composes the reply, and
 * budgets cap every run. Structured logs carry counts and dispositions
 * only — never messages, prompts, keys, images, or PII.
 */

export const COPILOT_MAX_TOOL_ROUNDS = 6;

export const COPILOT_MAX_TOOL_CALLS = 12;

export const COPILOT_MAX_RESEARCH_CALLS = 2;

export const COPILOT_OVERALL_DEADLINE_MS = 90000;

export type CopilotChatEnv = Database | DishService | FxRates | WebResearch;

export type CopilotDraftEnv = Database | DishService | FxRates;

export interface CopilotChatRequest {
  readonly message: string;
  readonly task: CopilotTask;
  readonly context: CopilotContext;
  readonly actor: Actor;
}

interface PriceEvidence {
  readonly dishName: string;
  readonly area: string;
  readonly lines: ReadonlyArray<CopilotPriceLine>;
  readonly ranges: ReadonlyArray<CopilotPriceRange>;
  readonly stale: boolean;
}

interface ChatEvidence {
  readonly dishes: ReadonlyArray<CopilotDishHit>;
  readonly dishDetail: CopilotDishDetail | null;
  readonly venues: ReadonlyArray<CopilotVenueHit>;
  readonly venueName: string | null;
  readonly scanItemCount: number | null;
  readonly prices: PriceEvidence | null;
  readonly research: ReadonlyArray<CopilotResearchFinding>;
  readonly researchSkipped: boolean;
  readonly unavailableCount: number;
  readonly denied: boolean;
  readonly language: string;
}

const collapseQuery = (message: string): string =>
  message.replace(/\s+/g, " ").trim().slice(0, 200);

const dishTitle = (dish: CopilotDishHit): string => dish.name ?? dish.slug;

const provenanceLabel = (provenance: PriceProvenance): string => {
  if (provenance === "reviewed") {
    return "Reviewed";
  }

  if (provenance === "printed") {
    return "Printed";
  }

  return "Listed";
};

const composeChatReply = (task: CopilotTask, evidence: ChatEvidence): CopilotChatOutput => {
  const cards: Array<CopilotCard> = [];
  const followUps: Array<string> = [];
  const parts: Array<string> = [];

  if (evidence.dishDetail !== null) {
    const detail = evidence.dishDetail;

    cards.push({
      kind: "dish",
      refId: detail.id,
      title: detail.name ?? detail.slug,
      summary: detail.description ?? undefined,
    });

    if (detail.description !== null) {
      parts.push(detail.description);
    } else {
      parts.push(`I found ${detail.name ?? detail.slug} in the catalog.`);
    }

    if (detail.regionNames.length > 0) {
      parts.push(`Associated regions: ${detail.regionNames.slice(0, 5).join(", ")}.`);
    }

    followUps.push("Where can I eat this dish?", "Suggest similar dishes");
  }

  if (evidence.dishes.length > 0) {
    for (const dish of evidence.dishes.slice(0, 4)) {
      cards.push({ kind: "dish", refId: dish.id, title: dishTitle(dish) });
    }

    if (evidence.dishDetail === null) {
      parts.push(
        `I found these dishes in the catalog: ${evidence.dishes
          .slice(0, 4)
          .map(dishTitle)
          .join(", ")}.`,
      );
    }

    const first = evidence.dishes[0];

    if (first !== undefined && !followUps.includes("Where can I eat this dish?")) {
      followUps.push(`Tell me more about ${dishTitle(first)}`, "Where can I eat one of these?");
    }
  }

  if (evidence.venues.length > 0) {
    for (const venue of evidence.venues.slice(0, 3)) {
      cards.push({
        kind: "restaurant",
        refId: venue.id,
        title: venue.name,
        summary: venue.area,
      });
    }

    parts.push(
      `I found these places: ${evidence.venues
        .slice(0, 3)
        .map((venue) => `${venue.name} (${venue.area})`)
        .join(", ")}.`,
    );

    followUps.push("Show me the menu for one of these");
  } else if (evidence.venueName !== null) {
    parts.push(`The menu I found covers ${evidence.venueName}.`);
    followUps.push("Help me build an order from this menu");
  }

  if (evidence.scanItemCount !== null) {
    parts.push(
      `The scanned menu lists ${evidence.scanItemCount.toString()} readable items with their printed prices.`,
    );
    followUps.push("Help me build an order from this menu");
  }

  if (evidence.prices !== null) {
    const priced = evidence.prices;

    for (const line of priced.lines.slice(0, 3)) {
      const portionSuffix = line.portion === null ? "" : ` · portion ${line.portion}`;

      cards.push({
        kind: "price",
        refId: line.venueId,
        title: `${formatMoney(line.amount, line.currency, evidence.language)} · ${line.venueName}`,
        summary: `${provenanceLabel(line.provenance)} menu price · ${line.area}${portionSuffix}`,
      });
    }

    const range = priced.ranges[0];

    if (range !== undefined) {
      parts.push(
        `Across ${range.venueCount.toString()} venues in ${priced.area}, listed ${priced.dishName} prices run ${formatMoney(range.minimum, range.currency, evidence.language)} to ${formatMoney(range.maximum, range.currency, evidence.language)}. Portions may differ; check the venue menu for exact variants.`,
      );
    } else {
      parts.push(
        `I found these listed prices for ${priced.dishName}: ${priced.lines
          .slice(0, 3)
          .map(
            (line) =>
              `${formatMoney(line.amount, line.currency, evidence.language)} at ${line.venueName}`,
          )
          .join(", ")}. Portions may differ.`,
      );
    }

    if (priced.stale) {
      parts.push("Some listed prices may be stale; confirm with the venue before ordering.");
    }
  }

  if (evidence.research.length > 0) {
    for (const finding of evidence.research.slice(0, 2)) {
      const firstSource = finding.sources[0];

      cards.push({
        kind: "source",
        title: finding.title,
        summary: finding.summary,
        url: firstSource?.url,
      });
    }

    const top = evidence.research[0];

    if (top !== undefined) {
      parts.push(`Web sources suggest: ${top.title} — ${top.summary}`);
      parts.push("Treat this as unverified web evidence, not a catalog fact.");
    }
  }

  if (parts.length === 0) {
    if (evidence.denied) {
      parts.push(
        "This private scan cannot be opened in the copilot without its signed-in owner. Open it in the menu scanner instead.",
      );
    } else if (evidence.unavailableCount > 0) {
      parts.push("Some lookups were temporarily unavailable. Please try again in a moment.");
    } else if (task === "order") {
      parts.push("Share a menu scan or choose a restaurant so I can help build your order.");
    } else if (task === "scan") {
      parts.push(
        "I could not read a menu from this request. Attach menu photos in the scanner first.",
      );
    } else {
      parts.push(
        "I could not find anything for that in the catalog. Try a different dish, city, or wording.",
      );
    }

    followUps.push("Browse popular dishes", "Find restaurants by city");
  }

  if (evidence.unavailableCount > 0 && parts.length > 0 && !evidence.denied) {
    parts.push("Some sources were temporarily unavailable, so this answer may be incomplete.");
  }

  return {
    reply: parts.join(" ").slice(0, 4000),
    cards: cards.slice(0, 6),
    followUps: followUps.slice(0, 3),
  };
};

export const copilotChat = Effect.fn("copilot.chat")(function* (request: CopilotChatRequest) {
  const startedAt = Date.now();
  const query = collapseQuery(request.message);
  const context = request.context;
  let toolCalls = 0;
  let rounds = 0;
  let researchCalls = 0;

  let dishes: ReadonlyArray<CopilotDishHit> = [];
  let dishDetail: CopilotDishDetail | null = null;
  let venues: ReadonlyArray<CopilotVenueHit> = [];
  let venueName: string | null = null;
  let scanItemCount: number | null = null;
  let priceEvidence: PriceEvidence | null = null;
  let research: ReadonlyArray<CopilotResearchFinding> = [];
  let researchSkipped = false;
  let unavailableCount = 0;
  let denied = false;

  const note = (lookup: { readonly _tag: string }): void => {
    if (lookup._tag.endsWith("Unavailable")) {
      unavailableCount += 1;
    }
  };

  // Round 1: direct lookups from explicit context references.
  rounds += 1;

  if (context.dishId !== undefined && toolCalls < COPILOT_MAX_TOOL_CALLS) {
    toolCalls += 1;

    const detail = yield* getDishTool({ id: context.dishId }, request.actor);
    note(detail);

    dishDetail = DishDetailLookup.$match(detail, {
      DishDetailFound: ({ dish }) => dish,
      DishDetailEmpty: () => null,
      DishDetailUnavailable: () => null,
    });
  }

  if (
    (request.task === "scan" || request.task === "order") &&
    context.scanId !== undefined &&
    toolCalls < COPILOT_MAX_TOOL_CALLS
  ) {
    toolCalls += 1;

    const scan = yield* getScanMenuTool({ scanId: context.scanId }, request.actor);
    note(scan);

    const scanEvidence = ScanLookup.$match(scan, {
      ScanFound: ({ scan: found }) => ({
        itemCount: found.document.items.length,
        venue: found.venueName,
        denied: false,
      }),
      ScanEmpty: () => ({ itemCount: null, venue: null, denied: false }),
      ScanDenied: () => ({ itemCount: null, venue: null, denied: true }),
      ScanUnavailable: () => ({ itemCount: null, venue: null, denied: false }),
    });

    scanItemCount = scanEvidence.itemCount;
    venueName = scanEvidence.venue;
    denied = scanEvidence.denied;
  }

  if (
    request.task === "order" &&
    context.scanId === undefined &&
    context.venueId !== undefined &&
    toolCalls < COPILOT_MAX_TOOL_CALLS
  ) {
    toolCalls += 1;

    const venue = yield* getVenueTool({ venueId: context.venueId }, request.actor);
    note(venue);

    venueName = VenueDetailLookup.$match(venue, {
      VenueDetailFound: ({ detail }) => detail.venue.name,
      VenueDetailEmpty: () => null,
      VenueDetailUnavailable: () => null,
    });
  }

  // Round 2: catalog search from the message text.
  if (
    (request.task === "find" || request.task === "ask" || request.task === "plate") &&
    dishDetail === null &&
    toolCalls < COPILOT_MAX_TOOL_CALLS
  ) {
    rounds += 1;
    toolCalls += 1;

    const found = yield* searchDishesTool({ q: query, limit: 5 }, request.actor);
    note(found);

    dishes = DishLookup.$match(found, {
      DishesFound: ({ dishes: hits }) => hits,
      DishesEmpty: () => [],
      DishesUnavailable: () => [],
    });
  }

  if (
    request.task === "find" &&
    dishes.length === 0 &&
    (context.city !== undefined || context.country !== undefined) &&
    toolCalls < COPILOT_MAX_TOOL_CALLS
  ) {
    rounds += 1;
    toolCalls += 1;

    const nearby = yield* searchVenuesTool(
      { q: query.slice(0, 100), area: context.city ?? "", limit: 5 },
      request.actor,
    );

    note(nearby);

    venues = VenueLookup.$match(nearby, {
      VenuesFound: ({ venues: hits }) => hits,
      VenuesEmpty: () => [],
      VenuesUnavailable: () => [],
    });
  }

  // Round 3: deterministic price comparison over reviewed menus once the
  // canonical dish and a city scope are known. Runs before any web research
  // so first-party prices answer budget questions without leaving the catalog.
  if (
    dishDetail !== null &&
    context.city !== undefined &&
    (request.task === "find" || request.task === "ask") &&
    toolCalls < COPILOT_MAX_TOOL_CALLS
  ) {
    rounds += 1;
    toolCalls += 1;

    const pricedDish = dishDetail;
    const priceArea = context.city;

    const compared = yield* comparePricesTool(
      { dishId: pricedDish.id, area: priceArea, channel: "dine_in", limit: 5 },
      request.actor,
    );

    note(compared);

    priceEvidence = PriceLookup.$match(compared, {
      PricesFound: ({ lines, ranges }) =>
        lines.length === 0
          ? null
          : {
              dishName: pricedDish.name ?? pricedDish.slug,
              area: priceArea,
              lines,
              ranges,
              stale: lines.some((line) => !line.currentEnough),
            },
      PricesEmpty: () => null,
      PricesUnavailable: () => null,
    });
  }

  // Round 4: user-triggered research only when first-party results are empty,
  // a geographic scope exists, and the research gate is open.
  const firstPartyInsufficient =
    dishDetail === null &&
    dishes.length === 0 &&
    venues.length === 0 &&
    venueName === null &&
    scanItemCount === null &&
    !denied;

  if (
    firstPartyInsufficient &&
    (request.task === "find" || request.task === "ask") &&
    context.city !== undefined &&
    context.country !== undefined &&
    researchCalls < COPILOT_MAX_RESEARCH_CALLS &&
    toolCalls < COPILOT_MAX_TOOL_CALLS
  ) {
    rounds += 1;
    researchCalls += 1;
    toolCalls += 1;
    const kind: ResearchKind = request.task === "find" ? "restaurants" : "dishes";

    const result = yield* researchTool(
      kind,
      { city: context.city, country: context.country, language: context.language },
      true,
    );

    ResearchLookup.$match(result, {
      ResearchFound: ({ findings }) => {
        research = findings;
      },
      ResearchEmpty: () => {},
      ResearchSkipped: () => {
        researchSkipped = true;
      },
      ResearchUnavailable: () => {
        unavailableCount += 1;
      },
    });
  }

  const output = composeChatReply(request.task, {
    dishes,
    dishDetail,
    venues,
    venueName,
    scanItemCount,
    prices: priceEvidence,
    research,
    researchSkipped,
    unavailableCount,
    denied,
    language: request.context.language ?? "en",
  });

  yield* Effect.logInfo("Copilot chat completed").pipe(
    Effect.annotateLogs({
      task: request.task,
      rounds,
      toolCalls,
      researchCalls,
      cardCount: output.cards.length,
      dishCount: dishes.length,
      venueCount: venues.length,
      priceLineCount: priceEvidence?.lines.length ?? 0,
      priceRangeCount: priceEvidence?.ranges.length ?? 0,
      researchFindingCount: research.length,
      unavailableCount,
      durationMs: Date.now() - startedAt,
    }),
  );

  return output;
});

/** Exact decimal shift to minor units; sub-minor precision stays unknown, never rounded. */
const decimalToMinor = (amount: string, digits: number): string | null => {
  if (!isAmount(amount)) {
    return null;
  }

  const [integer = "0", fraction = ""] = amount.split(".");

  if (fraction.length > digits) {
    return null;
  }

  const minor = `${integer.replace(/^0+/, "")}${fraction.padEnd(digits, "0")}`;
  const normalized = minor.replace(/^0+/, "");

  return normalized === "" ? "0" : normalized;
};

interface PricedChoice {
  readonly itemKey: string;
  readonly variantKey: string | undefined;
  readonly name: string;
  readonly amount: string | null;
  readonly currency: string | null;
}

export interface CopilotDraftOrderItem {
  readonly itemKey: string;
  readonly variantKey?: string | undefined;
  readonly qty: number;
}

export interface CopilotDraftOrderRequest {
  readonly venueId?: string | undefined;
  readonly scanId?: string | undefined;
  readonly items: ReadonlyArray<CopilotDraftOrderItem>;
  readonly instructions?: string | undefined;
  readonly actor: Actor;
}

type DraftSource = Data.TaggedEnum<{
  ScanChoices: { readonly choices: ReadonlyArray<PricedChoice> };
  VenueChoices: { readonly choices: ReadonlyArray<PricedChoice> };
  DraftBlocked: { readonly reason: string };
}>;

const DraftSource = Data.taggedEnum<DraftSource>();

const venueOfferingsToChoices = (
  offerings: ReadonlyArray<{
    readonly item_id: string;
    readonly variant_id: string;
    readonly item_name: string;
    readonly translated_name: string | null;
    readonly amount: string | null;
    readonly currency: string | null;
  }>,
): ReadonlyArray<PricedChoice> =>
  offerings.map((offering): PricedChoice => ({
    itemKey: offering.item_id,
    variantKey: offering.variant_id,
    name:
      offering.translated_name !== null && offering.translated_name !== ""
        ? offering.translated_name
        : offering.item_name,
    amount: offering.amount !== null && isAmount(offering.amount) ? offering.amount : null,
    currency:
      offering.currency !== null && isCurrency(offering.currency) ? offering.currency : null,
  }));

const loadDraftSource = (
  request: CopilotDraftOrderRequest,
): Effect.Effect<DraftSource, never, CopilotDraftEnv> =>
  Effect.gen(function* () {
    if (request.scanId !== undefined) {
      const scan = yield* getScanMenuTool({ scanId: request.scanId }, request.actor);

      return ScanLookup.$match(scan, {
        ScanFound: ({ scan: found }) =>
          DraftSource.ScanChoices({
            choices: found.document.items.flatMap((item) =>
              item.variants.map((variant): PricedChoice => ({
                itemKey: item.id,
                variantKey: variant.id,
                name: item.translatedName ?? item.originalName,
                amount:
                  variant.price !== null &&
                  variant.price.amount !== null &&
                  isAmount(variant.price.amount)
                    ? variant.price.amount
                    : null,
                currency:
                  variant.price !== null &&
                  variant.price.currency !== null &&
                  isCurrency(variant.price.currency)
                    ? variant.price.currency
                    : null,
              })),
            ),
          }),
        ScanEmpty: () =>
          request.venueId === undefined
            ? DraftSource.DraftBlocked({ reason: "This scan has no readable menu to order from." })
            : DraftSource.DraftBlocked({ reason: "scan-empty" }),
        ScanDenied: ({ reason }) => DraftSource.DraftBlocked({ reason }),
        ScanUnavailable: ({ reason }) =>
          request.venueId === undefined
            ? DraftSource.DraftBlocked({ reason })
            : DraftSource.DraftBlocked({ reason: "scan-empty" }),
      });
    }

    if (request.venueId === undefined) {
      return DraftSource.DraftBlocked({ reason: "A venue or a private scan is required." });
    }

    const venue = yield* getVenueTool({ venueId: request.venueId }, request.actor);

    return VenueDetailLookup.$match(venue, {
      VenueDetailFound: ({ detail }) =>
        DraftSource.VenueChoices({ choices: venueOfferingsToChoices(detail.offerings) }),
      VenueDetailEmpty: () =>
        DraftSource.DraftBlocked({
          reason: "This restaurant has no published menu to order from.",
        }),
      VenueDetailUnavailable: ({ reason }) => DraftSource.DraftBlocked({ reason }),
    });
  });

export const draftOrder = Effect.fn("copilot.draftOrder")(function* (
  request: CopilotDraftOrderRequest,
) {
  const startedAt = Date.now();
  const warnings: Array<string> = [];

  const source = yield* loadDraftSource(request);

  const blockedReason = DraftSource.$match(source, {
    ScanChoices: () => null,
    VenueChoices: () => null,
    DraftBlocked: ({ reason }) => reason,
  });

  if (blockedReason !== null) {
    // A scan miss falls back to the public venue menu when one was given;
    // a denial or a venue miss stays terminal and honest.
    if (blockedReason !== "scan-empty" || request.venueId === undefined) {
      yield* Effect.logInfo("Copilot draft order blocked").pipe(
        Effect.annotateLogs({ source: "scan", itemCount: request.items.length }),
      );

      return {
        lines: [],
        subtotalMinor: null,
        currency: "",
        incomplete: true,
        warnings: [blockedReason],
      };
    }

    warnings.push("The scan has no readable menu, so this draft uses the published venue menu.");

    const venue = yield* getVenueTool({ venueId: request.venueId }, request.actor);

    const fallback = VenueDetailLookup.$match(venue, {
      VenueDetailFound: ({ detail }) =>
        DraftSource.VenueChoices({ choices: venueOfferingsToChoices(detail.offerings) }),
      VenueDetailEmpty: () =>
        DraftSource.DraftBlocked({
          reason: "This restaurant has no published menu to order from.",
        }),
      VenueDetailUnavailable: ({ reason }) => DraftSource.DraftBlocked({ reason }),
    });

    const fallbackReason = DraftSource.$match(fallback, {
      ScanChoices: () => null,
      VenueChoices: () => null,
      DraftBlocked: ({ reason }) => reason,
    });

    if (fallbackReason !== null) {
      return {
        lines: [],
        subtotalMinor: null,
        currency: "",
        incomplete: true,
        warnings: [...warnings, fallbackReason].slice(0, 20),
      };
    }

    return yield* buildDraft(request, fallback, warnings, startedAt);
  }

  return yield* buildDraft(request, source, warnings, startedAt);
});

const buildDraft = (
  request: CopilotDraftOrderRequest,
  source: DraftSource,
  warnings: Array<string>,
  startedAt: number,
): Effect.Effect<CopilotDraftOrderOutput, never, CopilotDraftEnv> =>
  Effect.gen(function* () {
    const choices = DraftSource.$match(source, {
      ScanChoices: ({ choices: found }) => found,
      VenueChoices: ({ choices: found }) => found,
      DraftBlocked: (): ReadonlyArray<PricedChoice> => [],
    });

    const byItem = new Map<string, Array<PricedChoice>>();

    for (const choice of choices) {
      const existing = byItem.get(choice.itemKey);

      if (existing === undefined) {
        byItem.set(choice.itemKey, [choice]);
      } else {
        existing.push(choice);
      }
    }

    const lines: Array<{
      readonly itemKey: string;
      readonly variantKey: string | undefined;
      readonly name: string;
      readonly qty: number;
      readonly unitMinor: string | null;
      readonly lineMinor: string | null;
      readonly currency: string | null;
    }> = [];

    const seen = new Set<string>();
    let incomplete = false;

    for (const item of request.items) {
      const candidates = byItem.get(item.itemKey);

      if (candidates === undefined || candidates.length === 0) {
        warnings.push("One requested item is not on this menu, so it was left out.");
        incomplete = true;
        continue;
      }

      let selected: PricedChoice | undefined;

      if (item.variantKey !== undefined) {
        selected = candidates.find((candidate) => candidate.variantKey === item.variantKey);

        if (selected === undefined) {
          warnings.push("One requested variant is not on this menu, so it was left out.");
          incomplete = true;
          continue;
        }
      } else if (candidates.length === 1) {
        const only = candidates[0];

        if (only === undefined) {
          warnings.push("One requested item is not on this menu, so it was left out.");
          incomplete = true;
          continue;
        }

        selected = only;
      } else {
        warnings.push("One item needs an explicit variant before it can be ordered.");
        incomplete = true;
        continue;
      }

      const dedupeKey = `${selected.itemKey}/${selected.variantKey ?? ""}`;

      if (seen.has(dedupeKey)) {
        warnings.push("A duplicate selection was counted once; adjust quantities explicitly.");
        incomplete = true;
        continue;
      }

      seen.add(dedupeKey);

      const digits =
        selected.currency !== null && isCurrency(selected.currency)
          ? currencyDigits(selected.currency)
          : null;

      const unitMinor =
        selected.amount !== null && digits !== null
          ? decimalToMinor(selected.amount, digits)
          : null;

      const lineMinor =
        unitMinor !== null ? (BigInt(unitMinor) * BigInt(item.qty)).toString() : null;

      if (lineMinor === null) {
        warnings.push(`The price for ${selected.name} is unknown; confirm it with the waiter.`);
        incomplete = true;
      }

      lines.push({
        itemKey: selected.itemKey,
        variantKey: selected.variantKey,
        name: selected.name,
        qty: item.qty,
        unitMinor,
        lineMinor,
        currency: selected.currency,
      });
    }

    const known = lines.filter(
      (line): line is typeof line & { readonly lineMinor: string; readonly currency: string } =>
        line.lineMinor !== null && line.currency !== null,
    );

    const currencies = new Set(known.map((line) => line.currency));

    let subtotalMinor: string | null = null;
    let currency = "";

    if (known.length === lines.length && lines.length > 0 && currencies.size === 1) {
      const only = [...currencies][0];

      if (only !== undefined) {
        currency = only;
        subtotalMinor = known
          .reduce((total, line) => total + BigInt(line.lineMinor), 0n)
          .toString();
      }
    } else if (lines.length > 0) {
      incomplete = true;

      if (currencies.size > 1) {
        warnings.push("Prices use different currencies; no single subtotal is available.");
      }
    }

    if (lines.length === 0) {
      incomplete = true;
      warnings.push("Nothing on this draft matched the menu. Check the item names and retry.");
    }

    yield* Effect.logInfo("Copilot draft order completed").pipe(
      Effect.annotateLogs({
        lineCount: lines.length,
        knownPriceCount: known.length,
        incomplete,
        warningCount: warnings.length,
        durationMs: Date.now() - startedAt,
      }),
    );

    return {
      lines: lines.map((line) => ({
        itemKey: line.itemKey,
        variantKey: line.variantKey,
        name: line.name,
        qty: line.qty,
        unitMinor: line.unitMinor,
        lineMinor: line.lineMinor,
      })),
      subtotalMinor,
      currency,
      incomplete,
      warnings: warnings.slice(0, 20),
    };
  });
