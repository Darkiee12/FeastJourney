import { z } from "zod";

import {
  associationNoteSchema,
  currencyProvenanceSchema,
  isMenuCityId,
  priceAssociationSchema,
} from "@/modules/restaurant-discovery/menu-price-evidence";
import {
  amountSchema,
  currencySchema,
  channelSchema,
} from "@/modules/restaurant-discovery/restaurant.schema";

export const menuLanguages = ["en", "vi", "ja", "zh", "ko", "fr", "es"] as const;
export const menuLanguageSchema = z.enum(menuLanguages);

const menuText = z.string().refine((value) => !value.includes("\u0000") && value.isWellFormed(), {
  message: "Menu text must contain valid Unicode without null characters.",
});

const text = menuText.trim().min(1).max(300);
const description = menuText.trim().min(1).max(3000).nullable();

/**
 * Additive V3 price evidence (§4): rawText stays verbatim OCR, amount stays a
 * canonical decimal string, and the three optional fields record currency
 * provenance, item/variant association, and a short association note.
 * Optional keeps schemaVersion at 1 and old records parsing: absent
 * provenance reads as unknown and absent association as clear (see
 * provenanceOf/associationOf), so stored revisions are never reinterpreted
 * and customerAdded/repair semantics are untouched.
 */
export const scanPriceSchema = z.strictObject({
  rawText: menuText.max(200),
  amount: amountSchema.nullable(),
  currency: currencySchema.nullable(),
  currencyProvenance: currencyProvenanceSchema.optional(),
  association: priceAssociationSchema.optional(),
  associationNote: associationNoteSchema.nullable().optional(),
  taxTreatment: z.enum(["included", "excluded", "unknown"]),
});

const extractedVariant = z.strictObject({
  originalLabel: menuText.max(200),
  translatedLabel: text.nullable(),
  price: scanPriceSchema.nullable(),
});

const extractedItem = z.strictObject({
  originalName: text,
  translatedName: text.nullable(),
  originalDescription: description,
  translatedDescription: description,
  explanatorySummary: description,
  ingredients: z
    .array(
      z.strictObject({
        originalText: text,
        translatedText: text.nullable(),
        evidence: z.enum(["printed", "inferred"]),
      }),
    )
    .max(40)
    .nullable(),
  variants: z.array(extractedVariant).min(1).max(20),
  sourceReferences: z
    .array(
      z.strictObject({
        assetId: z.uuid(),
        // Full-page references until coordinate accuracy is demonstrated by a live benchmark.
        region: z.null(),
      }),
    )
    .min(1)
    .max(6),
  uncertainties: z.array(menuText.min(1).max(500)).max(20),
});

/** AI trust boundary; the provider never supplies application identities. */
export const menuExtractionSchema = z.strictObject({
  sourceLanguage: menuLanguageSchema.nullable(),
  menuTitle: text.nullable(),
  orderIntroduction: z.strictObject({ original: text.nullable(), translated: text.nullable() }),
  items: z.array(extractedItem).max(100),
});

export type MenuExtraction = z.infer<typeof menuExtractionSchema>;

/**
 * Provider-facing strict variant of the extraction contract (Meta
 * `strict: true` structured output). Zod `.optional()` fields are absent
 * from the generated `required` array, which strict mode rejects; this
 * variant redeclares the same leaf constraints with every property
 * required (nullable where null is legal), derived from the persisted
 * shapes above rather than duplicated. The three V3 price-evidence fields
 * that caused the HTTP 400 — `currencyProvenance`, `association`, and
 * `associationNote` (required but nullable) — are required here while
 * staying optional in the persisted schema so historical documents without
 * them keep decoding. Use only for constructing the provider
 * `response_format` and validating provider output; never for storage.
 */
const strictPriceSchema = z.strictObject({
  ...scanPriceSchema.shape,
  currencyProvenance: currencyProvenanceSchema,
  association: priceAssociationSchema,
  associationNote: associationNoteSchema.nullable(),
});

const strictVariantSchema = z.strictObject({
  ...extractedVariant.shape,
  price: strictPriceSchema.nullable(),
});

const strictItemSchema = z.strictObject({
  ...extractedItem.shape,
  variants: z.array(strictVariantSchema).min(1).max(20),
});

export const menuExtractionStrictSchema = z.strictObject({
  ...menuExtractionSchema.shape,
  items: z.array(strictItemSchema).max(100),
});

export type StrictMenuExtraction = z.infer<typeof menuExtractionStrictSchema>;

export const menuScanDocumentSchema = menuExtractionSchema.extend({
  schemaVersion: z.literal(1),
  targetLanguage: menuLanguageSchema,
  pages: z
    .array(
      z.strictObject({
        assetId: z.uuid(),
        pageNumber: z.number().int().min(1).max(6),
      }),
    )
    .min(1)
    .max(6),
  items: z
    .array(
      extractedItem.extend({
        id: z.uuid(),
        // Customer repair marker: model output never carries this flag, so any
        // item or variant bearing it was added by the customer, not extracted.
        customerAdded: z.boolean().optional(),
        variants: z
          .array(extractedVariant.extend({ id: z.uuid(), customerAdded: z.boolean().optional() }))
          .min(1)
          .max(20),
      }),
    )
    .max(100),
});

export type MenuScanDocument = z.infer<typeof menuScanDocumentSchema>;

/**
 * Visitor-indicated menu location id. Grammar (see isMenuCityId): curated
 * preset ids ("hcmc" | "hanoi" | "bangalore"), "geo:<name>" nearest-city
 * names, and "place:<decimalId>" canonical registry identities. Anything
 * else is rejected at this boundary. Max length stays 80.
 */
export const menuCityIdSchema = z.string().trim().min(1).max(80).refine(isMenuCityId, {
  message: "Choose a supported menu location.",
});

export const createScanSchema = z.strictObject({
  targetLanguage: menuLanguageSchema,
  venueId: z.uuid().nullable(),
});

export const scanIdSchema = z.strictObject({ scanId: z.uuid() });

export const reviseScanSchema = scanIdSchema.extend({
  expectedRevision: z.number().int().min(1),
  document: menuScanDocumentSchema,
});

export const contributeScanSchema = scanIdSchema.extend({
  revision: z.number().int().min(1),
  consent: z.literal(true),
  termsVersion: z.literal("menu-facts-v1"),
  venueId: z.uuid().nullable(),
});

export const scanReviewSchema = z.strictObject({
  contributionId: z.uuid(),
  decision: z.enum(["approved", "rejected"]),
  channel: channelSchema.nullable(),
  rightsReviewed: z.boolean(),
  venueId: z.uuid().nullable(),
  observedAt: z.iso.datetime({ offset: true }),
  validUntil: z.iso.datetime({ offset: true }),
  notes: menuText.trim().min(1).max(2000),
  // Review is selective: accepting a submission never approves every extracted price.
  itemIds: z.array(z.uuid()).max(100),
  pricedVariantIds: z.array(z.uuid()).max(200),
});
