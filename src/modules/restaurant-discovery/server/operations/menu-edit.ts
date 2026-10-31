import { Config, Data, Effect } from "effect";
import * as BigDecimal from "effect/BigDecimal";
import { z } from "zod";

import { DishService, getPublishedDishIdentities } from "@/modules/food-discovery/server/index";
import {
  amountSchema,
  channelSchema,
  currencySchema,
} from "@/modules/restaurant-discovery/restaurant.schema";
import draftsQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-drafts.sql";
import insertEvidenceQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-evidence-insert.sql";
import archiveItemQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-item-archive.sql";
import insertItemQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-item-insert.sql";
import itemVariantsQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-item-variants.sql";
import itemQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-item.sql";
import menuCheckQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-menu-check.sql";
import insertMenuQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-menu-insert.sql";
import insertPriceQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-price-insert.sql";
import insertReceiptQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-receipt-insert.sql";
import sectionsQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-sections.sql";
import insertSourceQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-source-insert.sql";
import archiveVariantQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-variant-archive.sql";
import insertVariantQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-variant-insert.sql";
import variantQuery from "@/modules/restaurant-discovery/server/repository/sql/menu-edit-variant.sql";
import { Authorization, recordAuditEvent } from "@/modules/user/server/index";
import { Actor } from "@/server/auth/actor";
import { CurrentActor } from "@/server/auth/current-actor";
import { withTransaction } from "@/server/database/client";
import { runQuery } from "@/server/database/query";

export class MenuEditInputError extends Data.TaggedError("MenuEditInputError")<{
  readonly reason: string;
}> {}

export class MenuEditNotFound extends Data.TaggedError("MenuEditNotFound")<{
  readonly resource: string;
}> {}

export class MenuEditUnpublished extends Data.TaggedError("MenuEditUnpublished")<{
  readonly dishId: string;
}> {}

export class MenuEditIncomplete extends Data.TaggedError("MenuEditIncomplete")<{
  readonly reasons: ReadonlyArray<string>;
}> {}

export type MenuDraftRow = (typeof draftsQuery)["~reylo"]["element"];

export type MenuSectionRow = (typeof sectionsQuery)["~reylo"]["element"];

const menuLanguageSchema = z.enum(["en", "vi", "ja", "zh", "ko", "fr", "es"]);

const sectionKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

const dishIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);

const failInput = (issues: ReadonlyArray<{ readonly message: string }>) =>
  new MenuEditInputError({ reason: issues.map((issue) => issue.message).join("; ") });

/**
 * Explicit paid prices and unambiguous net food totals only; discounts never
 * become listed prices. Same rule as the import path's receipt check, kept
 * local so the editor never depends on that module's implementation file.
 */
const isReceiptConsistent = (price: {
  readonly amount: string;
  readonly kind: "listed" | "paid_unit";
  readonly receipt?:
    | {
        readonly quantity: string;
        readonly explicitUnitPrice?: string | undefined;
        readonly lineTotal: string;
        readonly totalSemantics: "net_food_only" | "includes_fees" | "unknown";
      }
    | undefined;
}): boolean => {
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
};

const authorizeManage = Effect.gen(function* () {
  const actor = yield* CurrentActor;
  const authorization = yield* Authorization;
  yield* authorization.require(actor, { resource: "restaurant", actions: ["manage"] });

  return Actor.$match(actor, {
    Guest: () => Effect.fail(new MenuEditInputError({ reason: "A verified member is required" })),
    Member: ({ userId }) => Effect.succeed(userId),
  });
}).pipe(Effect.flatten);

const reviewAfterFor = (observedAt: string) =>
  Effect.gen(function* () {
    const days = yield* Config.Int("RESTAURANT_REVIEW_DAYS").pipe(Config.withDefault(90));

    if (days < 1 || days > 365) {
      return yield* new MenuEditInputError({
        reason: "Restaurant review horizon must be 1–365 days",
      });
    }

    return new Date(Date.parse(observedAt) + days * 86400000).toISOString();
  });

