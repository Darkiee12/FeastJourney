import { z } from "zod";

import { isAmount, isCurrency } from "@/shared/money";

export const currencySchema = z.string().refine(isCurrency, "Choose a supported ISO currency");

export const amountSchema = z
  .string()
  .max(49)
  .refine(isAmount, "Enter an exact nonnegative decimal amount")
  .refine(
    (value) => value.replace(/\..*$/, "").length <= 30,
    "Amounts support at most 30 integer digits",
  );

export const channelSchema = z.enum(["dine_in", "takeaway", "delivery"]);
export const portionSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

export const restaurantSearchSchema = z
  .object({
    q: z.string().trim().max(100).default(""),
    area: z.string().trim().max(200).default(""),
    cuisine: z.string().max(100).default(""),
    dish: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
    latitude: z.coerce.number().min(-90).max(90).optional(),
    radius: z.coerce.number().int().min(100).max(50000).default(5000),
    west: z.coerce.number().min(-180).max(180).optional(),
    south: z.coerce.number().min(-90).max(90).optional(),
    east: z.coerce.number().min(-180).max(180).optional(),
    north: z.coerce.number().min(-90).max(90).optional(),
    channel: channelSchema.default("dine_in"),
    portion: portionSchema.optional(),
    sort: z.enum(["recommended", "nearest", "price_low", "price_high"]).default("recommended"),
    budget: amountSchema.optional(),
    currency: currencySchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  })
  .superRefine((data, context) => {
    if ((data.longitude === undefined) !== (data.latitude === undefined)) {
      context.addIssue({ code: "custom", message: "Provide both origin coordinates" });
    }

    const bounds = [data.west, data.south, data.east, data.north];

    if (
      bounds.some((value) => value !== undefined) &&
      bounds.some((value) => value === undefined)
    ) {
      context.addIssue({ code: "custom", message: "Provide all four map bounds" });
    }

    if (data.south !== undefined && data.north !== undefined && data.south >= data.north) {
      context.addIssue({ code: "custom", message: "South must be below north" });
    }

    if (data.sort === "nearest" && data.longitude === undefined) {
      context.addIssue({ code: "custom", message: "Nearest requires an explicit origin" });
    }

    if (data.sort.startsWith("price_") || data.budget !== undefined) {
      if (data.dish === undefined || data.portion === undefined || data.currency === undefined) {
        context.addIssue({
          code: "custom",
          message: "Price comparison requires a dish, comparable portion and currency",
        });
      }
    }
  });

export type RestaurantSearch = z.infer<typeof restaurantSearchSchema>;

export const venueIdSchema = z.object({ venueId: z.uuid() });

/**
 * Bounded photo-preview request: 1..50 venue ids, the search page size.
 * The preview read issues one IN-clause query for the whole list.
 */
export const venuePhotoPreviewSchema = z.object({
  venueIds: z.array(z.uuid()).min(1).max(50),
});

export type VenuePhotoPreviewRequest = z.infer<typeof venuePhotoPreviewSchema>;

export const rateRequestSchema = z.object({
  bases: z.array(currencySchema).max(12),
  quote: currencySchema,
});

export const venueWriteSchema = z.object({
  venueId: z.uuid().optional(),
  businessId: z.uuid().optional(),
  businessName: z.string().trim().min(1).max(300),
  name: z.string().trim().min(1).max(300),
  address: z.string().trim().min(1).max(1000),
  area: z.string().trim().min(1).max(200),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
  status: z.enum(["draft", "published", "archived"]),
  cuisineIds: z
    .array(z.string().regex(/^[1-9][0-9]{0,18}$/))
    .max(20)
    .default([]),
});

const receiptSchema = z.object({
  quantity: amountSchema.refine((value) => /[1-9]/.test(value), "Quantity must be positive"),
  explicitUnitPrice: amountSchema.optional(),
  lineTotal: amountSchema,
  discount: amountSchema.nullable(),
  taxesFees: amountSchema.nullable(),
  totalSemantics: z.enum(["net_food_only", "includes_fees", "unknown"]),
});

