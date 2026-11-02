import { BigDecimal, Data } from "effect";

import type { MenuScanDocument } from "@/modules/restaurant-discovery/menu-scan.schema";
import type { MenuOffering } from "@/modules/restaurant-discovery/server/operations/discovery";
import { isAmount, isCurrency } from "@/shared/money";

/** One browser-safe presentation contract for reviewed rows and private drafts. */
export interface InteractiveMenu {
  readonly venueName: string | null;
  readonly sourceLanguage: string | null;
  readonly targetLanguage: string;
  readonly introduction: { readonly original: string | null; readonly translated: string | null };
  readonly provenance: "reviewed" | "private_scan" | "draft";
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly section: string | null;
    readonly originalName: string;
    readonly translatedName: string | null;
    readonly originalDescription: string | null;
    readonly translatedDescription: string | null;
    readonly explanatorySummary: string | null;
    readonly ingredients?: MenuScanDocument["items"][number]["ingredients"];
    readonly uncertainties: ReadonlyArray<string>;
    readonly assetIds: ReadonlyArray<string>;
    readonly dishId: string | null;
    readonly variants: ReadonlyArray<{
      readonly id: string;
      readonly originalLabel: string;
      readonly translatedLabel: string | null;
      readonly price: {
        readonly rawText: string;
        readonly amount: string | null;
        readonly currency: string | null;
        readonly taxTreatment: string;
      } | null;
      readonly provenance: string;
      readonly sourceUrl?: string | null;
    }>;
  }>;
}

export const presentScan = (
  document: MenuScanDocument,
  venueName: string | null,
): InteractiveMenu => ({
  venueName,
  sourceLanguage: document.sourceLanguage,
  targetLanguage: document.targetLanguage,
  introduction: document.orderIntroduction,
  provenance: "private_scan",
  items: document.items.map((item) => ({
    ...item,
    section: null,
    assetIds: item.sourceReferences.map((reference) => reference.assetId),
    dishId: null,
    variants: item.variants.map((variant) => ({
      ...variant,
      provenance: "Unverified menu extraction",
    })),
  })),
});

const sectionRank = (section: string | null): string => (section === null ? "" : ` ${section}`);

/**
 * Project approved relational offerings into the shared ordering contract.
 * SQL-side shapes stay intact: grouping and field selection happen here in
 * one place so the detail page and the scan page render the same order card.
 * Section keys come from a separate arrangement read; unsectioned items keep
 * legacy name order at the top, sections follow alphabetically.
 */
export const presentReviewed = (
  offerings: ReadonlyArray<MenuOffering>,
  venueName: string | null,
  targetLanguage: string,
  sections?: ReadonlyMap<string, string | null>,
): InteractiveMenu => {
  const grouped = new Map<string, Array<MenuOffering>>();

  for (const offering of offerings) {
    const existing = grouped.get(offering.item_id);

    if (existing === undefined) grouped.set(offering.item_id, [offering]);
    else existing.push(offering);
  }

  const items = [...grouped.values()].map((variants) => {
    const first = variants[0];

    if (first === undefined) throw new RangeError("Reviewed menu item has no variants");

    const dishId = variants.find((variant) => variant.dish_id !== null)?.dish_id ?? null;
    const stale = variants.some((variant) => variant.current_enough === false);

    return {
      id: first.item_id,
      section: sections?.get(first.item_id) ?? null,
      originalName: first.item_name,
      translatedName: first.translation_language === targetLanguage ? first.translated_name : null,
      originalDescription: first.description === "" ? null : first.description,
      translatedDescription:
        first.translation_language === targetLanguage ? first.translated_description : null,
      explanatorySummary:
        first.translation_language === targetLanguage ? first.explanatory_summary : null,
      uncertainties: stale ? ["Menu evidence may be stale. Confirm with the venue."] : [],
      assetIds: [],
      dishId,
      variants: variants.map((variant) => {
        let priceProvenance = "Reviewed menu item; price unknown";

        if (variant.observation_id !== null && variant.price_kind === "listed") {
          priceProvenance = "Reviewed listed menu price";
        }

        if (variant.price_kind === "paid_unit") {
          priceProvenance = "Historical receipt-paid observation; not a listed menu price";
        }

        return {
          id: variant.variant_id,
          originalLabel: variant.variant_name,
          translatedLabel:
            variant.variant_translation_language === targetLanguage
              ? variant.variant_translated_label
              : null,
          price:
            variant.price_kind !== "listed" ||
            variant.observation_id === null ||
            variant.amount === null ||
            variant.currency === null
              ? null
              : {
                  rawText: variant.raw_price_text ?? variant.amount,
                  amount: variant.amount,
                  currency: variant.currency,
                  taxTreatment: variant.tax_treatment ?? "unknown",
                },
          provenance: [
            priceProvenance,
            variant.observed_at === null ? null : `observed ${variant.observed_at.slice(0, 10)}`,
            variant.source_category === null ? null : variant.source_category.replaceAll("_", " "),
            variant.sales_channel === null ? null : variant.sales_channel.replace("_", " "),
            variant.current_enough === false ? "stale" : null,
          ]
            .flatMap((part) => (part === null ? [] : [part]))
            .join(" · "),
          sourceUrl: variant.source_url,
        };
      }),
    };
  });

  const ordered = items.toSorted((left, right) => {
    if (sectionRank(left.section) < sectionRank(right.section)) return -1;

    if (sectionRank(left.section) > sectionRank(right.section)) return 1;

    return 0;
  });

  return {
    venueName,
    sourceLanguage: offerings[0]?.source_language ?? null,
    targetLanguage,
    introduction: { original: null, translated: null },
    provenance: "reviewed",
    items: ordered,
  };
};