const sourceInputSchema = z
  .object({
    category: z.enum(["official_menu", "menu_photo", "receipt", "authorized_provider"]),
    url: z
      .url()
      .max(2000)
      .refine((url) => /^https?:\/\//.test(url))
      .optional(),
    privateObjectKey: z.string().min(1).max(500).optional(),
    deduplicationKey: z.string().min(1).max(200),
    observedAt: z.iso.datetime({ offset: true }),
    validUntil: z.iso.datetime({ offset: true }),
  })
  .superRefine((data, context) => {
    if (data.url === undefined && data.privateObjectKey === undefined) {
      context.addIssue({ code: "custom", message: "A source URL or private object is required" });
    }

    if (
      data.category === "receipt" &&
      (data.url !== undefined || data.privateObjectKey === undefined)
    ) {
      context.addIssue({ code: "custom", message: "Receipt originals must be private" });
    }

    if (
      Date.parse(data.validUntil) <= Date.parse(data.observedAt) ||
      Date.parse(data.observedAt) > Date.now()
    ) {
      context.addIssue({ code: "custom", message: "Invalid source observation/review dates" });
    }
  });

const translationInputSchema = z.object({
  language: menuLanguageSchema,
  name: z.string().min(1).max(300).nullable(),
  description: z.string().min(1).max(3000).nullable(),
  explanation: z.string().min(1).max(3000).nullable(),
});

const createMenuSchema = z.object({
  venueId: z.uuid(),
  menuId: z.uuid().optional(),
  name: z.string().trim().min(1).max(300),
  sourceLanguage: menuLanguageSchema.nullable().optional(),
});

export const createMenu = Effect.fn("restaurants.menuEdit.createMenu")(function* (
  input: z.infer<typeof createMenuSchema>,
) {
  const parsed = createMenuSchema.safeParse(input);

  if (!parsed.success) return yield* failInput(parsed.error.issues);
  const actorId = yield* authorizeManage;

  return yield* withTransaction(
    "restaurants/menu-edit-create",
    Effect.gen(function* () {
      const menu = yield* runQuery("restaurants/menu-edit-menu-insert", (sql) =>
        insertMenuQuery.run(sql, {
          id: parsed.data.menuId ?? crypto.randomUUID(),
          venue: parsed.data.venueId,
          name: parsed.data.name,
          source_language: parsed.data.sourceLanguage ?? null,
        }),
      );

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.menu.created",
        outcome: "succeeded",
        resource: menu.id,
      });

      return { menuId: menu.id };
    }),
  );
});

const saveItemSchema = z.object({
  venueId: z.uuid(),
  menuId: z.uuid(),
  itemId: z.uuid().optional(),
  name: z.string().trim().min(1).max(300),
  description: z.string().max(3000).default(""),
  sectionKey: sectionKeySchema.optional(),
  translation: translationInputSchema.optional(),
  sourceId: z.uuid().nullable().optional(),
});

export const saveItemDraft = Effect.fn("restaurants.menuEdit.saveItem")(function* (
  input: z.infer<typeof saveItemSchema>,
) {
  const parsed = saveItemSchema.safeParse(input);

  if (!parsed.success) return yield* failInput(parsed.error.issues);
  const actorId = yield* authorizeManage;

  return yield* withTransaction(
    "restaurants/menu-edit-item",
    Effect.gen(function* () {
      const menu = yield* runQuery("restaurants/menu-edit-menu-check", (sql) =>
        menuCheckQuery.run(sql, { menu: parsed.data.menuId, venue: parsed.data.venueId }),
      );

      if (menu === null) return yield* new MenuEditNotFound({ resource: "menu" });

      const item = yield* runQuery("restaurants/menu-edit-item-insert", (sql) =>
        insertItemQuery.run(sql, {
          id: parsed.data.itemId ?? crypto.randomUUID(),
          venue: parsed.data.venueId,
          menu: parsed.data.menuId,
          name: parsed.data.name,
          description: parsed.data.description,
          section: parsed.data.sectionKey ?? null,
          translation_language: parsed.data.translation?.language ?? null,
          translated_name: parsed.data.translation?.name ?? null,
          translated_description: parsed.data.translation?.description ?? null,
          explanation: parsed.data.translation?.explanation ?? null,
          source: parsed.data.sourceId ?? null,
        }),
      );

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.menu.item.saved",
        outcome: "succeeded",
        resource: item.id,
      });

      return { itemId: item.id };
    }),
  );
});

