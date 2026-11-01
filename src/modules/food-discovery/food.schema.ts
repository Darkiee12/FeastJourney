import { z } from "zod";

import {
  MEAL_OCCASIONS,
  RECOMMENDATION_MOODS,
} from "@/modules/food-discovery/recommendation.constants";

export const localeSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z]{2,8})?$/, "locale must be a BCP 47 tag")
  .default("en");

export const languageTagSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z]{2,8})?$/, "language_tag must be a BCP 47 tag");

export const dbIdSchema = z.string().regex(/^[0-9]+$/, "id must be a decimal id string");

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase alphanumeric with hyphens")
  .max(120);

const modeSchema = z.enum(["any", "all"]).default("any");

export const dishSearchQuerySchema = z.object({
  q: z.string().max(200).optional(),
  locale: localeSchema,
  ingredient: z.array(z.string()).optional(),
  ingredient_mode: modeSchema,
  category: z.array(z.string()).optional(),
  category_mode: modeSchema,
  cuisine: z.string().max(80).optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/, "country must be an ISO 3166 code")
    .optional(),
  region: dbIdSchema.optional(),
  place: dbIdSchema.optional(),
  association: z.enum(["origin", "associated", "popular"]).optional(),
  sort: z.enum(["relevance", "recent"]).default("relevance"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional(),
});

export type DishSearchQuery = z.infer<typeof dishSearchQuerySchema>;

export const carouselQuerySchema = z
  .object({
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/, "country must be an ISO 3166 code")
      .optional(),
    /**
     * Canonical city scope: a decimal place id from the place registry
     * (locality or broader). Serves the place subtree, falling back to the
     * country hint and then worldwide. Mutually exclusive with every other
     * scope, exactly like worldwide.
     */
    place: dbIdSchema.optional(),
    worldwide: z.boolean().optional(),
    locale: localeSchema,
    limit: z.coerce.number().int().min(1).max(20).default(5),
    /**
     * Rotation seed for the carousel selection (Agent B). Same seed + same
     * scope renders the same set (session-stable); incrementing it renders
     * "another set". Additive optional field — older clients omit it and get
     * the stable default order.
     */
    seed: z.coerce.number().int().min(0).max(2147483647).default(0),
  })
  .superRefine((value, context) => {
    const hasLatitude = value.latitude !== undefined;
    const hasLongitude = value.longitude !== undefined;
    const hasCountry = value.country !== undefined;
    const hasPlace = value.place !== undefined;
    const worldwide = value.worldwide === true;

    // Exactly one scope per call: a worldwide request must never carry
    // coordinates, a country, or a city; a city request must never carry
    // coordinates or a country. Otherwise the service could silently run a
    // precise search for it.
    if (worldwide) {
      if (hasLatitude || hasLongitude || hasCountry || hasPlace) {
        context.addIssue({
          code: "custom",
          message: "worldwide must not carry coordinates, country, or city; send one scope only",
          path: ["worldwide"],
        });
      }

      return;
    }

    if (hasPlace) {
      if (hasLatitude || hasLongitude || hasCountry) {
        context.addIssue({
          code: "custom",
          message: "city place must not carry coordinates or country; send one scope only",
          path: ["place"],
        });
      }

      return;
    }

    if (hasLatitude !== hasLongitude) {
      context.addIssue({
        code: "custom",
        message: "latitude and longitude must be sent together",
        path: [hasLatitude ? "longitude" : "latitude"],
      });

      return;
    }

    // Nearby coordinates may carry a country hint (fallback pool when the
    // precise bands are empty); country alone is its own scope.
    if ((hasLatitude && hasLongitude) || hasCountry) {
      return;
    }

    context.addIssue({
      code: "custom",
      message: "send exactly one scope: country, city place, nearby coordinates, or worldwide",
      path: ["worldwide"],
    });
  });

export type CarouselQuery = z.infer<typeof carouselQuerySchema>;

export const dishDetailParamsSchema = z.object({
  id: z.string().min(1).max(120),
  locale: localeSchema,
});

export const dishBatchQuerySchema = z.object({
  ids: z.array(dbIdSchema).min(1).max(50),
  locale: localeSchema,
});

