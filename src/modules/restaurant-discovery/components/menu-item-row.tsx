import { Plus } from "lucide-react";
import type { ReactNode } from "react";

import {
  ObservedPrice,
  priceAvailability,
} from "@/modules/restaurant-discovery/components/currency-tools";
import { menuResultsCopy } from "@/modules/restaurant-discovery/components/menu-copy";
import type {
  InteractiveMenu,
  MenuSelection,
} from "@/modules/restaurant-discovery/menu-presentation";
import {
  conversionRateFor,
  priceAssociationOf,
  priceTrustOf,
} from "@/modules/restaurant-discovery/menu-presentation";
import type { ExchangeRate } from "@/shared/money";

export type MenuRowItem = InteractiveMenu["items"][number];

export type MenuRowVariant = MenuRowItem["variants"][number];

/**
 * Brief contextual price note for one variant. Ambiguous associations and
 * inferred currencies stay visible next to the affected dish; unknown or
 * missing prices are owned by the caller's unknown-price line, not this
 * note. Conversion never upgrades trust — the note renders regardless of
 * whether a converted amount is shown.
 */
export function PriceConfidenceNote({
  price,
  inferredNote,
  possibleNote,
  associationNote,
  compact = false,
}: {
  readonly price: MenuRowVariant["price"];
  readonly inferredNote: string | undefined;
  readonly possibleNote: string | undefined;
  readonly associationNote?: string | null | undefined;
  readonly compact?: boolean;
}): ReactNode {
  if (price === null) return null;

  if (priceAssociationOf(price) === "ambiguous" && possibleNote !== undefined)
    return (
      <p
        className={
          compact
            ? "mt-1 max-w-[20ch] text-xs leading-relaxed font-normal text-muted"
            : "menu-row-note"
        }
      >
        {possibleNote}
        {associationNote === null || associationNote === undefined || associationNote === ""
          ? null
          : ` — ${associationNote}`}
      </p>
    );

  if (priceTrustOf(price) === "inferred" && inferredNote !== undefined)
    return (
      <p
        className={
          compact
            ? "mt-1 max-w-[20ch] text-xs leading-relaxed font-normal text-muted"
            : "menu-row-note"
        }
      >
        {inferredNote}
      </p>
    );

  return null;
}

/**
 * Compact menu row: thumbnail slot + names + 2-line description + listed
 * price + one 44px add action. Presentation only — selection state,
 * variant identities, quantity limits (0–99) and provenance all come from
 * the shared `MenuSelection` / `orderLines` read paths owned by
 * menu-presentation.ts. Rows never render details, ingredients, warnings,
 * consent controls or canonical/source links; those live in
 * MenuItemDetail.
 */
export interface MenuRowLabels {
  readonly add: string;
  readonly openDetails: string;
  readonly quantity: string;
  readonly priceUnknown: string;
  readonly uncertaintyMarker?: string | undefined;
  readonly inferredNote?: string | undefined;
  readonly possibleNote?: string | undefined;
}

/** Thumbnail slot geometry: 68–76px, centered. The guest thumbnail
 *  (Agent C MenuDishThumbnail, fixed 68px) owns its own chrome; the slot
 *  never restyles guest internals. */
export const MENU_ROW_THUMB = "clamp(4.25rem, 18vw, 4.75rem)";

/** First variant wins until the traveler picks a portion in detail. */
export const defaultVariantIdFor = (item: MenuRowItem): string | null => {
  const first = item.variants[0];

  if (first === undefined) return null;

  return first.id;
};

/** Localized name first, original preserved separately below. */
export const rowDisplayNameFor = (item: MenuRowItem): string =>
  item.translatedName ?? item.originalName;

/** Show the original name as secondary only when it adds information. */
export const rowShowsOriginalNameFor = (item: MenuRowItem): boolean =>
  item.translatedName !== null && item.translatedName !== item.originalName;

/** Single clamped snippet for the row; full text lives in detail. */
export const rowSnippetFor = (item: MenuRowItem): string | null =>
  item.translatedDescription ?? item.originalDescription ?? item.explanatorySummary;

