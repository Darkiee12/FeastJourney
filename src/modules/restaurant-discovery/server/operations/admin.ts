import { Config, Effect } from "effect";
import * as BigDecimal from "effect/BigDecimal";
import { type z } from "zod";

import { getPublishedDishIdentities } from "@/modules/food-discovery/server/index";
import {
  menuImportSchema,
  type venueWriteSchema,
  type MenuImport,
  type reviewSchema,
  type menuStatusSchema,
  type offeringStatusSchema,
} from "@/modules/restaurant-discovery/restaurant.schema";
import {
  RestaurantInputError,
  RestaurantNotFound,
} from "@/modules/restaurant-discovery/server/operations/discovery";
import renameBusiness from "@/modules/restaurant-discovery/server/repository/sql/admin-business-rename.sql";
import businessQuery from "@/modules/restaurant-discovery/server/repository/sql/admin-business.sql";
import businessesQuery from "@/modules/restaurant-discovery/server/repository/sql/admin-businesses.sql";
import clearCuisines from "@/modules/restaurant-discovery/server/repository/sql/admin-cuisines-clear.sql";
import insertCuisines from "@/modules/restaurant-discovery/server/repository/sql/admin-cuisines.sql";
import evidenceQuery from "@/modules/restaurant-discovery/server/repository/sql/admin-evidence.sql";
import invalidateMoved from "@/modules/restaurant-discovery/server/repository/sql/admin-invalidate-moved-venue.sql";
import itemStatus from "@/modules/restaurant-discovery/server/repository/sql/admin-item-status.sql";
import itemQuery from "@/modules/restaurant-discovery/server/repository/sql/admin-item.sql";
import menuStatusQuery from "@/modules/restaurant-discovery/server/repository/sql/admin-menu-status.sql";
import menuQuery from "@/modules/restaurant-discovery/server/repository/sql/admin-menu.sql";
import priceQuery from "@/modules/restaurant-discovery/server/repository/sql/admin-price.sql";
import publishReviewedItem from "@/modules/restaurant-discovery/server/repository/sql/admin-publish-reviewed-item.sql";
import publishReviewedVariant from "@/modules/restaurant-discovery/server/repository/sql/admin-publish-reviewed-variant.sql";
import receiptQuery from "@/modules/restaurant-discovery/server/repository/sql/admin-receipt.sql";
import reviewEvidence from "@/modules/restaurant-discovery/server/repository/sql/admin-review-evidence.sql";
import reviewPrice from "@/modules/restaurant-discovery/server/repository/sql/admin-review-price.sql";
import queueQuery from "@/modules/restaurant-discovery/server/repository/sql/admin-review-queue.sql";
import sourceQuery from "@/modules/restaurant-discovery/server/repository/sql/admin-source.sql";
import variantStatus from "@/modules/restaurant-discovery/server/repository/sql/admin-variant-status.sql";
import variantQuery from "@/modules/restaurant-discovery/server/repository/sql/admin-variant.sql";
import findVenue from "@/modules/restaurant-discovery/server/repository/sql/admin-venue-find.sql";
import nameQuery from "@/modules/restaurant-discovery/server/repository/sql/admin-venue-name.sql";
import venueSources from "@/modules/restaurant-discovery/server/repository/sql/admin-venue-sources.sql";
import venueQuery from "@/modules/restaurant-discovery/server/repository/sql/admin-venue.sql";
import venuesPage from "@/modules/restaurant-discovery/server/repository/sql/admin-venues-page.sql";
import venuesStatus from "@/modules/restaurant-discovery/server/repository/sql/admin-venues-status.sql";
import venuesQuery from "@/modules/restaurant-discovery/server/repository/sql/admin-venues.sql";
import { Authorization, recordAuditEvent } from "@/modules/user/server/index";
import { Actor } from "@/server/auth/actor";
import { CurrentActor } from "@/server/auth/current-actor";
import { withTransaction } from "@/server/database/client";
import { PersistenceConflict } from "@/server/database/errors";
import { runQuery } from "@/server/database/query";