/**
 * Menu localization presentation (PR13 menu redesign).
 *
 * Visitor language precedence: the visitor's explicit FeastJourney language
 * choice always wins. Browser/default-locale resolution (see
 * `resolveInitialLocale` in `src/server/geo/trusted-region.ts` and
 * `detectBrowserLocale` in `src/shared/i18n.ts`) only applies when no
 * explicit preference exists — a guess never overrides a deliberate choice.
 * `resolveMenuLocale` enforces that precedence at this presentation
 * boundary; callers pass the explicit choice first.
 *
 * Display fallback order for reviewed menus: approved stored translation
 * (the single per-row translation, human-approved at review) in the
 * requested language, otherwise the original menu text. The relational model
 * stores exactly one reviewed translation language per immutable item row
 * and no machine-translation flag, so there is no eligible stored
 * machine tier to render — nothing here synthesizes translations, and no
 * Muse call runs from render or per request. Private scans and drafts carry
 * unverified extracted text under their own provenance notices instead.
 */

const MENU_BCP47_TAGS: ReadonlyMap<string, string> = new Map([
  ["en", "en"],
  ["vi", "vi"],
  ["ja", "ja"],
  ["zh", "zh-Hans"],
  ["ko", "ko"],
  ["fr", "fr"],
  ["es", "es"],
]);

/**
 * BCP 47 tag for a menu source/target language code. Unknown or missing
 * codes become "und" (undetermined) — never a guess at another language.
 * Replaces `locale === "vi" ? "vi" : "en"` ternaries that mislabeled every
 * non-Vietnamese locale (including ja/zh/ko/fr/es menu text) as English.
 */
export const menuBcp47TagFor = (tag: string | null | undefined): string => {
  if (tag === null || tag === undefined) return "und";

  const primary = tag.split("-")[0]?.trim().toLowerCase() ?? "";

  if (primary === "") return "und";

  return MENU_BCP47_TAGS.get(primary) ?? "und";
};

export type MenuLocaleSource = "explicit" | "fallback";

export interface ResolvedMenuLocale {
  readonly locale: string;
  readonly source: MenuLocaleSource;
}

/**
 * Explicit visitor choice wins; the browser/default resolution only fills
 * the gap when no explicit preference exists. Blank inputs never count as
 * a choice. Defaults to English when neither side supplies a language.
 */
export const resolveMenuLocale = (
  explicit: string | null | undefined,
  fallback: string | null | undefined,
): ResolvedMenuLocale => {
  const cleanedExplicit = explicit?.trim() ?? "";

  if (cleanedExplicit !== "") return { locale: cleanedExplicit, source: "explicit" };

  const cleanedFallback = fallback?.trim() ?? "";

  if (cleanedFallback !== "") return { locale: cleanedFallback, source: "fallback" };

  return { locale: "en", source: "fallback" };
};

export type MenuTextProvenance = "approved" | "unverified" | "original";

export interface MenuTextDisplay {
  readonly primary: string;
  readonly primaryLang: string;
  readonly secondary: string | null;
  readonly secondaryLang: string | null;
  readonly provenance: MenuTextProvenance;
}