export const menuImportSchema = z
  .object({
    venueId: z.uuid(),
    menuId: z.uuid().optional(),
    menuName: z.string().trim().min(1).max(300),
    sourceLanguage: z.enum(["en", "vi", "ja", "zh", "ko", "fr", "es"]).nullable().optional(),
    source: z.object({
      category: z.enum(["official_menu", "menu_photo", "receipt", "authorized_provider"]),
      url: z
        .url()
        .max(2000)
        .refine((url) => /^https?:\/\//.test(url))
        .optional(),
      privateObjectKey: z.string().min(1).max(500).optional(),
      deduplicationKey: z.string().min(1).max(200),
      restaurantVerified: z.literal(false).default(false),
      observedAt: z.iso.datetime({ offset: true }),
      validUntil: z.iso.datetime({ offset: true }),
    }),
    items: z
      .array(
        z.object({
          itemId: z.uuid().optional(),
          name: z.string().trim().min(1).max(300),
          description: z.string().max(3000).default(""),
          translation: z
            .object({
              language: z.enum(["en", "vi", "ja", "zh", "ko", "fr", "es"]),
              name: z.string().min(1).max(300).nullable(),
              description: z.string().min(1).max(3000).nullable(),
              explanation: z.string().min(1).max(3000).nullable(),
            })
            .optional(),
          dishId: z
            .string()
            .regex(/^[1-9][0-9]{0,18}$/)
            .optional(),
          matchKind: z.enum(["exact", "variant", "suggestion"]).default("suggestion"),
          variants: z
            .array(
              z.object({
                variantId: z.uuid().optional(),
                name: z.string().trim().min(1).max(200).default("As listed"),
                comparisonKey: portionSchema.optional(),
                translation: z
                  .object({
                    language: z.enum(["en", "vi", "ja", "zh", "ko", "fr", "es"]),
                    label: z.string().min(1).max(300).nullable(),
                  })
                  .optional(),
                price: z
                  .object({
                    amount: amountSchema,
                    rawText: z.string().max(200).optional(),
                    currency: currencySchema,
                    kind: z.enum(["listed", "paid_unit"]),
                    channel: channelSchema,
                    taxTreatment: z.enum(["included", "excluded", "unknown"]),
                    sourceLineKey: z.string().min(1).max(100),
                    receipt: receiptSchema.optional(),
                  })
                  .optional(),
              }),
            )
            .min(1)
            .max(20),
        }),
      )
      .min(1)
      .max(100),
  })
  .superRefine((data, context) => {
    const { source } = data;

    if (source.url === undefined && source.privateObjectKey === undefined) {
      context.addIssue({ code: "custom", message: "A source URL or private object is required" });
    }

    if (
      source.category === "receipt" &&
      (source.url !== undefined || source.privateObjectKey === undefined)
    ) {
      context.addIssue({ code: "custom", message: "Receipt originals must be private" });
    }

    if (
      Date.parse(source.validUntil) <= Date.parse(source.observedAt) ||
      Date.parse(source.observedAt) > Date.now()
    ) {
      context.addIssue({ code: "custom", message: "Invalid source observation/review dates" });
    }

    const keys = new Set<string>();

    for (const item of data.items) {
      for (const variant of item.variants) {
        const price = variant.price;

        if (price === undefined) continue;

        if (keys.has(price.sourceLineKey))
          context.addIssue({ code: "custom", message: "Duplicate source line" });
        keys.add(price.sourceLineKey);

        if (
          (source.category === "receipt") !==
          (price.kind === "paid_unit" && price.receipt !== undefined)
        ) {
          context.addIssue({
            code: "custom",
            message: "Paid receipt observations require structured receipt evidence",
          });
        }

        if (
          source.category !== "receipt" &&
          (price.kind !== "listed" || price.receipt !== undefined)
        ) {
          context.addIssue({
            code: "custom",
            message: "Only receipt sources may supply paid prices",
          });
        }
      }
    }
  });

export type MenuImport = z.infer<typeof menuImportSchema>;

export const reviewSchema = z.object({
  kind: z.enum(["price", "serving"]),
  id: z.uuid(),
  status: z.enum(["approved", "rejected"]),
});

export const menuStatusSchema = z.object({
  menuId: z.uuid(),
  status: z.enum(["published", "archived"]),
});

export const offeringStatusSchema = z.object({
  kind: z.enum(["item", "variant"]),
  id: z.uuid(),
  status: z.enum(["published", "archived"]),
});
