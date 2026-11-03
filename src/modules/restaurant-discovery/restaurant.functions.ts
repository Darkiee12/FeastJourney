import { createServerFn } from "@tanstack/react-start";

import {
  menuImportSchema,
  menuStatusSchema,
  offeringStatusSchema,
  rateRequestSchema,
  restaurantSearchSchema,
  reviewSchema,
  venueIdSchema,
  venuePhotoPreviewSchema,
  venueWriteSchema,
  channelSchema,
} from "@/modules/restaurant-discovery/restaurant.schema";

export const searchRestaurantsFn = createServerFn({ method: "GET" })
  .validator(restaurantSearchSchema)
  .handler(async ({ data }) => {
    const { searchRestaurants } = await import("@/modules/restaurant-discovery/server/index");
    const { runClientOperation } = await import("@/server/http/run-client-operation");

    return runClientOperation(searchRestaurants(data), "search");
  });

export const restaurantAreasFn = createServerFn({ method: "GET" }).handler(async () => {
  const { listRestaurantAreas } = await import("@/modules/restaurant-discovery/server/index");
  const { runClientOperation } = await import("@/server/http/run-client-operation");

  return runClientOperation(listRestaurantAreas);
});

export const getRestaurantFn = createServerFn({ method: "GET" })
  .validator(venueIdSchema.extend({ channel: channelSchema.default("dine_in") }))
  .handler(async ({ data }) => {
    const { getRestaurant } = await import("@/modules/restaurant-discovery/server/index");
    const { runClientOperation } = await import("@/server/http/run-client-operation");

    return runClientOperation(getRestaurant(data.venueId, data.channel));
  });

export const supportedCurrenciesFn = createServerFn({ method: "GET" }).handler(async () => {
  const { Effect } = await import("effect");
  const { FxRates } = await import("@/modules/restaurant-discovery/server/index");
  const { runClientOperation } = await import("@/server/http/run-client-operation");

  return runClientOperation(Effect.flatMap(FxRates, (fx) => fx.supportedCurrencies));
});

export const exchangeRatesFn = createServerFn({ method: "GET" })
  .validator(rateRequestSchema)
  .handler(async ({ data }) => {
    const { Effect } = await import("effect");
    const { FxRates } = await import("@/modules/restaurant-discovery/server/index");
    const { runClientOperation } = await import("@/server/http/run-client-operation");

    return runClientOperation(
      Effect.gen(function* () {
        const fx = yield* FxRates;

        return yield* Effect.forEach(
          [...new Set(data.bases)].filter((base) => base !== data.quote),
          (base) => fx.rate(base, data.quote),
          { concurrency: 4 },
        );
      }),
    );
  });

// Authentication builds the Actor; every privileged operation additionally checks its own grant.
const adminContext = async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server");
  const { requireAuthenticatedActor } = await import("@/server/auth/session");
  const { Actor } = await import("@/server/auth/actor");
  const { withActor } = await import("@/server/auth/current-actor");
  const { runClientOperation } = await import("@/server/http/run-client-operation");
  const session = await runClientOperation(requireAuthenticatedActor(getRequestHeaders()), "admin");

  return { actor: Actor.Member({ userId: session.userId }), withActor, runClientOperation };
};

export const restaurantAdminFn = createServerFn({ method: "GET" }).handler(async () => {
  const { restaurantAdminData } = await import("@/modules/restaurant-discovery/server/index");
  const { actor, withActor, runClientOperation } = await adminContext();

  return runClientOperation(withActor(actor, restaurantAdminData), null);
});

export const writeVenueFn = createServerFn({ method: "POST" })
  .validator(venueWriteSchema)
  .handler(async ({ data }) => {
    const { writeVenue } = await import("@/modules/restaurant-discovery/server/index");
    const { actor, withActor, runClientOperation } = await adminContext();

    return runClientOperation(withActor(actor, writeVenue(data)), null);
  });

export const importMenuFn = createServerFn({ method: "POST" })
  .validator(menuImportSchema)
  .handler(async ({ data }) => {
    const { importMenu } = await import("@/modules/restaurant-discovery/server/index");
    const { actor, withActor, runClientOperation } = await adminContext();

    return runClientOperation(withActor(actor, importMenu(data)), null);
  });

export const reviewRestaurantFn = createServerFn({ method: "POST" })
  .validator(reviewSchema)
  .handler(async ({ data }) => {
    const { reviewObservation } = await import("@/modules/restaurant-discovery/server/index");
    const { actor, withActor, runClientOperation } = await adminContext();

    return runClientOperation(withActor(actor, reviewObservation(data)), null);
  });

export const setMenuStatusFn = createServerFn({ method: "POST" })
  .validator(menuStatusSchema)
  .handler(async ({ data }) => {
    const { setMenuStatus } = await import("@/modules/restaurant-discovery/server/index");
    const { actor, withActor, runClientOperation } = await adminContext();

    return runClientOperation(withActor(actor, setMenuStatus(data)), null);
  });

export const restaurantFacetsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { Effect } = await import("effect");
  const { CatalogService } = await import("@/modules/food-discovery/server/index");
  const { runClientOperation } = await import("@/server/http/run-client-operation");

  return runClientOperation(
    Effect.flatMap(CatalogService, (catalog) => catalog.listCuisines("en")),
  );
});

export const setOfferingStatusFn = createServerFn({ method: "POST" })
  .validator(offeringStatusSchema)
  .handler(async ({ data }) => {
    const { setOfferingStatus } = await import("@/modules/restaurant-discovery/server/index");
    const { actor, withActor, runClientOperation } = await adminContext();

    return runClientOperation(withActor(actor, setOfferingStatus(data)), null);
  });

// Public preview read: search rows carry no photos, so cards resolve one
// batched preview per visible venue list through here. Imports the owning
// operation module directly; server/index.ts stays coordinator-owned.
export const venuePhotoPreviewsFn = createServerFn({ method: "GET" })
  .validator(venuePhotoPreviewSchema)
  .handler(async ({ data }) => {
    const { listVenuePhotoPreviews } =
      await import("@/modules/restaurant-discovery/server/operations/discovery");

    const { runClientOperation } = await import("@/server/http/run-client-operation");

    return runClientOperation(listVenuePhotoPreviews(data), "search");
  });

// Channel availability read: distinct sales channels with current listed
// prices for one venue. The menu panel shows its channel control only when
// two or more eligible channels qualify; dine-in-only venues get no UI.
export const getVenueChannelsFn = createServerFn({ method: "GET" })
  .validator(venueIdSchema)
  .handler(async ({ data }) => {
    const { Effect } = await import("effect");

    const venueChannels = (
      await import("@/modules/restaurant-discovery/server/repository/sql/venue-channels.sql")
    ).default;

    const { runQuery } = await import("@/server/database/query");

    const { runClientOperation } = await import("@/server/http/run-client-operation");

    return runClientOperation(
      Effect.map(
        runQuery("restaurants/venue-channels", (sql) =>
          venueChannels.run(sql, { id: data.venueId }),
        ),
        (rows) => rows.map((row) => row.sales_channel),
      ),
    );
  });