const cleanMenuText = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;

  const trimmed = value.trim();

  if (trimmed === "") return null;

  return trimmed;
};

/**
 * One display string with its fallback resolved. A stored translation is
 * eligible only when it is non-blank and tagged for the requested target
 * language; an identical or same-language translation collapses to the
 * original so VI visitors see Vietnamese once, never duplicated. Otherwise
 * the original menu text stays available under its own language tag.
 */
export const resolveMenuText = (input: {
  readonly original: string;
  readonly sourceLanguage: string | null;
  readonly translated: string | null;
  readonly translationLanguage: string | null;
  readonly targetLanguage: string;
  readonly reviewed: boolean;
}): MenuTextDisplay => {
  const original = input.original;
  const sourceTag = menuBcp47TagFor(input.sourceLanguage);
  const targetTag = menuBcp47TagFor(input.targetLanguage);
  const translated = cleanMenuText(input.translated);
  const translationTag = menuBcp47TagFor(input.translationLanguage);

  if (translated === null) {
    return {
      primary: original,
      primaryLang: sourceTag,
      secondary: null,
      secondaryLang: null,
      provenance: "original",
    };
  }

  if (translationTag !== targetTag || targetTag === sourceTag || translated === original.trim()) {
    return {
      primary: original,
      primaryLang: sourceTag,
      secondary: null,
      secondaryLang: null,
      provenance: "original",
    };
  }

  return {
    primary: translated,
    primaryLang: targetTag,
    secondary: original,
    secondaryLang: sourceTag,
    provenance: input.reviewed ? "approved" : "unverified",
  };
};

/**
 * Browsing-list display for one `InteractiveMenu` item. `InteractiveMenu`
 * only carries translated text already matched to `menu.targetLanguage`
 * (reviewed projection gates by `translation_language`, scans and drafts by
 * document language), so the target language doubles as the translation
 * tag here. Title is the localized name when eligible, otherwise the
 * original; the original name stays secondary when it differs, keeping the
 * native name accessible for ordering. A same-language request (VI visitor
 * on a Vietnamese menu) never duplicates the name.
 */
export interface MenuItemDisplay {
  readonly title: string;
  readonly titleLang: string;
  readonly subtitle: string | null;
  readonly subtitleLang: string | null;
  readonly description: string | null;
  readonly descriptionLang: string | null;
  readonly nativeName: string;
  readonly nativeLang: string;
  readonly provenance: MenuTextProvenance;
}

export const menuItemDisplayFor = (
  item: InteractiveMenu["items"][number],
  menu: Pick<InteractiveMenu, "sourceLanguage" | "targetLanguage" | "provenance">,
): MenuItemDisplay => {
  const reviewed = menu.provenance === "reviewed";

  const name = resolveMenuText({
    original: item.originalName,
    sourceLanguage: menu.sourceLanguage,
    translated: item.translatedName,
    translationLanguage: item.translatedName === null ? null : menu.targetLanguage,
    targetLanguage: menu.targetLanguage,
    reviewed,
  });

  const description = resolveMenuText({
    original: item.originalDescription ?? "",
    sourceLanguage: menu.sourceLanguage,
    translated: item.translatedDescription,
    translationLanguage: item.translatedDescription === null ? null : menu.targetLanguage,
    targetLanguage: menu.targetLanguage,
    reviewed,
  });

  const nativeTag = menuBcp47TagFor(menu.sourceLanguage);

  return {
    title: name.primary,
    titleLang: name.primaryLang,
    subtitle: name.secondary,
    subtitleLang: name.secondaryLang,
    description:
      item.originalDescription === null && item.translatedDescription === null
        ? null
        : description.primary,
    descriptionLang:
      item.originalDescription === null && item.translatedDescription === null
        ? null
        : description.primaryLang,
    nativeName: item.originalName,
    nativeLang: nativeTag,
    provenance:
      item.originalDescription === null && item.translatedDescription === null
        ? name.provenance
        : description.provenance,
  };
};

export interface WaiterText {
  readonly text: string;
  readonly lang: string;
}

/**
 * Waiter card consumes the original menu language primarily: staff match
 * what is printed, so the original name and variant label lead under the
 * source language tag. Localized text stays available in the card body for
 * the visitor; these helpers expose the order-critical originals.
 */