/** Valid published association only: menu queries set dishId from approved
 *  serving evidence, unpublished links stay null and render no anchor. */
export const canonicalDishHrefFor = (dishId: string | null, locale: string): string | null => {
  if (dishId === null || dishId === "") return null;

  return `/dishes/${encodeURIComponent(dishId)}?lang=${encodeURIComponent(locale)}`;
};

export function MenuItemRow({
  item,
  locale,
  labels,
  rates,
  selectedVariantId,
  selection,
  sourceLanguage,
  targetLanguage,
  thumbnail,
  onOpen,
  onEdit,
  onSelection,
  presentation = "standard",
}: {
  readonly item: MenuRowItem;
  readonly locale: string;
  readonly labels: MenuRowLabels;
  readonly rates?: ReadonlyMap<string, ExchangeRate> | undefined;
  readonly selectedVariantId: string;
  readonly selection: MenuSelection | undefined;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly thumbnail?: ReactNode | undefined;
  readonly onOpen: () => void;
  readonly onEdit?: (() => void) | undefined;
  readonly onSelection: (selection: MenuSelection) => void;
  readonly presentation?: "standard" | "scan";
}): ReactNode {
  const ui = menuResultsCopy(locale);

  const variant: MenuRowVariant | undefined = item.variants.find(
    (entry) => entry.id === selectedVariantId,
  );

  if (variant === undefined) return null;

  const quantity = selection?.quantity ?? 0;
  const name = rowDisplayNameFor(item);
  const showOriginal = rowShowsOriginalNameFor(item);
  const snippet = rowSnippetFor(item);
  const price = variant.price;
  const scan = presentation === "scan";

  const hasDetails =
    item.variants.length > 1 ||
    (item.ingredients?.length ?? 0) > 0 ||
    item.explanatorySummary !== null ||
    item.uncertainties.length > 0;

  const addOne = (): void => {
    if (quantity >= 99) return;

    onSelection({
      variantId: variant.id,
      quantity: quantity + 1,
      instruction: selection?.instruction ?? "",
      originalLanguageInstruction: selection?.originalLanguageInstruction ?? "",
    });
  };

  return (
    <li
      className={
        scan
          ? "grid min-w-0 grid-cols-[minmax(0,1fr)_5.5rem] items-start gap-2 border-b border-border-soft py-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_7rem] sm:gap-4 sm:py-5"
          : "menu-row"
      }
    >
      {thumbnail !== undefined && <span className="menu-row-thumb">{thumbnail}</span>}
      <div className={scan ? "grid min-w-0 gap-1" : "menu-row-main"}>
        <span className={scan ? "grid min-w-0 gap-1" : "menu-row-text"}>
          <span
            className={
              scan
                ? "block text-base leading-snug font-extrabold tracking-tight sm:text-lg"
                : "menu-row-name"
            }
            lang={showOriginal ? targetLanguage : sourceLanguage}
          >
            {item.uncertainties.length > 0 && labels.uncertaintyMarker !== undefined ? (
              <span
                className="menu-row-flag"
                title={labels.uncertaintyMarker}
                aria-label={labels.uncertaintyMarker}
              >
                ⚠
              </span>
            ) : null}
            {name}
          </span>
          {showOriginal ? (
            <span
              className={scan ? "block text-sm leading-relaxed text-muted" : "menu-row-original"}
              lang={sourceLanguage}
            >
              {item.originalName}
            </span>
          ) : null}
          {snippet !== null ? (
            <span
              className={
                scan ? "mt-1 line-clamp-2 text-sm leading-relaxed text-ink/80" : "menu-row-desc"
              }
              lang={targetLanguage}
            >
              {snippet}
            </span>
          ) : null}
        </span>
        {item.variants.length > 1 && (
          <small lang={targetLanguage}>{variant.translatedLabel ?? variant.originalLabel}</small>
        )}
        {!scan && (
          <>
            <MenuPrice price={price} locale={locale} rates={rates} />
            <PriceConfidenceNote
              price={price}
              inferredNote={labels.inferredNote}
              possibleNote={labels.possibleNote}
              associationNote={price?.associationNote}
            />
          </>
        )}
        {!scan && (
          <div className="flex flex-wrap items-center gap-4">
            {hasDetails && (
              <button
                type="button"
                id={`menu-row-open-${item.id}`}
                className="menu-results-edit"
                onClick={onOpen}
                aria-label={`${labels.openDetails}: ${name}`}
              >
                {ui.details}
              </button>
            )}
            {onEdit !== undefined && (
              <button
                type="button"
                className="menu-results-edit"
                onClick={onEdit}
                aria-label={`${ui.edit}: ${name}`}
              >
                {ui.edit}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-col items-end gap-2 text-right">
        {scan && (
          <div className="min-w-0">
            <MenuPrice price={price} locale={locale} rates={rates} compact={scan} />
            <PriceConfidenceNote
              price={price}
              inferredNote={labels.inferredNote}
              possibleNote={labels.possibleNote}
              associationNote={price?.associationNote}
              compact={scan}
            />
          </div>
        )}
        <span
          className={
            scan ? "flex flex-wrap items-center justify-end gap-0 sm:gap-2" : "menu-row-action"
          }
        >
          {scan && hasDetails && (
            <button
              type="button"
              id={`menu-row-open-${item.id}`}
              className="inline-flex size-11 items-center justify-center text-xs font-semibold text-muted underline underline-offset-4"
              onClick={onOpen}
              aria-label={`${labels.openDetails}: ${name}`}
            >
              {ui.details}
            </button>
          )}
          {quantity > 0 ? (
            <output className="menu-row-count" aria-label={`${labels.quantity}: ${quantity}`}>
              {quantity}×
            </output>
          ) : null}
          <button
            type="button"
            className={
              scan
                ? "inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-food-orange-strong bg-white text-food-orange-strong hover:bg-cream focus-visible:outline-2 focus-visible:outline-brand-blue disabled:opacity-50 [&_svg]:size-5"
                : "menu-row-add"
            }
            onClick={addOne}
            disabled={quantity >= 99}
            aria-label={`${labels.add}: ${name}`}
          >
            <Plus aria-hidden="true" />
          </button>
        </span>
      </div>
    </li>
  );
}

/** Raw observations remain useful even when monetary normalization is incomplete. */
export function MenuPrice({
  price,
  locale,
  rates,
  compact = false,
}: {
  readonly price: MenuRowVariant["price"];
  readonly locale: string;
  readonly rates?: ReadonlyMap<string, ExchangeRate> | undefined;
  readonly compact?: boolean;
}) {
  const ui = menuResultsCopy(locale);

  if (price === null || (price.rawText.trim() === "" && price.amount === null))
    return (
      <p className={compact ? "text-xs leading-relaxed text-muted" : "menu-row-price-na"}>
        {ui.priceNotReadable}
      </p>
    );

  if (
    priceAvailability(price.amount, price.currency) === "priced" &&
    price.amount !== null &&
    price.currency !== null
  )
    return (
      <div className={compact ? "text-base font-extrabold tabular-nums" : "menu-row-price"}>
        <ObservedPrice
          amount={price.amount}
          currency={price.currency}
          locale={locale}
          rate={conversionRateFor(price, rates)}
          compact={compact}
        />
        {price.unit && <small> / {price.unit}</small>}
      </div>
    );

  let unconfirmed = ui.amountUnconfirmed;

  if (price.currency === null) unconfirmed = ui.currencyUnconfirmed;

  return (
    <div className={compact ? "text-base font-extrabold tabular-nums" : "menu-row-price"}>
      <strong>{price.rawText}</strong>
      <p
        className={
          compact ? "mt-1 text-xs leading-relaxed font-normal text-muted" : "menu-row-note"
        }
      >
        {unconfirmed}
      </p>
    </div>
  );
}
