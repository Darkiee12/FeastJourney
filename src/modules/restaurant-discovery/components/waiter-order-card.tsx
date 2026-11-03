import { useId, useState } from "react";

import { menuCopy, orderIntroductions } from "@/modules/restaurant-discovery/components/menu-copy";
import {
  menuBcp47TagFor,
  MenuSubtotal,
  menuSubtotal,
  orderLines,
} from "@/modules/restaurant-discovery/menu-presentation";
import type {
  InteractiveMenu,
  MenuSelection,
} from "@/modules/restaurant-discovery/menu-presentation";
import { formatMoney, isCurrency } from "@/shared/money";

export interface WaiterTranslationToggleLabels {
  readonly show: string;
  readonly hide: string;
}

/**
 * Built-in toggle wording mirrors menu-copy.ts (`showTranslations` /
 * `hideTranslations`); passed `translationToggleLabels` always win. No
 * other copy is invented here.
 */
const translationToggleFallback = (copy: MenuOrderCopy): WaiterTranslationToggleLabels => ({
  show: copy.showTranslations,
  hide: copy.hideTranslations,
});

type OrderLine = ReturnType<typeof orderLines>[number];

type MenuOrderCopy = ReturnType<typeof menuCopy>;

/**
 * Compact review line: original item/variant primary, translation secondary,
 * reviewed-only special requests, concise price. Quantity/variant edits render
 * only when the parent wires `onQuantity`/`onVariant` (coordinator passes the
 * canonical `changeSelection` transfer); otherwise the card is display-only.
 */