const reviseItemSchema = saveItemSchema.extend({ supersededItemId: z.uuid() });

export const reviseItemDraft = Effect.fn("restaurants.menuEdit.reviseItem")(function* (
  input: z.infer<typeof reviseItemSchema>,
) {
  const parsed = reviseItemSchema.safeParse(input);

  if (!parsed.success) return yield* failInput(parsed.error.issues);
  const actorId = yield* authorizeManage;

  return yield* withTransaction(
    "restaurants/menu-edit-revise-item",
    Effect.gen(function* () {
      // Revisions are new rows: the identity trigger rejects in-place edits,
      // so a changed name, section or reviewed text never overwrites the
      // superseded draft. Draft portion labels travel with the revision;
      // price and serving observations stay pinned to the archived rows and
      // are never silently moved or duplicated.
      const current = yield* runQuery("restaurants/menu-edit-item", (sql) =>
        itemQuery.run(sql, { id: parsed.data.supersededItemId, venue: parsed.data.venueId }),
      );

      if (current === null || current.status !== "draft") {
        return yield* new MenuEditNotFound({ resource: "superseded item" });
      }

      if (current.menu_id !== parsed.data.menuId) {
        return yield* new MenuEditNotFound({ resource: "menu" });
      }

      const currentVariants = yield* runQuery("restaurants/menu-edit-item-variants", (sql) =>
        itemVariantsQuery.run(sql, {
          item: parsed.data.supersededItemId,
          venue: parsed.data.venueId,
        }),
      );

      const item = yield* runQuery("restaurants/menu-edit-item-insert", (sql) =>
        insertItemQuery.run(sql, {
          id: parsed.data.itemId ?? crypto.randomUUID(),
          venue: parsed.data.venueId,
          menu: current.menu_id,
          name: parsed.data.name,
          description: parsed.data.description,
          section: parsed.data.sectionKey ?? null,
          translation_language: parsed.data.translation?.language ?? null,
          translated_name: parsed.data.translation?.name ?? null,
          translated_description: parsed.data.translation?.description ?? null,
          explanation: parsed.data.translation?.explanation ?? null,
          source: parsed.data.sourceId ?? null,
        }),
      );

      for (const variant of currentVariants) {
        yield* runQuery("restaurants/menu-edit-variant-insert", (sql) =>
          insertVariantQuery.run(sql, {
            id: crypto.randomUUID(),
            venue: parsed.data.venueId,
            item: item.id,
            name: variant.name,
            comparison: variant.comparison_key,
            translation_language: variant.translation_language,
            translated_label: variant.translated_label,
          }),
        );
        yield* runQuery("restaurants/menu-edit-variant-archive", (sql) =>
          archiveVariantQuery.run(sql, { id: variant.id, venue: parsed.data.venueId }),
        );
      }

      const archived = yield* runQuery("restaurants/menu-edit-item-archive", (sql) =>
        archiveItemQuery.run(sql, { id: parsed.data.supersededItemId, venue: parsed.data.venueId }),
      );

      if (archived === null) return yield* new MenuEditNotFound({ resource: "superseded item" });
      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.menu.item.revised",
        outcome: "succeeded",
        resource: item.id,
      });

      return { itemId: item.id, archivedItemId: archived.id };
    }),
  );
});

const addVariantSchema = z.object({
  venueId: z.uuid(),
  itemId: z.uuid(),
  variantId: z.uuid().optional(),
  name: z.string().trim().min(1).max(200).default("As listed"),
  comparisonKey: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,79}$/)
    .optional(),
  translation: z
    .object({ language: menuLanguageSchema, label: z.string().min(1).max(300).nullable() })
    .optional(),
});