const authorize = (action: "manage" | "review") =>
  Effect.gen(function* () {
    const actor = yield* CurrentActor;
    const authorization = yield* Authorization;
    yield* authorization.require(actor, { resource: "restaurant", actions: [action] });

    return Actor.$match(actor, {
      Guest: () =>
        Effect.fail(new RestaurantInputError({ reason: "A verified member is required" })),
      Member: ({ userId }) => Effect.succeed(userId),
    });
  }).pipe(Effect.flatten);

/** Explicit paid prices and unambiguous net food totals only; discounts never become listed prices. */
export function validateReceiptPrice(
  price: NonNullable<MenuImport["items"][number]["variants"][number]["price"]>,
): boolean {
  if (price.receipt === undefined) return price.kind === "listed";
  const receipt = price.receipt;
  const amount = BigDecimal.fromStringUnsafe(price.amount);
  const quantity = BigDecimal.fromStringUnsafe(receipt.quantity);

  if (!BigDecimal.isPositive(quantity)) return false;

  if (
    receipt.explicitUnitPrice !== undefined &&
    !BigDecimal.equals(amount, BigDecimal.fromStringUnsafe(receipt.explicitUnitPrice))
  )
    return false;

  if (receipt.explicitUnitPrice === undefined && receipt.totalSemantics !== "net_food_only")
    return false;

  if (receipt.totalSemantics === "net_food_only") {
    return BigDecimal.equals(
      BigDecimal.multiply(amount, quantity),
      BigDecimal.fromStringUnsafe(receipt.lineTotal),
    );
  }

  return receipt.explicitUnitPrice !== undefined;
}

export const restaurantAdminData = Effect.gen(function* () {
  yield* authorize("manage");
  const venues = yield* runQuery("restaurants/admin-list", (sql) => venuesQuery.run(sql));
  const actor = yield* CurrentActor;
  const authorization = yield* Authorization;

  const canReview = yield* authorization.has(actor, {
    resource: "restaurant",
    actions: ["review"],
  });

  if (!canReview) {
    return { venues, queue: [], canReview };
  }

  const queue = yield* runQuery("restaurants/admin-queue", (sql) => queueQuery.run(sql));

  return { venues, queue, canReview };
});