function WaiterOrderLine({
  line,
  copy,
  locale,
  sourceLanguage,
  targetLanguage,
  showTranslations,
  instructionReviewed,
  onQuantity,
  onVariant,
}: {
  readonly line: OrderLine;
  readonly copy: MenuOrderCopy;
  readonly locale: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly showTranslations: boolean;
  readonly instructionReviewed: boolean;
  readonly onQuantity?: ((variantId: string, quantity: number) => void) | undefined;
  readonly onVariant?: ((previousVariantId: string, nextVariantId: string) => void) | undefined;
}) {
  const price = line.variant.price;

  const bothEntered =
    line.instruction.trim() !== "" && line.originalLanguageInstruction.trim() !== "";

  const showInstruction = bothEntered && instructionReviewed;

  return (
    <li className="border-b-2 border-ink py-4 break-words last:border-b-0">
      <div className="flex items-baseline gap-3">
        <strong
          aria-label={`${copy.quantity}: ${line.quantity}`}
          className="shrink-0 text-2xl font-extrabold tabular-nums"
        >
          {line.quantity} ×
        </strong>
        <div className="min-w-0">
          <h3 lang={sourceLanguage} className="text-lg leading-snug font-bold">
            {line.item.originalName}
          </h3>
          <p lang={sourceLanguage} className="text-base font-semibold">
            {line.variant.originalLabel}
          </p>
        </div>
      </div>
      {showTranslations && line.item.translatedName !== null && (
        <p lang={targetLanguage} className="mt-1 text-sm text-muted">
          {line.item.translatedName}
        </p>
      )}
      {showTranslations && line.variant.translatedLabel !== null && (
        <p lang={targetLanguage} className="text-sm text-muted">
          {line.variant.translatedLabel}
        </p>
      )}
      {showInstruction && (
        <p lang={sourceLanguage} className="mt-2 text-base font-semibold">
          {line.originalLanguageInstruction}
        </p>
      )}
      {showInstruction && showTranslations && (
        <p lang={targetLanguage} className="text-sm text-muted">
          {line.instruction}
        </p>
      )}
      {line.lineAmount !== null &&
      price !== null &&
      price.currency !== null &&
      isCurrency(price.currency) ? (
        <p className="mt-1 text-sm">
          {formatMoney(line.lineAmount, price.currency, locale)} <span>{price.currency}</span>
        </p>
      ) : (
        <p className="mt-1 text-sm font-semibold">⚠ {copy.unknownPrice}</p>
      )}
      {onVariant !== undefined && line.item.variants.length > 1 && (
        <div className="mt-2">
          <label
            htmlFor={`waiter-variant-${line.variant.id}`}
            className="mb-1 block text-xs font-bold"
          >
            {copy.variant}
          </label>
          <select
            id={`waiter-variant-${line.variant.id}`}
            value={line.variant.id}
            lang={sourceLanguage}
            onChange={(event) => onVariant(line.variant.id, event.target.value)}
            className="min-h-11 w-full rounded-lg border border-border-soft bg-white px-3 text-base"
          >
            {line.item.variants.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.originalLabel === "" ? copy.asListed : entry.originalLabel}
                {showTranslations && entry.translatedLabel !== null
                  ? ` / ${entry.translatedLabel}`
                  : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      {onQuantity !== undefined && (
        <fieldset
          aria-label={`${copy.quantity}: ${line.item.originalName}, ${line.variant.originalLabel}`}
          className="mt-2 inline-flex items-center gap-3 rounded-lg border border-border-soft px-2 py-1"
        >
          <button
            type="button"
            aria-label={`${copy.remove}: ${line.item.originalName}`}
            onClick={() => onQuantity(line.variant.id, line.quantity - 1)}
            className="min-h-11 min-w-11 cursor-pointer text-xl font-bold"
          >
            −
          </button>
          <output
            aria-live="polite"
            aria-label={copy.quantity}
            className="min-w-6 text-center text-lg tabular-nums"
          >
            {line.quantity}
          </output>
          <button
            type="button"
            aria-label={`${copy.add}: ${line.item.originalName}`}
            disabled={line.quantity >= 99}
            onClick={() => onQuantity(line.variant.id, line.quantity + 1)}
            className="min-h-11 min-w-11 cursor-pointer text-xl font-bold disabled:cursor-not-allowed disabled:opacity-50"
          >
            +
          </button>
        </fieldset>
      )}
    </li>
  );
}

/**
 * Waiter order card: ORIGINAL menu language primary, venue first, then the
 * "please order" line, `N × item / variant` lines, concise subtotal, and the
 * not-submitted notice. Never implies electronic ordering. Special requests
 * render only when both language versions were traveler-entered AND the
 * variant id is in `reviewedVariantIds`; anything else stays a compact
 * `reviewRequired` warning so unreviewed text never reaches the waiter.
 *
 * Dialog chrome (native `<dialog>`, Escape, focus trap/restore) stays with
 * the parent shell in interactive-menu.tsx; this card only provides its own
 * sticky compact top bar with Back/Close via `onClose`. Pure render, no
 * effects or data fetching, so opening/closing never remounts the map.
 */
export function WaiterOrderCard({
  menu,
  selections,
  locale,
  reviewedVariantIds,
  translationToggleLabels,
  onClose,
  onQuantity,
  onVariant,
}: {
  readonly menu: InteractiveMenu;
  readonly selections: ReadonlyArray<MenuSelection>;
  readonly locale: string;
  readonly reviewedVariantIds?: ReadonlySet<string> | undefined;
  readonly translationToggleLabels?: WaiterTranslationToggleLabels | undefined;
  readonly onClose?: (() => void) | undefined;
  readonly onQuantity?: ((variantId: string, quantity: number) => void) | undefined;
  readonly onVariant?: ((previousVariantId: string, nextVariantId: string) => void) | undefined;
}) {
  const titleId = useId();
  // Waiter-facing mode hides translations by default: staff match the
  // printed originals. The toggle stays one tap away for the traveler.
  const [showTranslations, setShowTranslations] = useState(false);
  const copy = menuCopy(locale);
  const toggleLabels = translationToggleLabels ?? translationToggleFallback(copy);
  const sourceLanguage = menu.sourceLanguage ?? "und";
  const originalIntroduction = menu.introduction.original ?? orderIntroductions.get(sourceLanguage);

  const translatedIntroduction =
    menu.introduction.translated ?? orderIntroductions.get(menu.targetLanguage);

  const lines = orderLines(menu, selections);
  const subtotal = menuSubtotal(menu, selections);
  const quantity = selections.reduce((total, selection) => total + selection.quantity, 0);

  // One footer-level warning instead of a repeated per-line notice.
  const anyNeedsReview = lines.some((line) => {
    const entered =
      line.instruction.trim() !== "" || line.originalLanguageInstruction.trim() !== "";

    const bothEntered =
      line.instruction.trim() !== "" && line.originalLanguageInstruction.trim() !== "";

    return entered && !(bothEntered && (reviewedVariantIds?.has(line.variant.id) ?? false));
  });

  // One card-level note instead of repeated per-line warnings.
  const uncertainties = [...new Set(lines.flatMap((line) => line.item.uncertainties))];

  const subtotalText = MenuSubtotal.$match(subtotal, {
    Empty: () => copy.empty,
    Unavailable: () => copy.priceCheck,
    Calculable: ({ amount, currency }) =>
      `${copy.subtotal}: ${formatMoney(amount, currency, locale)} ${currency}`,
  });

  return (
    <section
      aria-labelledby={titleId}
      lang={menuBcp47TagFor(locale)}
      className="min-w-0 break-words text-ink"
    >
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border-soft bg-white/95 py-2 backdrop-blur">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-extrabold">
          {copy.orderTitle} · {quantity}
        </h2>
        <button
          type="button"
          aria-pressed={showTranslations}
          onClick={() => setShowTranslations((visible) => !visible)}
          className="min-h-11 shrink-0 cursor-pointer rounded-full border border-ink px-3 text-xs font-bold whitespace-nowrap"
        >
          {showTranslations ? toggleLabels.hide : toggleLabels.show}
        </button>
        {onClose !== undefined && (
          <button
            type="button"
            aria-label={copy.back}
            onClick={onClose}
            className="min-h-11 min-w-11 shrink-0 cursor-pointer rounded-full border border-ink text-lg font-bold"
          >
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </div>
      {menu.venueName !== null && (
        <p className="mt-3 text-xl leading-snug font-extrabold">{menu.venueName}</p>
      )}
      {originalIntroduction !== undefined && (
        <p lang={sourceLanguage} className="mt-1 text-lg font-bold">
          {originalIntroduction}
        </p>
      )}
      {showTranslations && translatedIntroduction !== undefined && (
        <p lang={menu.targetLanguage} className="mt-1 text-sm text-muted">
          {translatedIntroduction}
        </p>
      )}
      <ol className="mt-2 list-none p-0">
        {lines.map((line) => (
          <WaiterOrderLine
            key={line.variant.id}
            line={line}
            copy={copy}
            locale={locale}
            sourceLanguage={sourceLanguage}
            targetLanguage={menu.targetLanguage}
            showTranslations={showTranslations}
            instructionReviewed={reviewedVariantIds?.has(line.variant.id) ?? false}
            onQuantity={onQuantity}
            onVariant={onVariant}
          />
        ))}
      </ol>
      <footer className="pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <p aria-live="polite" className="text-lg font-extrabold">
          {subtotalText}
        </p>
        {anyNeedsReview && (
          <p role="note" className="mt-2 text-xs font-semibold">
            ⚠ {copy.reviewRequired}
          </p>
        )}
        {(uncertainties.length > 0 ||
          menu.sourceLanguage === null ||
          menu.provenance !== "reviewed") && (
          <details className="mt-2 text-xs">
            <summary>{copy.sourceDetails}</summary>
            {menu.sourceLanguage === null && (
              <p className="mt-1 font-semibold">⚠ {copy.unknownLanguage}</p>
            )}
            {uncertainties.length > 0 && (
              <p className="mt-1">
                ⚠ {copy.uncertainty}: {uncertainties.join("; ")}
              </p>
            )}
            {menu.provenance === "private_scan" && <p className="mt-1">{copy.privateOrder}</p>}
            {menu.provenance === "draft" && <p className="mt-1">{copy.draftOrder}</p>}
          </details>
        )}
        <p role="note" className="mt-3 rounded-xl border-2 border-ink p-3 text-sm font-bold">
          ⚠ {copy.notSubmitted} {copy.fees}
        </p>
      </footer>
    </section>
  );
}
