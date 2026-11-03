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
  /**
   * Bounded typed server-owned context hints (plan §28). These ride the
   * request only and are never persisted server-side: an explicit mention
   * in the current message always wins over these values, and language
   * never determines region. Dietary data stays per-request.
   */
  dietary: z.string().trim().min(1).max(80).optional(),
  exclusions: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  budget: z.enum(["budget", "mid", "splurge"]).optional(),
  cuisine: z.string().trim().min(1).max(80).optional(),
  meal: z.string().trim().min(1).max(40).optional(),
  nearby: z.boolean().optional(),
});

export type CopilotContext = z.infer<typeof copilotContextSchema>;

export const copilotChatInputSchema = z.strictObject({
  message: z.string().trim().min(1, "message is required").max(2000),
  task: copilotTaskSchema.optional(),
  context: copilotContextSchema.optional(),
  /**
   * Bounded recent conversation context for follow-up interpretation only.
   * Chronological, at most 6 turns, each at most 2000 characters. History
   * is never trusted as fact: canonical dish/venue/scan ids re-resolve
   * server-side with current authorization on every call.
   */
  history: z
    .array(
      z.strictObject({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(2000),
      }),
    )
    .max(6)
    .optional(),
});

export type CopilotChatInput = z.infer<typeof copilotChatInputSchema>;

export type CopilotHistoryTurn = NonNullable<CopilotChatInput["history"]>[number];

const cardRefSchema = z.union([z.string().regex(DB_ID_PATTERN), z.uuid()]);

/**
 * Evidence tiers (plan §14): verified first-party facts, general culinary
 * knowledge, unverified external findings, and personalized inference stay
 * distinct in the contract and in presentation. The `synthesized` flag
 * still marks exactly one thing: prose rewritten by a validated bounded
 * model call (members only).
 */
export const evidenceTierSchema = z.enum(["catalog", "general", "web", "inference"]);

export type EvidenceTier = z.infer<typeof evidenceTierSchema>;

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
  provenance: evidenceTierSchema.default("catalog"),
});

export type CopilotCard = z.infer<typeof copilotCardSchema>;

/**
 * Typed suggested action (plan §§15-17): every non-question affordance the
 * assistant offers travels as a tagged kind with validated params — never
 * as a chat-text label the client regex-sniffs. `label` is the visible
 * caption in the reply language; dispatch keys off `kind` only. Question
 * suggestions stay in `followUps`; everything that navigates, opens a
 * tool, or changes scope lives here.
 */
export const copilotActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ask"),
    label: z.string().trim().min(1).max(200),
    question: z.string().trim().min(1).max(2000),
  }),
  z.strictObject({
    kind: z.literal("browseDishes"),
    label: z.string().trim().min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal("findRestaurants"),
    label: z.string().trim().min(1).max(200),
    dishId: z.string().regex(DB_ID_PATTERN, "dishId must be a canonical dish id").optional(),
  }),
  z.strictObject({
    kind: z.literal("openOrder"),
    label: z.string().trim().min(1).max(200),
    venueId: z.uuid().optional(),
    scanId: z.uuid().optional(),
  }),
  z.strictObject({
    kind: z.literal("resumeScan"),
    label: z.string().trim().min(1).max(200),
    scanId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal("openTool"),
    label: z.string().trim().min(1).max(200),
    tool: z.enum(["camera", "gallery", "location", "scanner", "order"]),
  }),
]);

export type CopilotAction = z.infer<typeof copilotActionSchema>;

export const copilotChatOutputSchema = z.strictObject({
  reply: z.string().trim().min(1).max(4000),
  cards: z.array(copilotCardSchema).max(12).default([]),
  followUps: z.array(z.string().trim().min(1).max(200)).max(5).default([]),
  /**
   * Typed non-question affordances (plan §§15-17). Rendered as action
   * chips dispatched by kind; never sent as chat text. At most 3 so the
   * thread stays compact — one or two relevant next steps, not a wall.
   */
  actions: z.array(copilotActionSchema).max(4).default([]),
  /**
   * Honest provenance for the reply prose. False means deterministic
   * catalog assembly (never model-generated); true only after a validated
   * bounded synthesis call. Guests always receive false.
   */
  synthesized: z.boolean().default(false),
  /**
   * Which evidence tiers the reply draws on, in encounter order. Lets the
   * UI caption verified catalog facts separately from general culinary
   * knowledge, unverified web findings, and personalized inference.
   */
  evidenceTiers: z.array(evidenceTierSchema).max(4).default([]),
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

/**
 * Validated Muse↔scanner handoff. The scanner return link carries only this
 * opaque owned scan id plus public scope (task/language) — never ownership
 * secrets. The scan id re-authorizes server-side through the owned scan
 * operations on every copilot call, preserving privacy and expiry semantics.
 */
export const copilotScanReturnSchema = z.strictObject({
  scanId: z.uuid(),
  task: copilotTaskSchema.optional(),
  language: z.string().regex(LANGUAGE_PATTERN, "language must be a BCP-47 tag").optional(),
});

export type CopilotScanReturn = z.infer<typeof copilotScanReturnSchema>;

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
  /**
   * Machine-readable outcome so clients never regex-sniff note text.
   * Optional for forward compatibility; absent means derive from notes.
   */
  status: z
    .enum(["identified", "no-candidate", "unreadable", "auth-required", "disabled", "unavailable"])
    .optional(),
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
  /**
   * Canonical dish id for dish-anchored venue search: resolves real
   * serving evidence (eligible menu observations for this dish in the
   * area) instead of matching the dish name against venue names. Dish
   * matches must never cancel the venue search.
   */
  dishId: z.string().regex(DB_ID_PATTERN, "dishId must be a canonical dish id").optional(),
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

/**
 * Canonical geo-mention resolution. A raw mention ("HCMC", "Saigon",
 * "Ho Chi Minh City") resolves through the place registry first
 * (preferred names and aliases), then against the canonical published
 * venue-area list with a generic initialism fallback — never through a
 * hardcoded one-off map, and never invented when unresolvable.
 */
export const geoResolveToolSchema = z.strictObject({
  q: z.string().trim().min(1).max(120),
});

export type GeoResolveToolInput = z.infer<typeof geoResolveToolSchema>;

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