export const addVariantDraft = Effect.fn("restaurants.menuEdit.addVariant")(function* (
  input: z.infer<typeof addVariantSchema>,
) {
  const parsed = addVariantSchema.safeParse(input);

  if (!parsed.success) return yield* failInput(parsed.error.issues);
  const actorId = yield* authorizeManage;

  return yield* withTransaction(
    "restaurants/menu-edit-variant",
    Effect.gen(function* () {
      const target = yield* runQuery("restaurants/menu-edit-variant-target", (sql) =>
        itemQuery.run(sql, { id: parsed.data.itemId, venue: parsed.data.venueId }),
      );

      if (target === null) return yield* new MenuEditNotFound({ resource: "item" });

      const variant = yield* runQuery("restaurants/menu-edit-variant-insert", (sql) =>
        insertVariantQuery.run(sql, {
          id: parsed.data.variantId ?? crypto.randomUUID(),
          venue: parsed.data.venueId,
          item: parsed.data.itemId,
          name: parsed.data.name,
          comparison: parsed.data.comparisonKey ?? null,
          translation_language: parsed.data.translation?.language ?? null,
          translated_label: parsed.data.translation?.label ?? null,
        }),
      );

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.menu.variant.saved",
        outcome: "succeeded",
        resource: variant.id,
      });

      return { variantId: variant.id };
    }),
  );
});

const reviseVariantSchema = addVariantSchema.extend({ supersededVariantId: z.uuid() });

export const reviseVariantDraft = Effect.fn("restaurants.menuEdit.reviseVariant")(function* (
  input: z.infer<typeof reviseVariantSchema>,
) {
  const parsed = reviseVariantSchema.safeParse(input);

  if (!parsed.success) return yield* failInput(parsed.error.issues);
  const actorId = yield* authorizeManage;

  return yield* withTransaction(
    "restaurants/menu-edit-revise-variant",
    Effect.gen(function* () {
      const variant = yield* runQuery("restaurants/menu-edit-variant-insert", (sql) =>
        insertVariantQuery.run(sql, {
          id: parsed.data.variantId ?? crypto.randomUUID(),
          venue: parsed.data.venueId,
          item: parsed.data.itemId,
          name: parsed.data.name,
          comparison: parsed.data.comparisonKey ?? null,
          translation_language: parsed.data.translation?.language ?? null,
          translated_label: parsed.data.translation?.label ?? null,
        }),
      );

      const archived = yield* runQuery("restaurants/menu-edit-variant-archive", (sql) =>
        archiveVariantQuery.run(sql, {
          id: parsed.data.supersededVariantId,
          venue: parsed.data.venueId,
        }),
      );

      if (archived === null || archived.menu_item_id !== parsed.data.itemId) {
        return yield* new MenuEditNotFound({ resource: "superseded variant" });
      }

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.menu.variant.revised",
        outcome: "succeeded",
        resource: variant.id,
      });

      return { variantId: variant.id, archivedVariantId: archived.id };
    }),
  );
});

const createSourceSchema = z.object({ venueId: z.uuid(), source: sourceInputSchema });

export const createSource = Effect.fn("restaurants.menuEdit.createSource")(function* (
  input: z.infer<typeof createSourceSchema>,
) {
  const parsed = createSourceSchema.safeParse(input);

  if (!parsed.success) return yield* failInput(parsed.error.issues);
  const actorId = yield* authorizeManage;

  return yield* withTransaction(
    "restaurants/menu-edit-source",
    Effect.gen(function* () {
      const source = yield* runQuery("restaurants/menu-edit-source-insert", (sql) =>
        insertSourceQuery.run(sql, {
          venue: parsed.data.venueId,
          category: parsed.data.source.category,
          url: parsed.data.source.url ?? null,
          object_key: parsed.data.source.privateObjectKey ?? null,
          deduplication: parsed.data.source.deduplicationKey,
          verified: false,
          observed: parsed.data.source.observedAt,
          until: parsed.data.source.validUntil,
          actor: actorId,
        }),
      );

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.menu.source.created",
        outcome: "succeeded",
        resource: source.id,
      });

      return { sourceId: source.id };
    }),
  );
});

