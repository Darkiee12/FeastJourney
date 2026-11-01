import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  countryQuerySchema,
  dishBatchQuerySchema,
  dishDetailParamsSchema,
  dishSearchQuerySchema,
  localeSchema,
  nameSearchQuerySchema,
  nearestCityQuerySchema,
  carouselQuerySchema,
  placeQuerySchema,
  recommendationQuerySchema,
  relatedQuerySchema,
} from "@/modules/food-discovery/food.schema";

const loadServer = () =>
  Promise.all([
    import("effect"),
    import("@/modules/food-discovery/server/operations/dish-service"),
    import("@/modules/food-discovery/server/operations/catalog-service"),
    import("@/server/auth/actor"),
    import("@/server/auth/current-actor"),
    import("@/server/runtime"),
  ]);

const loadRecommendServer = () =>
  Promise.all([
    import("effect"),
    import("@/modules/food-discovery/server/operations/recommendation-service"),
    import("@/server/auth/actor"),
    import("@/server/auth/current-actor"),
    import("@/server/auth/session"),
    import("@/server/runtime"),
    import("@/server/http/rate-limit"),
    import("@tanstack/react-start/server"),
    import("@/server/http/request"),
    import("@/server/config"),
  ]);

/**
 * Client-safe transport adapters for the FeastJourney globe and dish cards.
 * Validation runs through Zod at this boundary; server-only Effect modules
 * load dynamically so browser bundles never include database code.
 */
export const searchDishesFn = createServerFn({ method: "GET" })
  .validator(dishSearchQuerySchema)
  .handler(async ({ data }) => {
    const [effects, { DishService }, _catalog, { Actor }, { withActor }, { runApp }] =
      await loadServer();

    return runApp(
      withActor(
        Actor.Guest(),
        effects.Effect.flatMap(DishService, (service) =>
          service.searchDishes({
            q: data.q,
            locale: data.locale,
            ingredientIds: data.ingredient,
            ingredientMode: data.ingredient_mode,
            categorySlugs: data.category,
            categoryMode: data.category_mode,
            cuisine: data.cuisine,
            country: data.country,
            region: data.region,
            placeId: data.place,
            association: data.association,
            sort: data.sort,
            limit: data.limit,
            cursor: data.cursor,
          }),
        ),
      ),
      "fn/dishes/search",
      15000,
      "server-fn",
    );
  });

export const getDishFn = createServerFn({ method: "GET" })
  .validator(dishDetailParamsSchema)
  .handler(async ({ data }) => {
    const [effects, { DishService }, _catalog, { Actor }, { withActor }, { runApp }] =
      await loadServer();

    return runApp(
      withActor(
        Actor.Guest(),
        effects.Effect.flatMap(DishService, (service) => service.getDish(data.id, data.locale)),
      ),
      "fn/dishes/detail",
      15000,
      "server-fn",
    );
  });

/**
 * Batch card projection for member-owned lists. One server round-trip for up
 * to 50 ids; unpublished or unknown ids are omitted and the caller renders
 * an explicit unavailable row for them.
 */
export const getDishSummariesFn = createServerFn({ method: "GET" })
  .validator(dishBatchQuerySchema)
  .handler(async ({ data }) => {
    const [effects, { DishService }, _catalog, { Actor }, { withActor }, { runApp }] =
      await loadServer();

    return runApp(
      withActor(
        Actor.Guest(),
        effects.Effect.flatMap(DishService, (service) =>
          service.getDishSummaries(data.ids, data.locale),
        ),
      ),
      "fn/dishes/summaries",
      15000,
      "server-fn",
    );
  });

export const getRelatedFn = createServerFn({ method: "GET" })
  .validator(dishDetailParamsSchema.and(relatedQuerySchema))
  .handler(async ({ data }) => {
    const [effects, { DishService }, _catalog, { Actor }, { withActor }, { runApp }] =
      await loadServer();

    return runApp(
      withActor(
        Actor.Guest(),
        effects.Effect.flatMap(DishService, (service) =>
          service.getRelated(data.id, data.locale, data.limit),
        ),
      ),
      "fn/dishes/related",
      15000,
      "server-fn",
    );
  });

export const searchIngredientsFn = createServerFn({ method: "GET" })
  .validator(nameSearchQuerySchema)
  .handler(async ({ data }) => {
    const [effects, _dish, { CatalogService }, { Actor }, { withActor }, { runApp }] =
      await loadServer();

    return runApp(
      withActor(
        Actor.Guest(),
        effects.Effect.flatMap(CatalogService, (service) =>
          service.searchIngredients(data.q, data.locale, data.limit),
        ),
      ),
      "fn/ingredients/search",
      15000,
      "server-fn",
    );
  });

export const listCategoriesFn = createServerFn({ method: "GET" }).handler(async () => {
  const [effects, _dish, { CatalogService }, { Actor }, { withActor }, { runApp }] =
    await loadServer();

  return runApp(
    withActor(
      Actor.Guest(),
      effects.Effect.flatMap(CatalogService, (service) => service.listCategories("en")),
    ),
    "fn/categories/list",
    15000,
    "server-fn",
  );
});

