import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Public web-research server functions. Zod validates every external input
 * at the boundary (trimmed strings with length bounds; city/country always
 * required, dish required for restaurant and price lookups). The model
 * choice is never accepted from the client — transport, model, and budget
 * come from server configuration only. Outcomes are client-safe JSON.
 */

const cityField = z.string().trim().min(1, "City is required.").max(120);

const countryField = z.string().trim().min(1, "Country is required.").max(120);

const dishField = z.string().trim().min(1, "Dish is required.").max(200);

const languageField = z.string().trim().min(2).max(16).optional();

const portionField = z.string().trim().min(1).max(80).optional();

const channelField = z.string().trim().min(1).max(80).optional();

const currencyField = z.string().trim().min(1).max(8).optional();

export const researchDishesSchema = z.object({
  city: cityField,
  country: countryField,
  language: languageField,
});

export const researchRestaurantsSchema = z.object({
  city: cityField,
  country: countryField,
  dish: dishField,
  language: languageField,
});

export const researchPricesSchema = z.object({
  dish: dishField,
  city: cityField,
  country: countryField,
  portion: portionField,
  channel: channelField,
  currency: currencyField,
  language: languageField,
});

export const researchDishesFn = createServerFn({ method: "POST" })
  .validator(researchDishesSchema)
  .handler(async ({ data }) => {
    const { Effect, Layer } = await import("effect");
    const { MetaResponsesLive } = await import("@/server/integrations/meta-responses");
    const { WebResearch, WebResearchLive } = await import("@/server/web-research/research-service");
    const { runClientOperation } = await import("@/server/http/run-client-operation");

    const program = Effect.flatMap(WebResearch, (service) => service.researchDishes(data));

    return runClientOperation(
      Effect.provide(program, Layer.provide(WebResearchLive, MetaResponsesLive)),
      "search",
    );
  });

export const researchRestaurantsFn = createServerFn({ method: "POST" })
  .validator(researchRestaurantsSchema)
  .handler(async ({ data }) => {
    const { Effect, Layer } = await import("effect");
    const { MetaResponsesLive } = await import("@/server/integrations/meta-responses");
    const { WebResearch, WebResearchLive } = await import("@/server/web-research/research-service");
    const { runClientOperation } = await import("@/server/http/run-client-operation");

    const program = Effect.flatMap(WebResearch, (service) => service.researchRestaurants(data));

    return runClientOperation(
      Effect.provide(program, Layer.provide(WebResearchLive, MetaResponsesLive)),
      "search",
    );
  });

export const researchPricesFn = createServerFn({ method: "POST" })
  .validator(researchPricesSchema)
  .handler(async ({ data }) => {
    const { Effect, Layer } = await import("effect");
    const { MetaResponsesLive } = await import("@/server/integrations/meta-responses");
    const { WebResearch, WebResearchLive } = await import("@/server/web-research/research-service");
    const { runClientOperation } = await import("@/server/http/run-client-operation");

    const program = Effect.flatMap(WebResearch, (service) => service.researchPrices(data));

    return runClientOperation(
      Effect.provide(program, Layer.provide(WebResearchLive, MetaResponsesLive)),
      "search",
    );
  });