const receiptInputSchema = z.object({
  quantity: amountSchema.refine((value) => /[1-9]/.test(value), "Quantity must be positive"),
  explicitUnitPrice: amountSchema.optional(),
  lineTotal: amountSchema,
  discount: amountSchema.nullable(),
  taxesFees: amountSchema.nullable(),
  totalSemantics: z.enum(["net_food_only", "includes_fees", "unknown"]),
});

const appendPriceSchema = z.object({
  venueId: z.uuid(),
  variantId: z.uuid(),
  sourceId: z.uuid(),
  sourceLineKey: z.string().min(1).max(100),
  kind: z.enum(["listed", "paid_unit"]),
  amount: amountSchema,
  rawText: z.string().max(200).optional(),
  currency: currencySchema,
  channel: channelSchema,
  taxTreatment: z.enum(["included", "excluded", "unknown"]),
  receipt: receiptInputSchema.optional(),
  observedAt: z.iso.datetime({ offset: true }),
});

export const appendPrice = Effect.fn("restaurants.menuEdit.appendPrice")(function* (
  input: z.infer<typeof appendPriceSchema>,
) {
  const parsed = appendPriceSchema.safeParse(input);

  if (!parsed.success) return yield* failInput(parsed.error.issues);
  const price = parsed.data;

  if (price.receipt === undefined && price.kind !== "listed") {
    return yield* new MenuEditInputError({
      reason: "Listed observations carry no receipt evidence",
    });
  }

  if (price.receipt !== undefined && price.kind !== "paid_unit") {
    return yield* new MenuEditInputError({
      reason: "Receipt evidence requires a paid-unit observation",
    });
  }

  if (price.receipt !== undefined && !isReceiptConsistent(price)) {
    return yield* new MenuEditInputError({
      reason: "Paid unit amount does not match unambiguous receipt evidence",
    });
  }

  const actorId = yield* authorizeManage;

  return yield* withTransaction(
    "restaurants/menu-edit-price",
    Effect.gen(function* () {
      // Append-only: observations are never updated in place, so the exact
      // decimal string, original currency, channel, tax treatment and
      // observation date stay preserved. Unknown stays absent, never zero.
      const target = yield* runQuery("restaurants/menu-edit-price-target", (sql) =>
        variantQuery.run(sql, { id: price.variantId, venue: price.venueId }),
      );

      if (target === null) return yield* new MenuEditNotFound({ resource: "variant" });

      const until = yield* reviewAfterFor(price.observedAt);

      const observation = yield* runQuery("restaurants/menu-edit-price-insert", (sql) =>
        insertPriceQuery.run(sql, {
          venue: price.venueId,
          variant: price.variantId,
          source: price.sourceId,
          line: price.sourceLineKey,
          kind: price.kind,
          amount: price.amount,
          currency: price.currency,
          channel: price.channel,
          tax: price.taxTreatment,
          observed: price.observedAt,
          until,
          raw_text: price.rawText ?? null,
        }),
      );

      if (observation === null) {
        return yield* new MenuEditInputError({ reason: "Price observation was rejected" });
      }

      const receipt = price.receipt;

      if (receipt !== undefined) {
        yield* runQuery("restaurants/menu-edit-receipt-insert", (sql) =>
          insertReceiptQuery.run(sql, {
            observation: observation.id,
            quantity: receipt.quantity,
            unit: receipt.explicitUnitPrice ?? null,
            total: receipt.lineTotal,
            discount: receipt.discount ?? null,
            fees: receipt.taxesFees ?? null,
            semantics: receipt.totalSemantics,
          }),
        );
      }

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.menu.price.appended",
        outcome: "succeeded",
        resource: observation.id,
      });

      return { observationId: observation.id };
    }),
  );
});