export const relatedQuerySchema = z.object({
  locale: localeSchema,
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

export const nameSearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  locale: localeSchema,
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const placeQuerySchema = z.object({
  locale: localeSchema,
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Country chooser bound: all ISO countries fit well under this cap. */
export const countryQuerySchema = z.object({
  locale: localeSchema,
  limit: z.coerce.number().int().min(1).max(300).default(250),
});

export const placeDishesQuerySchema = z.object({
  locale: localeSchema,
  association: z.enum(["origin", "associated", "popular"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const mealSchema = z.enum(MEAL_OCCASIONS).default("anything");

const recommendationMoodSchema = z.enum(RECOMMENDATION_MOODS).default("any");

const isoCountrySchema = z
  .string()
  .regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/, "country must be an ISO 3166 code");

/**
 * Where the recommendation should look. The variants are mutually exclusive
 * by construction: an approximate network-region country, precise visitor
 * coordinates, an explicitly chosen destination country, an explicitly
 * chosen canonical city (place id, resolved against the place registry —
 * never a free-text name), or the whole world. Coordinates stay ephemeral
 * on the client and are never persisted; the server never logs them and
 * never forwards them to the ranking model. Accuracy is meters as reported
 * by the geolocation API (null when unknown). The city variant carries an
 * optional country hint used only for the honest wider-pool fallback when
 * the city subtree holds no dishes.
 */
export const recommendationLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approx"), country: isoCountrySchema }),
  z.object({
    kind: z.literal("precise"),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    accuracy: z.number().finite().positive().max(100_000).nullish(),
  }),
  z.object({ kind: z.literal("destination"), country: isoCountrySchema }),
  z.object({
    kind: z.literal("city"),
    placeId: dbIdSchema,
    country: isoCountrySchema.optional(),
    /**
     * Client display label ("Bengaluru, Karnataka, India"). Display-only:
     * the server scopes by placeId and ignores this. Never a substitute
     * for registry resolution.
     */
    label: z.string().max(200).optional(),
  }),
  z.object({ kind: z.literal("worldwide") }),
]);

export type RecommendationLocation = z.infer<typeof recommendationLocationSchema>;

export const recommendationQuerySchema = z
  .object({
    meal: mealSchema,
    /**
     * Canonical unified exclusions (ingredients to avoid). Replaces the
     * legacy avoid/allergies split: one list, one policy.
     */
    excludedIngredients: z.array(z.string().max(100)).max(20).default([]),
    /**
     * Deprecated legacy dislikes: still accepted so older cached clients
     * keep working, merged server-side into excludedIngredients.
     */
    avoid: z.array(z.string().max(100)).max(20).default([]),
    /**
     * Deprecated legacy allergies: still accepted so older cached clients
     * keep working, merged server-side into excludedIngredients with an
     * explicit warning. The strict refusal no longer applies — legacy
     * callers must not assume safety semantics.
     */
    allergies: z.array(z.string().max(100)).max(20).default([]),
    cuisine: z.string().max(80).optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/, "country must be an ISO 3166 code")
      .optional(),
    location: recommendationLocationSchema.optional(),
    mood: recommendationMoodSchema,
    locale: localeSchema,
    surpriseSeed: z.number().int().min(0).max(2147483647).default(0),
  })
  .superRefine((value, context) => {
    if (value.location !== undefined && value.country !== undefined) {
      context.addIssue({
        code: "custom",
        message: "country and location are mutually exclusive; send one scope only",
        path: ["location"],
      });
    }
  });

export type RecommendationQuery = z.infer<typeof recommendationQuerySchema>;

const nameKindSchema = z.enum(["native", "localized", "alias", "transliteration"]);

export const adminNameSchema = z.object({
  language_tag: languageTagSchema,
  name: z.string().trim().min(1).max(300),
  name_kind: nameKindSchema,
});

export const adminCreateDishSchema = z.object({
  slug: slugSchema.optional(),
  status: z.enum(["draft", "review", "published", "archived"]).default("draft"),
  parent_slug: slugSchema.optional(),
  names: z.array(adminNameSchema).min(1).max(20),
});

export const adminUpdateDishSchema = z.object({
  slug: slugSchema.optional(),
  status: z.enum(["draft", "review", "published", "archived"]).optional(),
  parent_slug: slugSchema.nullable().default(null),
});

export const adminStatusSchema = z.object({
  status: z.enum(["draft", "review", "published", "archived"]),
});

export const adminDescriptionSchema = z.object({
  language_tag: languageTagSchema,
  description: z.string().min(1).max(20000),
  summary: z.string().max(1000).nullable().default(null),
});

export const adminIngredientLinkSchema = z.object({
  ingredient_id: dbIdSchema,
  role: z.enum(["core", "common", "optional", "garnish"]),
});

export const adminPlaceLinkSchema = z.object({
  place_id: dbIdSchema,
  association: z.enum(["origin", "associated", "popular"]),
  is_disputed: z.boolean().default(false),
});

export const adminCategoryLinkSchema = z.object({
  category_slug: z.string().min(1).max(80),
});

export const adminCuisineLinkSchema = z.object({
  cuisine_slug: z.string().min(1).max(80),
});

export const adminNoteSchema = z.object({
  author: z.string().trim().min(1).max(200),
  note_kind: z.enum(["review", "correction", "question"]),
  note: z.string().trim().min(1).max(5000),
});

export const reviewQueueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional(),
});

export const adminImportValidateSchema = z.object({
  source_name: z.string().trim().min(1).max(200),
  records: z.array(z.unknown()).min(1).max(100),
});

export const adminImportApplySchema = z.object({
  job_id: dbIdSchema,
  approvals: z.object({
    license_ack: z.boolean(),
    review_ack: z.boolean(),
    duplicate_refs: z.array(z.string().min(1).max(300)),
  }),
});