/**
 * Public place listing for the recommendation country chooser. Reuses the
 * existing CatalogService/place repository — no new SQL. Guests see ISO
 * codes and display names only; suggestions never claim origin, only
 * association (the region step already words it that way).
 */
export const listPlacesFn = createServerFn({ method: "GET" })
  .validator(placeQuerySchema)
  .handler(async ({ data }) => {
    const [effects, _dish, { CatalogService }, { Actor }, { withActor }, { runApp }] =
      await loadServer();

    return runApp(
      withActor(
        Actor.Guest(),
        effects.Effect.flatMap(CatalogService, (service) =>
          service.listPlaces(data.locale, data.limit),
        ),
      ),
      "fn/places/list",
      15000,
      "server-fn",
    );
  });

/**
 * City chooser search for Food Discovery: canonical sub-country places
 * matching a name or alias ("Bangalore" finds Bengaluru), each with the
 * administrative context needed to disambiguate identical names. Guests
 * may search; ids are canonical registry identities, never free text.
 */
export const searchCitiesFn = createServerFn({ method: "GET" })
  .validator(nameSearchQuerySchema)
  .handler(async ({ data }) => {
    const [effects, _dish, { CatalogService }, { Actor }, { withActor }, { runApp }] =
      await loadServer();

    return runApp(
      withActor(
        Actor.Guest(),
        effects.Effect.flatMap(CatalogService, (service) =>
          service.searchCities(data.q, data.locale, data.limit),
        ),
      ),
      "fn/cities/search",
      15000,
      "server-fn",
    );
  });

/**
 * Country chooser for the recommendation region step. Kind-filtered at the
 * database level with verified ISO identity — every eligible country is
 * reachable regardless of how many other places the catalog holds.
 */
export const listCountriesFn = createServerFn({ method: "GET" })
  .validator(countryQuerySchema)
  .handler(async ({ data }) => {
    const [effects, _dish, { CatalogService }, { Actor }, { withActor }, { runApp }] =
      await loadServer();

    return runApp(
      withActor(
        Actor.Guest(),
        effects.Effect.flatMap(CatalogService, (service) =>
          service.listCountries(data.locale, data.limit),
        ),
      ),
      "fn/countries/list",
      15000,
      "server-fn",
    );
  });

/**
 * Nearest catalog city to a coordinate pair, for the honest near-you
 * status line. Returns one canonical city or null when nothing city-scale
 * is close enough — never free text, never a far-away guess.
 */
export const nearestCityFn = createServerFn({ method: "GET" })
  .validator(nearestCityQuerySchema)
  .handler(async ({ data }) => {
    const [effects, _dish, { CatalogService }, { Actor }, { withActor }, { runApp }] =
      await loadServer();

    return runApp(
      withActor(
        Actor.Guest(),
        effects.Effect.flatMap(CatalogService, (service) =>
          service.nearestCity(data.latitude, data.longitude, data.locale),
        ),
      ),
      "fn/cities/nearest",
      15000,
      "server-fn",
    );
  });

/**
 * Single-round-trip local carousel projection: resolves dishes for exactly
 * one scope — visitor coordinates (nearest real catalog associations, with
 * the country hint as fallback pool), a country filter, or the worldwide
 * pool — then returns full cards with names, descriptions, ingredients,
 * regions, and image references. No per-card fetch.
 *
 * Scope forwarding is exclusive by construction: a worldwide request never
 * carries coordinates or a country, so the service can never silently run a
 * precise search for it (fail-closed in the service too). The full
 * empty-pool fallback chain (nearby -> country -> worldwide -> honest empty;
 * country -> worldwide -> honest empty) lives in the service operation; this
 * adapter only keeps the graceful visitor-country behavior — an unknown
 * country code falls back to the worldwide pool instead of surfacing
 * PlaceNotFound. The served scope labels the fallback honestly so the client
 * never misreads it as local coverage. Malformed input stays a validation
 * error; explicit search filters keep their strict semantics.
 */
export const getLocalCarouselFn = createServerFn({ method: "GET" })
  .validator(carouselQuerySchema)
  .handler(async ({ data }) => {
    const [effects, { DishService }, _catalog, { Actor }, { withActor }, { runApp }] =
      await loadServer();

    const { PlaceNotFound } = await import("@/modules/food-discovery/server/domain/errors");

    const runCarousel = (scope: {
      readonly country?: string | undefined;
      readonly place?: string | undefined;
      readonly latitude?: number | undefined;
      readonly longitude?: number | undefined;
      readonly worldwide?: boolean | undefined;
    }) =>
      runApp(
        withActor(
          Actor.Guest(),
          effects.Effect.flatMap(DishService, (service) =>
            service.getLocalCarousel({
              country: scope.country,
              place: scope.place,
              latitude: scope.latitude,
              limit: data.limit,
              locale: data.locale,
              longitude: scope.longitude,
              seed: data.seed,
              worldwide: scope.worldwide,
            }),
          ),
        ),
        "fn/dishes/local-carousel",
        15000,
        "server-fn",
      );

    const runWorldwide = () => runCarousel({ worldwide: true });

    try {
      if (data.worldwide === true) {
        return await runWorldwide();
      }

      if (data.place !== undefined) {
        return await runCarousel({ place: data.place });
      }

      if (data.latitude !== undefined && data.longitude !== undefined) {
        return await runCarousel({
          country: data.country,
          latitude: data.latitude,
          longitude: data.longitude,
        });
      }

      if (data.country !== undefined) {
        return await runCarousel({ country: data.country });
      }

      return await runCarousel({});
    } catch (error) {
      if (error instanceof PlaceNotFound) {
        return await runWorldwide();
      }

      throw error;
    }
  });