const linkDishSchema = z.object({
  venueId: z.uuid(),
  itemId: z.uuid(),
  sourceId: z.uuid(),
  dishId: dishIdSchema,
  matchKind: z.enum(["exact", "variant"]),
  locale: z.string().min(2).max(35).default("en"),
  observedAt: z.iso.datetime({ offset: true }),
});

export const linkDish = Effect.fn("restaurants.menuEdit.linkDish")(function* (
  input: z.infer<typeof linkDishSchema>,
) {
  const parsed = linkDishSchema.safeParse(input);

  if (!parsed.success) return yield* failInput(parsed.error.issues);
  const link = parsed.data;
  const actorId = yield* authorizeManage;

  return yield* withTransaction(
    "restaurants/menu-edit-link",
    Effect.gen(function* () {
      // Canonical dishes are read-only here: never auto-created from menu
      // text, and an unpublished dish can never back serving evidence.
      const target = yield* runQuery("restaurants/menu-edit-link-target", (sql) =>
        itemQuery.run(sql, { id: link.itemId, venue: link.venueId }),
      );

      if (target === null) return yield* new MenuEditNotFound({ resource: "item" });

      const published = yield* getPublishedDishIdentities([link.dishId]);

      if (published.length !== 1) return yield* new MenuEditUnpublished({ dishId: link.dishId });
      const dishes = yield* DishService;

      const profile = yield* dishes
        .getDish(link.dishId, link.locale)
        .pipe(
          Effect.catchTag("DishNotFound", () =>
            Effect.fail(new MenuEditUnpublished({ dishId: link.dishId })),
          ),
        );

      const until = yield* reviewAfterFor(link.observedAt);

      const evidence = yield* runQuery("restaurants/menu-edit-evidence-insert", (sql) =>
        insertEvidenceQuery.run(sql, {
          venue: link.venueId,
          item: link.itemId,
          dish: BigInt(link.dishId),
          source: link.sourceId,
          match: link.matchKind,
          observed: link.observedAt,
          until,
        }),
      );

      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.menu.evidence.linked",
        outcome: "succeeded",
        resource: evidence.id,
      });

      return {
        evidenceId: evidence.id,
        dish: {
          id: profile.id,
          slug: profile.slug,
          name: profile.name ?? profile.englishName ?? profile.slug,
        },
      };
    }),
  );
});

const resolveDishSchema = z.object({
  ids: z.array(dishIdSchema).min(1).max(20),
  locale: z.string().min(2).max(35).default("en"),
});

export const resolveDishCandidates = Effect.fn("restaurants.menuEdit.resolveDishes")(function* (
  input: z.infer<typeof resolveDishSchema>,
) {
  const parsed = resolveDishSchema.safeParse(input);

  if (!parsed.success) return yield* failInput(parsed.error.issues);
  yield* authorizeManage;
  const dishes = yield* DishService;

  const profiles = yield* Effect.forEach(
    parsed.data.ids,
    (id) =>
      dishes.getDish(id, parsed.data.locale).pipe(
        Effect.map((profile) => ({ id, profile })),
        Effect.catchTag("DishNotFound", () => Effect.succeed({ id, profile: null })),
      ),
    { concurrency: 4 },
  );

  const published = yield* getPublishedDishIdentities(parsed.data.ids);
  const publishedIds = new Set(published.map((entry) => entry.id));

  const candidates: Array<{
    readonly id: string;
    readonly slug: string;
    readonly displayName: string;
    readonly categories: ReadonlyArray<string>;
    readonly places: ReadonlyArray<string>;
  }> = [];

  const suppressed: Array<string> = [];

  for (const entry of profiles) {
    if (entry.profile === null || !publishedIds.has(entry.profile.id)) {
      suppressed.push(entry.id);
      continue;
    }

    const categories: Array<string> = [];

    for (const category of entry.profile.categories) {
      if (category.name !== undefined) categories.push(category.name);
    }

    const places: Array<string> = [];

    for (const place of entry.profile.places) {
      if (place.name !== undefined && places.length < 3) places.push(place.name);
    }

    candidates.push({
      id: entry.profile.id,
      slug: entry.profile.slug,
      displayName: entry.profile.name ?? entry.profile.englishName ?? entry.profile.slug,
      categories,
      places,
    });
  }

  return { candidates, suppressed };
});

