import { z } from "zod";

import { isAmount, isCurrency } from "@/shared/money";

/**
 * Muse copilot HTTP boundary schemas. Every external input to the copilot
 * server functions validates here; tool arguments re-validate at the service
 * boundary before any existing operation runs. Outputs are validated before
 * leaving the server so peers can rely on the contract shapes.
 */

const DB_ID_PATTERN = /^[1-9][0-9]{0,18}$/;

const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z]{2,8})?$/;

const HTTPS_PATTERN = /^https?:\/\//;

export const copilotTaskSchema = z.enum(["scan", "plate", "find", "ask", "order"]);

export type CopilotTask = z.infer<typeof copilotTaskSchema>;

export const copilotContextSchema = z.strictObject({
  city: z.string().trim().min(1).max(120).optional(),
  country: z.string().trim().min(1).max(120).optional(),
  dishId: z.string().regex(DB_ID_PATTERN, "dishId must be a canonical dish id").optional(),
  venueId: z.uuid().optional(),
  scanId: z.uuid().optional(),
  language: z.string().regex(LANGUAGE_PATTERN, "language must be a BCP-47 tag").optional(),
});

export type CopilotContext = z.infer<typeof copilotContextSchema>;

export const copilotChatInputSchema = z.strictObject({
  message: z.string().trim().min(1, "message is required").max(2000),
  task: copilotTaskSchema.optional(),
  context: copilotContextSchema.optional(),
});

export type CopilotChatInput = z.infer<typeof copilotChatInputSchema>;

const cardRefSchema = z.union([z.string().regex(DB_ID_PATTERN), z.uuid()]);

export const copilotCardSchema = z.strictObject({
  kind: z.enum(["dish", "restaurant", "price", "source"]),
  refId: cardRefSchema.optional(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(1000).optional(),
  url: z
    .string()
    .max(2000)
    .refine((value) => HTTPS_PATTERN.test(value), "Only verified http(s) citations")
    .optional(),
});

export type CopilotCard = z.infer<typeof copilotCardSchema>;

export const copilotChatOutputSchema = z.strictObject({
  reply: z.string().trim().min(1).max(4000),
  cards: z.array(copilotCardSchema).max(12).default([]),
  followUps: z.array(z.string().trim().min(1).max(200)).max(5).default([]),
});

export type CopilotChatOutput = z.infer<typeof copilotChatOutputSchema>;

/**
 * Food-photo identification input. The caller passes the owned scan (and
 * optionally one of its photo assets); the server resolves the photo bytes
 * through the owned scan operations, so browsers never handle object-store
 * keys and scan ownership is re-verified on every call.
 */
export const copilotIdentifyPhotoInputSchema = z.strictObject({
  scanId: z.uuid(),
  assetId: z.uuid().optional(),
  language: z.string().regex(LANGUAGE_PATTERN, "language must be a BCP-47 tag").optional(),
});

export type CopilotIdentifyPhotoInput = z.infer<typeof copilotIdentifyPhotoInputSchema>;

export const copilotCandidateSchema = z.strictObject({
  dishId: z.string().regex(DB_ID_PATTERN, "dishId must be a canonical dish id").optional(),
  name: z.string().trim().min(1).max(200),
  confidence: z.enum(["likely", "possible", "tentative"]),
  visualEvidence: z.string().trim().min(1).max(500),
});

export type CopilotCandidate = z.infer<typeof copilotCandidateSchema>;

export const copilotIdentifyPhotoOutputSchema = z.strictObject({
  candidates: z.array(copilotCandidateSchema).max(6).default([]),
  unmatchedNote: z.string().trim().min(1).max(1000).optional(),
});

export type CopilotIdentifyPhotoOutput = z.infer<typeof copilotIdentifyPhotoOutputSchema>;

const draftItemSchema = z.strictObject({
  itemKey: z.uuid(),
  variantKey: z.uuid().optional(),
  qty: z.number().int().min(1).max(20),
});

export const copilotDraftOrderInputSchema = z
  .strictObject({
    venueId: z.uuid().optional(),
    scanId: z.uuid().optional(),
    items: z.array(draftItemSchema).min(1).max(20),
    instructions: z.string().trim().min(1).max(1000).optional(),
  })
  .superRefine((data, context) => {
    if (data.venueId === undefined && data.scanId === undefined) {
      context.addIssue({ code: "custom", message: "A venue or a private scan is required" });
    }
  });

export type CopilotDraftOrderInput = z.infer<typeof copilotDraftOrderInputSchema>;

const minorAmountSchema = z
  .string()
  .refine(isAmount, "Minor amounts stay exact decimal strings")
  .nullable();

export const copilotDraftOrderLineSchema = z.strictObject({
  itemKey: z.uuid(),
  variantKey: z.uuid().optional(),
  name: z.string().trim().min(1).max(300),
  qty: z.number().int().min(1).max(20),
  unitMinor: minorAmountSchema,
  lineMinor: minorAmountSchema,
});

export type CopilotDraftOrderLine = z.infer<typeof copilotDraftOrderLineSchema>;

export const copilotDraftOrderOutputSchema = z.strictObject({
  lines: z.array(copilotDraftOrderLineSchema).max(20),
  subtotalMinor: minorAmountSchema,
  currency: z
    .string()
    .max(8)
    .refine((value) => value === "" || isCurrency(value), "Unknown currency"),
  incomplete: z.boolean(),
  warnings: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
});

export type CopilotDraftOrderOutput = z.infer<typeof copilotDraftOrderOutputSchema>;

/** Narrow tool arguments: Zod re-validated inside the service before dispatch. */

export const dishSearchToolSchema = z.strictObject({
  q: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(10).default(5),
});

export type DishSearchToolInput = z.infer<typeof dishSearchToolSchema>;

export const dishDetailToolSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
});

export type DishDetailToolInput = z.infer<typeof dishDetailToolSchema>;

export const venueSearchToolSchema = z.strictObject({
  q: z.string().trim().max(100).default(""),
  area: z.string().trim().max(200).default(""),
  limit: z.number().int().min(1).max(10).default(5),
});

export type VenueSearchToolInput = z.infer<typeof venueSearchToolSchema>;

export const venueDetailToolSchema = z.strictObject({
  venueId: z.uuid(),
});

export type VenueDetailToolInput = z.infer<typeof venueDetailToolSchema>;

export const scanMenuToolSchema = z.strictObject({
  scanId: z.uuid(),
});

export type ScanMenuToolInput = z.infer<typeof scanMenuToolSchema>;

export const researchToolSchema = z.strictObject({
  city: z.string().trim().min(1).max(120),
  country: z.string().trim().min(1).max(120),
  dish: z.string().trim().min(1).max(200).optional(),
  language: z.string().regex(LANGUAGE_PATTERN, "language must be a BCP-47 tag").optional(),
});

export type ResearchToolInput = z.infer<typeof researchToolSchema>;

/**
 * Deterministic price comparison over reviewed menus. Dish identity,
 * portion, sales channel, and geographic scope ride in the input so the
 * underlying query stays comparable; the tool never invents averages and
 * never treats one listing as a market (ranges need three venues).
 */
export const priceCompareToolSchema = z.strictObject({
  dishId: z.string().regex(DB_ID_PATTERN, "dishId must be a canonical dish id"),
  area: z.string().trim().min(1).max(200),
  portion: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,79}$/, "portion must be a comparable portion key")
    .optional(),
  channel: z.enum(["dine_in", "takeaway", "delivery"]).default("dine_in"),
  limit: z.number().int().min(1).max(10).default(5),
});

export type PriceCompareToolInput = z.infer<typeof priceCompareToolSchema>;
