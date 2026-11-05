import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type {
  NearbyDishPrice,
  NearbyDishPriceLookup,
  NearbyPriceOutcome,
  NearbyPriceRadiusKm,
  NearbyPriceScope,
} from "@/modules/restaurant-discovery/nearby-price";
import { lookupNearbyDishPricesFn } from "@/modules/restaurant-discovery/restaurant.functions";

export type {
  NearbyDishPrice,
  NearbyDishPriceLookup,
  NearbyPriceOutcome,
  NearbyPriceRadiusKm,
  NearbyPriceScope,
};

/**
 * Food Discovery bridge to Restaurant Discovery nearby-price evidence.
 *
 * Food Discovery owns ranking; Restaurant Discovery owns serving/price
 * evidence. This file only validates the quiz-side input and delegates to
 * the canonical `lookupNearbyDishPricesFn`. It runs no SQL, ranks nothing,
 * and never forwards coordinates to the ranking model.
 */

const decimalDishIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);

/**
 * Boundary validation for the bridge. Coordinates stay ephemeral: POST
 * keeps them out of URLs/logs, and the handler persists nothing.
 */
export const nearbyPriceLookupInputSchema = z.object({
  dishIds: z.array(decimalDishIdSchema).min(1).max(12),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  channel: z.literal("dine_in").optional(),
  cityPlaceId: decimalDishIdSchema.optional(),
});

export type NearbyPriceLookupInput = z.infer<typeof nearbyPriceLookupInputSchema>;

export const lookupNearbyDishPricesBridgeFn = createServerFn({ method: "POST" })
  .validator(nearbyPriceLookupInputSchema)
  .handler(async ({ data }) => {
    return lookupNearbyDishPricesFn({
      data: {
        dishIds: [...data.dishIds],
        latitude: data.latitude,
        longitude: data.longitude,
        channel: data.channel ?? "dine_in",
        cityPlaceId: data.cityPlaceId ?? null,
      },
    });
  });