const submitSchema = z.object({ venueId: z.uuid(), menuId: z.uuid() });

export const submitForReview = Effect.fn("restaurants.menuEdit.submit")(function* (
  input: z.infer<typeof submitSchema>,
) {
  const parsed = submitSchema.safeParse(input);

  if (!parsed.success) return yield* failInput(parsed.error.issues);
  const actorId = yield* authorizeManage;

  return yield* withTransaction(
    "restaurants/menu-edit-submit",
    Effect.gen(function* () {
      const rows: ReadonlyArray<MenuDraftRow> = yield* runQuery(
        "restaurants/menu-edit-drafts",
        (sql) => draftsQuery.run(sql, { menu: parsed.data.menuId, venue: parsed.data.venueId }),
      );

      const items = new Map<string, { name: string; variants: Set<string> }>();
      const pricedVariants = new Set<string>();
      const evidenceLinks = new Set<string>();
      const dishIds = new Set<string>();
      const reasons: Array<string> = [];

      for (const row of rows) {
        if (row.item_status !== "draft") continue;
        let item = items.get(row.item_id);

        if (item === undefined) {
          item = { name: row.item_name, variants: new Set() };
          items.set(row.item_id, item);
        }

        if (row.variant_id !== null && row.variant_status === "draft") {
          item.variants.add(row.variant_id);

          if (row.price_id !== null) pricedVariants.add(row.variant_id);
        }

        if (row.evidence_id !== null) {
          evidenceLinks.add(row.evidence_id);

          if (row.match_kind === "suggestion") {
            reasons.push(`Suggestion matches are never serving evidence (${row.item_name})`);
          }

          if (row.dish_id !== null) dishIds.add(row.dish_id);
        }
      }

      if (items.size === 0) {
        return yield* new MenuEditIncomplete({ reasons: ["Menu has no draft items"] });
      }

      for (const item of items.values()) {
        if (item.variants.size === 0) {
          reasons.push(`Item "${item.name}" has no portion options`);
        }

        for (const variantId of item.variants) {
          if (!pricedVariants.has(variantId)) {
            reasons.push(`Variant ${variantId} of "${item.name}" has no observed price`);
          }
        }
      }

      if (dishIds.size > 0) {
        const published = yield* getPublishedDishIdentities([...dishIds]);
        const publishedIds = new Set(published.map((entry) => entry.id));

        for (const dishId of dishIds) {
          if (!publishedIds.has(dishId)) {
            reasons.push(`Dish link ${dishId} is no longer published and stays suppressed`);
          }
        }
      }

      if (reasons.length > 0) return yield* new MenuEditIncomplete({ reasons });
      yield* recordAuditEvent({
        actorUserId: actorId,
        sessionId: null,
        requestId: crypto.randomUUID(),
        event: "restaurant.menu.submitted",
        outcome: "succeeded",
        resource: parsed.data.menuId,
        metadata: {
          items: items.size.toString(),
          pricedVariants: pricedVariants.size.toString(),
          evidenceLinks: evidenceLinks.size.toString(),
        },
      });

      // Submit gates completeness; publication stays review-gated through the
      // existing observation and status review paths.
      return {
        menuId: parsed.data.menuId,
        items: items.size,
        pricedVariants: pricedVariants.size,
        evidenceLinks: evidenceLinks.size,
      };
    }),
  );
});

export const menuSections = Effect.fn("restaurants.menuEdit.sections")(function* (input: {
  venueId: string;
  menuId: string;
}) {
  const parsed = submitSchema.safeParse(input);

  if (!parsed.success) return yield* failInput(parsed.error.issues);
  yield* authorizeManage;

  return yield* runQuery("restaurants/menu-edit-sections", (sql) =>
    sectionsQuery.run(sql, { menu: parsed.data.menuId, venue: parsed.data.venueId }),
  );
});