export const waiterDishNameFor = (
  item: InteractiveMenu["items"][number],
  sourceLanguage: string | null,
): WaiterText => ({ text: item.originalName, lang: menuBcp47TagFor(sourceLanguage) });

export const waiterVariantLabelFor = (
  variant: InteractiveMenu["items"][number]["variants"][number],
  sourceLanguage: string | null,
): WaiterText => ({ text: variant.originalLabel, lang: menuBcp47TagFor(sourceLanguage) });

/** One deterministic preview highlight: real item identity only. */
export interface MenuHighlight {
  readonly id: string;
  readonly name: string;
  readonly dishId: string | null;
  readonly variantCount: number;
}

/** Default preview size: a small card row, never the whole menu. */
const DEFAULT_MENU_HIGHLIGHT_LIMIT = 3;

/** Hard cap so a preview cannot grow into a full menu render. */
const MAX_MENU_HIGHLIGHT_LIMIT = 10;

/**
 * Select up to `limit` deterministic menu highlights from reviewed
 * offerings. Pure: no Effect, no I/O, no invented names, prices or images.
 * Only published items with at least one variant row are eligible; items
 * linked to a published canonical dish through approved serving evidence
 * (`dish_id` set by the menu query) rank first, with ascending `item_id`
 * as the deterministic tie-break so the same input always yields the same
 * output regardless of row order.
 */
export const selectMenuHighlights = (
  offerings: ReadonlyArray<MenuOffering>,
  limit: number = DEFAULT_MENU_HIGHLIGHT_LIMIT,
): ReadonlyArray<MenuHighlight> => {
  if (!Number.isInteger(limit) || limit <= 0) return [];

  const count = Math.min(limit, MAX_MENU_HIGHLIGHT_LIMIT);
  const grouped = new Map<string, Array<MenuOffering>>();

  for (const offering of offerings) {
    const existing = grouped.get(offering.item_id);

    if (existing === undefined) grouped.set(offering.item_id, [offering]);
    else existing.push(offering);
  }

  const eligible: Array<{ readonly first: MenuOffering; readonly variantCount: number }> = [];

  for (const variants of grouped.values()) {
    const first = variants[0];

    if (first !== undefined) eligible.push({ first, variantCount: variants.length });
  }

  const ranked = eligible.toSorted((left, right) => {
    const leftLinked = left.first.dish_id !== null;
    const rightLinked = right.first.dish_id !== null;

    if (leftLinked !== rightLinked) return leftLinked ? -1 : 1;

    if (left.first.item_id < right.first.item_id) return -1;

    if (left.first.item_id > right.first.item_id) return 1;

    return 0;
  });

  return ranked.slice(0, count).map(({ first, variantCount }) => ({
    id: first.item_id,
    name: first.item_name,
    dishId: first.dish_id,
    variantCount,
  }));
};

/** Client-side curator draft: unsaved edits and saved draft rows share one shape. */
export interface MenuDraftVariantPrice {
  readonly rawText: string;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly channel: string;
  readonly taxTreatment: string;
}

export interface MenuDraftVariant {
  readonly clientKey: string;
  readonly variantId?: string | undefined;
  readonly label: string;
  readonly comparisonKey?: string | undefined;
  readonly translatedLabel?: string | undefined;
  readonly price: MenuDraftVariantPrice | null;
}

export interface MenuDraftItem {
  readonly clientKey: string;
  readonly itemId?: string | undefined;
  readonly name: string;
  readonly description: string;
  readonly section: string | null;
  readonly translatedName?: string | undefined;
  readonly translatedDescription?: string | undefined;
  readonly dish?:
    | { readonly id: string; readonly slug: string; readonly displayName: string }
    | null
    | undefined;
  readonly variants: ReadonlyArray<MenuDraftVariant>;
}

export interface MenuDraft {
  readonly menuId?: string | undefined;
  readonly menuName: string;
  readonly venueName: string | null;
  readonly sourceLanguage: string | null;
  readonly targetLanguage: string;
  readonly items: ReadonlyArray<MenuDraftItem>;
}

/**
 * Render a curator draft through the shared ordering contract: the same
 * InteractiveMenuView and waiter card as reviewed menus, never a separate
 * fake renderer. Draft provenance keeps unpublished edits labeled.
 */