export const listCuisinesFn = createServerFn({ method: "GET" })
  .validator(z.object({ locale: localeSchema.optional() }))
  .handler(async ({ data }) => {
    const [effects, _dish, { CatalogService }, { Actor }, { withActor }, { runApp }] =
      await loadServer();

    return runApp(
      withActor(
        Actor.Guest(),
        effects.Effect.flatMap(CatalogService, (service) =>
          service.listCuisines(data.locale ?? "en"),
        ),
      ),
      "fn/cuisines/list",
      15000,
      "server-fn",
    );
  });

/**
 * Public dish recommendations: deterministic baseline for guests, optionally
 * re-ranked by Muse for signed-in members when RECOMMENDATION_PROVIDER is
 * "muse" with valid credentials. The actor always resolves from the verified
 * Better Auth session — never from a client flag. The outcome envelope
 * always returns HTTP 200; empty pools are honest outcomes, not errors.
 * Auth, permanent provider, and misconfiguration failures reject and
 * surface as HTTP 500.
 */
export const recommendDishesFn = createServerFn({ method: "POST" })
  .validator(recommendationQuerySchema)
  .handler(async ({ data }) => {
    const [
      effects,
      { RecommendationService, toWireOutcome },
      { Actor },
      { withActor },
      { resolveSession },
      { runApp },
      { RateLimitPolicy },
      server,
      { resolveIdentityFromHeaders },
      { appConfig },
    ] = await loadRecommendServer();

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    // Enforce the public recommendation budget BEFORE any database or model
    // work. Thrown Responses bypass TanStack's header filtering, so the
    // 429 status and Retry-After survive to the client (verified against
    // the installed start-server-core handler).
    await runApp(
      effects.Effect.flatMap(RateLimitPolicy, (policy) =>
        effects.Effect.flatMap(appConfig, (config) =>
          policy.check("search", resolveIdentityFromHeaders(headers, config)).pipe(
            effects.Effect.catchTag("RateLimitExceeded", (failure) =>
              effects.Effect.die(
                new Response(
                  JSON.stringify({
                    error: "rate_limited",
                    retryAfterSeconds: failure.retryAfterSeconds,
                  }),
                  {
                    status: 429,
                    headers: {
                      "content-type": "application/json",
                      "Retry-After": String(failure.retryAfterSeconds),
                    },
                  },
                ),
              ),
            ),
            effects.Effect.catchTag("StoreUnavailable", () =>
              effects.Effect.die(
                new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
                  status: 503,
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          ),
        ),
      ),
      "fn/dishes/recommend-rate-limit",
      5000,
      requestId,
    );

    // Session-first actor resolution AFTER the budget check (abuse protection
    // runs before any identity work). A verified Better Auth session yields a
    // member (Muse-eligible); no session stays a guest with deterministic
    // ranking. Suspended sessions and store outages fail loudly instead of
    // masquerading as guests.
    const actor = await runApp(
      resolveSession(headers).pipe(
        effects.Effect.map((trusted) => Actor.Member({ userId: trusted.userId })),
        effects.Effect.catchTag("SignInRequired", () => effects.Effect.succeed(Actor.Guest())),
      ),
      "fn/dishes/recommend-actor",
      5000,
      requestId,
    );

    // Unified exclusions: the canonical list first, then legacy avoid /
    // allergies from older cached clients. Exact-dedupe preserving first
    // occurrence, so the canonical order wins on overlap.
    const seenExclusions = new Set<string>();
    const excludedIngredients: Array<string> = [];

    for (const term of [...data.excludedIngredients, ...data.avoid, ...data.allergies]) {
      if (!seenExclusions.has(term)) {
        seenExclusions.add(term);
        excludedIngredients.push(term);
      }
    }

    const outcome = await runApp(
      withActor(
        actor,
        effects.Effect.flatMap(RecommendationService, (service) =>
          service.recommend({
            meal: data.meal,
            excludedIngredients,
            cuisine: data.cuisine,
            country: data.country,
            location: data.location,
            mood: data.mood,
            locale: data.locale,
            surpriseSeed: data.surpriseSeed,
          }),
        ),
      ),
      "fn/dishes/recommend",
      30000,
      "server-fn",
    );

    const wire = toWireOutcome(outcome);

    if (data.allergies.length > 0) {
      return {
        ...wire,
        warnings: [
          ...wire.warnings,
          "Legacy allergy terms were merged as ordinary exclusions; strict refusal no longer applies.",
        ],
      };
    }

    return wire;
  });