/** Case-insensitive substring match for admin search. Backslash is the LIKE escape. */
const toContainsPattern = (value: string): string =>
  `%${value.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

const clampPage = (value: number, fallback: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;

  return Math.min(Math.max(Math.trunc(value), 1), max);
};

export const listAdminVenues = Effect.fn("restaurants.listAdminVenues")(function* (input: {
  readonly q: string;
  readonly status: string;
  readonly business: string;
  readonly limit: number;
  readonly offset: number;
}) {
  yield* authorize("manage");

  const limit = clampPage(input.limit, 20, 100);
  const offset = Number.isFinite(input.offset) ? Math.max(Math.trunc(input.offset), 0) : 0;
  const pattern = input.q.trim() === "" ? "" : toContainsPattern(input.q.trim());

  const rows = yield* runQuery("restaurants/admin-venues-page", (sql) =>
    venuesPage.run(sql, {
      q: pattern,
      status: input.status,
      business: input.business,
      limit,
      offset,
    }),
  );

  const first = rows[0];
  const total = first === undefined ? 0 : first.total;

  return { venues: rows, total };
});

export const listAdminBusinesses = Effect.fn("restaurants.listAdminBusinesses")(function* (input: {
  readonly q: string;
  readonly limit: number;
  readonly offset: number;
}) {
  yield* authorize("manage");

  const limit = clampPage(input.limit, 20, 100);
  const offset = Number.isFinite(input.offset) ? Math.max(Math.trunc(input.offset), 0) : 0;
  const pattern = input.q.trim() === "" ? "" : toContainsPattern(input.q.trim());

  const rows = yield* runQuery("restaurants/admin-businesses", (sql) =>
    businessesQuery.run(sql, { q: pattern, limit, offset }),
  );

  const first = rows[0];
  const total = first === undefined ? 0 : first.total;

  return { businesses: rows, total };
});

export const getVenueSources = Effect.fn("restaurants.getVenueSources")(function* (input: {
  readonly venueId: string;
  readonly limit: number;
}) {
  yield* authorize("manage");

  return yield* runQuery("restaurants/venue-sources", (sql) =>
    venueSources.run(sql, { venue: input.venueId, limit: clampPage(input.limit, 10, 50) }),
  );
});

export const writeVenue = Effect.fn("restaurants.writeVenue")(function* (
  input: z.infer<typeof venueWriteSchema>,
) {
  const actorId = yield* authorize("manage");

  if (input.status === "published") yield* authorize("review");

  return yield* withTransaction(
    "restaurants/write-venue",
    Effect.gen(function* () {
      let businessId = input.businessId;
      const venueId = input.venueId;

      if (venueId !== undefined) {
        const existing = yield* runQuery("restaurants/venue-exists", (sql) =>
          findVenue.run(sql, { id: venueId }),
        );

        if (existing === null) return yield* new RestaurantNotFound();

        if (
          existing.address !== input.address ||
          existing.country_code !== input.countryCode ||
          existing.longitude !== input.longitude ||
          existing.latitude !== input.latitude
        ) {
          yield* runQuery("restaurants/invalidate-moved-venue", (sql) =>
            invalidateMoved.run(sql, { venue: venueId }),
          );
        }

        businessId = existing.business_id;

        if (input.businessName !== existing.business_name) {
          const renamed = yield* runQuery("restaurants/rename-business", (sql) =>
            renameBusiness.run(sql, { id: existing.business_id, name: input.businessName }),
          );

          if (renamed === null) return yield* new RestaurantNotFound();

          yield* recordAuditEvent({
            actorUserId: actorId,
            sessionId: null,
            requestId: crypto.randomUUID(),
            event: "restaurant.business.renamed",
            outcome: "succeeded",
            resource: existing.business_id,
            metadata: { venue: venueId, name: input.businessName },
          });
        }
      }

      if (businessId === undefined) {
        const business = yield* runQuery("restaurants/create-business", (sql) =>
          businessQuery.run(sql, { name: input.businessName }),
        );

        businessId = business.id;
      }

      const result = yield* runQuery("restaurants/write-venue", (sql) =>
        venueQuery.run(sql, {
          id: input.venueId ?? crypto.randomUUID(),
          business: businessId,
          name: input.name,
          address: input.address,
          area: input.area,
          country: input.countryCode,
          longitude: input.longitude,
          latitude: input.latitude,
          status: input.status,
        }),
      );

      yield* runQuery("restaurants/name", (sql) =>
        nameQuery.run(sql, { venue: result.id, name: input.name }),
      );
      yield* runQuery("restaurants/cuisines-clear", (sql) =>
        clearCuisines.run(sql, { venue: result.id }),
      );
      yield* runQuery("restaurants/cuisines", (sql) =>
        insertCuisines.run(sql, { venue: result.id, ids: input.cuisineIds.map(BigInt) }),
      );
      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.venue.updated",
        outcome: "succeeded",
        resource: result.id,
      });

      return result;
    }),
  );
});

export const importMenu = Effect.fn("restaurants.importMenu")(function* (request: MenuImport) {
  const actorId = yield* authorize("manage");
  const parsed = menuImportSchema.safeParse(request);

  if (!parsed.success)
    return yield* new RestaurantInputError({
      reason: parsed.error.issues.map((issue) => issue.message).join("; "),
    });
  const input = parsed.data;

  const dishIds = [
    ...new Set(input.items.flatMap((item) => (item.dishId === undefined ? [] : [item.dishId]))),
  ];

  const published = yield* getPublishedDishIdentities(dishIds);

  if (published.length !== dishIds.length)
    return yield* new RestaurantInputError({
      reason: "Serving evidence must reference published dishes",
    });

  for (const item of input.items) {
    for (const variant of item.variants) {
      if (variant.price !== undefined && !validateReceiptPrice(variant.price)) {
        return yield* new RestaurantInputError({
          reason: "Paid unit amount does not match unambiguous receipt evidence",
        });
      }
    }
  }

  const days = yield* Config.Int("RESTAURANT_REVIEW_DAYS").pipe(Config.withDefault(90));

  if (days < 1 || days > 365)
    return yield* new RestaurantInputError({
      reason: "Restaurant review horizon must be 1–365 days",
    });

  const reviewAfter = new Date(
    Math.min(
      Date.parse(input.source.validUntil),
      Date.parse(input.source.observedAt) + days * 86400000,
    ),
  ).toISOString();

  return yield* withTransaction(
    "restaurants/import-menu",
    Effect.gen(function* () {
      const source = yield* runQuery("restaurants/import-source", (sql) =>
        sourceQuery.run(sql, {
          venue: input.venueId,
          category: input.source.category,
          url: input.source.url ?? null,
          object_key: input.source.privateObjectKey ?? null,
          deduplication: input.source.deduplicationKey,
          verified: false,
          observed: input.source.observedAt,
          until: input.source.validUntil,
          actor: actorId,
        }),
      );

      const menu = yield* runQuery("restaurants/import-menu", (sql) =>
        menuQuery.run(sql, {
          id: input.menuId ?? crypto.randomUUID(),
          venue: input.venueId,
          name: input.menuName,
          source_language: input.sourceLanguage ?? null,
        }),
      );

      if (menu === null)
        return yield* new RestaurantInputError({ reason: "Menu belongs to another venue" });
      const priceIds: Array<string> = [];
      const evidenceIds: Array<string> = [];
      const offeringIds: Array<{ itemId: string; variantId: string }> = [];

      for (const item of input.items) {
        const createdItem = yield* runQuery("restaurants/import-item", (sql) =>
          itemQuery.run(sql, {
            id: item.itemId ?? crypto.randomUUID(),
            venue: input.venueId,
            menu: menu.id,
            name: item.name,
            description: item.description,
            source: source.id,
            translation_language: item.translation?.language ?? null,
            translated_name: item.translation?.name ?? null,
            translated_description: item.translation?.description ?? null,
            explanation: item.translation?.explanation ?? null,
          }),
        );

        if (createdItem === null)
          return yield* new RestaurantInputError({
            reason: "Item belongs to another menu or venue",
          });
        const dishId = item.dishId;

        if (dishId !== undefined) {
          const evidence = yield* runQuery("restaurants/import-evidence", (sql) =>
            evidenceQuery.run(sql, {
              venue: input.venueId,
              item: createdItem.id,
              dish: BigInt(dishId),
              source: source.id,
              match: item.matchKind,
              observed: input.source.observedAt,
              until: reviewAfter,
            }),
          );

          evidenceIds.push(evidence.id);
        }

        for (const variant of item.variants) {
          const createdVariant = yield* runQuery("restaurants/import-variant", (sql) =>
            variantQuery.run(sql, {
              id: variant.variantId ?? crypto.randomUUID(),
              venue: input.venueId,
              item: createdItem.id,
              name: variant.name,
              comparison: variant.comparisonKey ?? null,
              translation_language: variant.translation?.language ?? null,
              translated_label: variant.translation?.label ?? null,
            }),
          );

          if (createdVariant === null)
            return yield* new RestaurantInputError({
              reason: "Variant belongs to another item or venue",
            });
          offeringIds.push({ itemId: createdItem.id, variantId: createdVariant.id });
          const price = variant.price;

          if (price === undefined) continue;

          const observation = yield* runQuery("restaurants/import-price", (sql) =>
            priceQuery.run(sql, {
              venue: input.venueId,
              variant: createdVariant.id,
              source: source.id,
              line: price.sourceLineKey,
              kind: price.kind,
              amount: price.amount,
              raw_text: price.rawText ?? null,
              currency: price.currency,
              channel: price.channel,
              tax: price.taxTreatment,
              observed: input.source.observedAt,
              until: reviewAfter,
            }),
          );

          if (observation === null)
            return yield* new RestaurantInputError({ reason: "Price observation was rejected" });
          priceIds.push(observation.id);

          if (price.receipt !== undefined) {
            const receipt = price.receipt;
            yield* runQuery("restaurants/import-receipt", (sql) =>
              receiptQuery.run(sql, {
                observation: observation.id,
                quantity: receipt.quantity,
                unit: receipt.explicitUnitPrice ?? null,
                total: receipt.lineTotal,
                discount: receipt.discount,
                fees: receipt.taxesFees,
                semantics: receipt.totalSemantics,
              }),
            );
          }
        }
      }

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.menu.imported",
        outcome: "succeeded",
        resource: menu.id,
      });

      return { menuId: menu.id, sourceId: source.id, priceIds, evidenceIds, offeringIds };
    }),
  );
});

export const reviewObservation = Effect.fn("restaurants.reviewObservation")(function* (
  input: z.infer<typeof reviewSchema>,
) {
  const actorId = yield* authorize("review");

  return yield* withTransaction(
    "restaurants/review",
    Effect.gen(function* () {
      const params = { id: input.id, actor: actorId, status: input.status };

      const result =
        input.kind === "price"
          ? yield* runQuery("restaurants/review-price", (sql) => reviewPrice.run(sql, params))
          : yield* runQuery("restaurants/review-serving", (sql) => reviewEvidence.run(sql, params));

      if (result === null)
        return yield* new PersistenceConflict({
          operation: "restaurants/review",
          constraint: "observation_pending",
        });

      if (input.status === "approved") {
        yield* runQuery("restaurants/publish-reviewed-variant", (sql) =>
          publishReviewedVariant.run(sql, { id: input.id, kind: input.kind }),
        );
        yield* runQuery("restaurants/publish-reviewed-item", (sql) =>
          publishReviewedItem.run(sql, { id: input.id, kind: input.kind }),
        );
      }

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: `restaurant.${input.kind}.${input.status}`,
        outcome: "succeeded",
        resource: input.id,
      });

      return result;
    }),
  );
});

export const setMenuStatus = Effect.fn("restaurants.setMenuStatus")(function* (
  input: z.infer<typeof menuStatusSchema>,
) {
  const actorId = yield* authorize("manage");

  if (input.status === "published") yield* authorize("review");

  return yield* withTransaction(
    "restaurants/menu-status",
    Effect.gen(function* () {
      const result = yield* runQuery("restaurants/menu-status", (sql) =>
        menuStatusQuery.run(sql, { id: input.menuId, status: input.status }),
      );

      if (result === null) return yield* new RestaurantNotFound();
      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.menu.status",
        outcome: "succeeded",
        resource: input.menuId,
      });

      return result;
    }),
  );
});

export const setOfferingStatus = Effect.fn("restaurants.setOfferingStatus")(function* (
  input: z.infer<typeof offeringStatusSchema>,
) {
  const actorId = yield* authorize("manage");

  if (input.status === "published") yield* authorize("review");

  return yield* withTransaction(
    "restaurants/offering-status",
    Effect.gen(function* () {
      const params = { id: input.id, status: input.status };

      const result =
        input.kind === "item"
          ? yield* runQuery("restaurants/item-status", (sql) => itemStatus.run(sql, params))
          : yield* runQuery("restaurants/variant-status", (sql) => variantStatus.run(sql, params));

      if (result === null) return yield* new RestaurantNotFound();
      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: `restaurant.${input.kind}.status`,
        outcome: "succeeded",
        resource: input.id,
      });

      return result;
    }),
  );
});

export const setVenuesStatus = Effect.fn("restaurants.setVenuesStatus")(function* (input: {
  readonly ids: ReadonlyArray<string>;
  readonly status: "draft" | "published" | "archived";
}) {
  const actorId = yield* authorize("manage");

  if (input.status === "published") yield* authorize("review");

  if (input.ids.length === 0 || input.ids.length > 100) {
    return yield* new RestaurantInputError({ reason: "Select between 1 and 100 branches" });
  }

  return yield* withTransaction(
    "restaurants/venues-status",
    Effect.gen(function* () {
      const rows = yield* runQuery("restaurants/venues-status", (sql) =>
        venuesStatus.run(sql, { ids: [...input.ids], status: input.status }),
      );

      for (const row of rows) {
        yield* recordAuditEvent({
          actorUserId: actorId,
          sessionId: null,
          requestId: crypto.randomUUID(),
          event: "restaurant.venue.status",
          outcome: "succeeded",
          resource: row.id,
        });
      }

      return { updated: rows.map((row) => row.id) };
    }),
  );
});