export const presentDraft = (draft: MenuDraft): InteractiveMenu => {
  const items = draft.items.map((item) => ({
    id: item.itemId ?? item.clientKey,
    section: item.section,
    originalName: item.name === "" ? "(unnamed dish)" : item.name,
    translatedName: item.translatedName ?? null,
    originalDescription: item.description === "" ? null : item.description,
    translatedDescription: item.translatedDescription ?? null,
    explanatorySummary: null,
    uncertainties: [],
    assetIds: [],
    dishId: item.dish?.id ?? null,
    variants: item.variants.map((variant) => ({
      id: variant.variantId ?? variant.clientKey,
      originalLabel: variant.label === "" ? "As listed" : variant.label,
      translatedLabel: variant.translatedLabel ?? null,
      price:
        variant.price === null
          ? null
          : {
              rawText: variant.price.rawText,
              amount: variant.price.amount,
              currency: variant.price.currency,
              taxTreatment: variant.price.taxTreatment,
            },
      provenance:
        variant.price === null
          ? "Draft item; price unknown — ask the waiter"
          : "Draft price — unpublished",
      sourceUrl: null,
    })),
  }));

  const unsectioned = items.filter((item) => item.section === null);
  const sectioned = items.filter((item) => item.section !== null);

  return {
    venueName: draft.venueName,
    sourceLanguage: draft.sourceLanguage,
    targetLanguage: draft.targetLanguage,
    introduction: { original: null, translated: null },
    provenance: "draft",
    items: [...unsectioned, ...sectioned],
  };
};

export interface MenuSelection {
  readonly variantId: string;
  readonly quantity: number;
  readonly instruction: string;
  readonly originalLanguageInstruction: string;
}

export type MenuSubtotal = Data.TaggedEnum<{
  Empty: {};
  Unavailable: { readonly reason: string };
  Calculable: { readonly amount: string; readonly currency: string };
}>;

export const MenuSubtotal = Data.taggedEnum<MenuSubtotal>();

export const exactDecimalText = (value: BigDecimal.BigDecimal): string => {
  if (value.scale <= 0) return (value.value * 10n ** BigInt(-value.scale)).toString();
  const digits = value.value.toString().padStart(value.scale + 1, "0");

  return `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
};

export function orderLines(menu: InteractiveMenu, selections: ReadonlyArray<MenuSelection>) {
  const variants = new Map(
    menu.items.flatMap((item) =>
      item.variants.map((variant) => [variant.id, { item, variant }] as const),
    ),
  );

  const seen = new Set<string>();

  return selections.map((selection) => {
    const offering = variants.get(selection.variantId);

    if (
      offering === undefined ||
      seen.has(selection.variantId) ||
      !Number.isInteger(selection.quantity) ||
      selection.quantity < 1 ||
      selection.quantity > 99
    ) {
      throw new RangeError("Invalid menu selection");
    }

    seen.add(selection.variantId);
    const price = offering.variant.price;
    let lineAmount: string | null = null;

    if (price?.amount !== null && price?.amount !== undefined && isAmount(price.amount)) {
      lineAmount = exactDecimalText(
        BigDecimal.multiply(
          BigDecimal.fromStringUnsafe(price.amount),
          BigDecimal.fromBigInt(BigInt(selection.quantity)),
        ),
      );
    }

    return { ...offering, ...selection, lineAmount };
  });
}

export function menuSubtotal(
  menu: InteractiveMenu,
  selections: ReadonlyArray<MenuSelection>,
): MenuSubtotal {
  const lines = orderLines(menu, selections);

  if (lines.length === 0) return MenuSubtotal.Empty();
  let currency: string | undefined;
  let total = BigDecimal.fromBigInt(0n);

  for (const line of lines) {
    const price = line.variant.price;

    if (
      line.lineAmount === null ||
      price === null ||
      price.currency === null ||
      !isCurrency(price.currency)
    ) {
      return MenuSubtotal.Unavailable({
        reason: "Some prices or currencies are unknown. Confirm with the waiter.",
      });
    }

    if (currency !== undefined && currency !== price.currency) {
      return MenuSubtotal.Unavailable({
        reason: "Prices use different currencies; no single subtotal is available.",
      });
    }

    currency = price.currency;
    total = BigDecimal.sum(total, BigDecimal.fromStringUnsafe(line.lineAmount));
  }

  if (currency === undefined) throw new RangeError("Selected lines have no currency");

  return MenuSubtotal.Calculable({ amount: exactDecimalText(total), currency });
}
