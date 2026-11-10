import {
  Info,
  Minus,
  Plus,
  ShoppingBag,
  Soup,
  Languages,
  ClipboardList,
  Camera,
  Coins,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";

import {
  menuResultsCopy,
  menuResultsCount,
  menuCopy,
  menuScanResultsCopy,
} from "@/modules/restaurant-discovery/components/menu-copy";
import {
  MenuPrice,
  PriceConfidenceNote,
} from "@/modules/restaurant-discovery/components/menu-item-row";
import { WaiterOrderCard } from "@/modules/restaurant-discovery/components/waiter-order-card";
import {
  MenuSubtotal,
  menuSubtotal,
  orderLines,
  type InteractiveMenu,
  type MenuSelection,
} from "@/modules/restaurant-discovery/menu-presentation";
import { formatMoney, type ExchangeRate } from "@/shared/money";

/** One stateless order review for the desktop sidebar and mobile sheet. */
export function MenuOrderReview({
  menu,
  selections,
  locale,
  rates,
  needsReview,
  onSelection,
  onDetails,
  onShowWaiter,
  full = false,
  reviewedVariantIds,
  onEditOrder,
  actionId,
}: {
  readonly menu: InteractiveMenu;
  readonly selections: ReadonlyArray<MenuSelection>;
  readonly locale: string;
  readonly rates?: ReadonlyMap<string, ExchangeRate> | undefined;
  readonly needsReview: boolean;
  readonly onSelection: (selection: MenuSelection) => void;
  readonly onDetails: (itemId: string) => void;
  readonly onShowWaiter: () => void;
  readonly full?: boolean;
  readonly reviewedVariantIds?: ReadonlySet<string> | undefined;
  readonly onEditOrder?: (() => void) | undefined;
  readonly actionId?: string;
}) {
  const ui = menuResultsCopy(locale);
  const resultsCopy = menuScanResultsCopy(locale);
  const [translations, setTranslations] = useState(true);
  const copy = menuCopy(locale);
  const lines = orderLines(menu, selections);
  const quantity = selections.reduce((total, line) => total + line.quantity, 0);
  const quantityLabel = menuResultsCount(locale, "items", quantity);
  const subtotal = menuSubtotal(menu, selections);

  const total = MenuSubtotal.$match(subtotal, {
    Empty: () => ({ label: "", note: null }),
    Unavailable: () => ({
      label: ui.totalToConfirm,
      note: copy.priceCheck,
    }),
    Calculable: ({ amount, currency }) => ({
      label: formatMoney(amount, currency, locale),
      note: null,
    }),
  });

  let sourceLabel = copy.sourceDetails;

  if (menu.provenance === "private_scan") sourceLabel = ui.privatePhoto;

  const inferred = lines.some((line) => line.variant.price?.currencyProvenance === "inferred");

  return (
    <section className="min-w-0 text-ink" aria-label={ui.yourOrder}>
      <div
        className={
          full
            ? "mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-border-soft pb-4"
            : undefined
        }
      >
        <h2
          className={
            full
              ? "m-0 flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xl leading-snug font-extrabold sm:text-2xl [&>svg]:size-6 [&>svg]:text-food-orange-strong"
              : "m-0 flex items-center gap-2 bg-mango/15 p-4 text-lg font-extrabold [&>svg]:size-5"
          }
        >
          <ShoppingBag aria-hidden="true" />
          {ui.yourOrder}
          <span className="ml-auto text-sm font-semibold">{quantityLabel}</span>
        </h2>
        {full && (
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-ink bg-white px-4 text-sm font-semibold"
            aria-pressed={translations}
            onClick={() => setTranslations(!translations)}
          >
            <Languages aria-hidden="true" className="size-4" />
            {translations ? copy.hideTranslations : copy.showTranslations}
          </button>
        )}
      </div>
      <div
        className={
          full ? "grid items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]" : undefined
        }
      >
        <div className="min-w-0">
          {lines.length === 0 ? (
            <div className="flex min-h-72 flex-col items-center justify-center px-5 py-10 text-center [&>svg]:mb-6 [&>svg]:size-20 [&>svg]:stroke-1 [&>svg]:text-food-orange-strong [&>h3]:m-0 [&>h3]:max-w-[18ch] [&>h3]:text-lg [&>h3]:leading-snug [&>h3]:font-extrabold [&>p]:text-sm [&>p]:leading-relaxed [&>p]:text-muted">
              <Soup aria-hidden="true" />
              <h3>{ui.emptyOrder}</h3>
              <p>{ui.addHint}</p>
            </div>
          ) : (
            <>
              <ol className="m-0 list-none px-4 [&>li]:border-b [&>li]:border-border-soft [&>li]:py-4 [&_h3]:m-0 [&_h3]:text-base [&_h3]:leading-snug [&_h3]:font-bold [&_p]:my-1 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-muted">
                {lines.map((line) => (
                  <li key={line.variant.id}>
                    <h3
                      lang={
                        translations && line.item.translatedName !== null
                          ? menu.targetLanguage
                          : (menu.sourceLanguage ?? "und")
                      }
                    >
                      {translations
                        ? (line.item.translatedName ?? line.item.originalName)
                        : line.item.originalName}
                    </h3>
                    {translations && line.item.translatedName !== null && (
                      <p lang={menu.sourceLanguage ?? "und"}>{line.item.originalName}</p>
                    )}
                    {line.item.variants.length > 1 && (
                      <p>
                        {translations
                          ? (line.variant.translatedLabel ?? line.variant.originalLabel)
                          : line.variant.originalLabel}
                      </p>
                    )}
                    <MenuPrice price={line.variant.price} locale={locale} rates={rates} compact />
                    <small className="text-xs text-muted">{ui.each}</small>
                    <PriceConfidenceNote
                      price={line.variant.price}
                      compact
                      inferredNote={ui.currencyInferred}
                      possibleNote={resultsCopy.pricePossibleNote}
                    />
                    {line.item.uncertainties.length > 0 && (
                      <p className="text-xs text-food-orange-strong">
                        {line.item.uncertainties.join("; ")}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        className="min-h-11 text-xs font-semibold text-brand-blue underline underline-offset-4"
                        onClick={() => onDetails(line.item.id)}
                      >
                        {ui.specialRequests}
                      </button>
                      <fieldset
                        className="inline-flex items-center rounded-xl border border-border-soft p-0 [&>button]:grid [&>button]:size-11 [&>button]:place-items-center [&>button]:border-0 [&>button]:bg-transparent [&>button]:p-0 [&_svg]:size-4 [&>output]:min-w-6 [&>output]:text-center [&>output]:font-bold"
                        aria-label={`${copy.quantity}: ${line.item.originalName}`}
                      >
                        <button
                          type="button"
                          aria-label={`${copy.remove}: ${line.item.originalName}`}
                          onClick={() =>
                            onSelection({
                              variantId: line.variantId,
                              quantity: line.quantity - 1,
                              instruction: line.instruction,
                              originalLanguageInstruction: line.originalLanguageInstruction,
                            })
                          }
                        >
                          <Minus aria-hidden="true" />
                        </button>
                        <output aria-label={copy.quantity}>{line.quantity}</output>
                        <button
                          type="button"
                          aria-label={`${copy.add}: ${line.item.originalName}`}
                          disabled={line.quantity >= 99}
                          onClick={() =>
                            onSelection({
                              variantId: line.variantId,
                              quantity: line.quantity + 1,
                              instruction: line.instruction,
                              originalLanguageInstruction: line.originalLanguageInstruction,
                            })
                          }
                        >
                          <Plus aria-hidden="true" />
                        </button>
                      </fieldset>
                    </div>
                  </li>
                ))}
              </ol>
              <div
                className={
                  full
                    ? "my-5 flex flex-wrap items-baseline justify-between gap-2 rounded-2xl border border-border-soft bg-mango/10 p-5"
                    : "flex flex-wrap items-baseline justify-between gap-2 p-4 text-sm"
                }
                aria-live="polite"
              >
                <span className="font-semibold">{copy.subtotal}</span>
                <strong className="text-xl">{total.label}</strong>
                {total.note !== null && (
                  <p className="m-0 text-sm leading-relaxed text-muted">{total.note}</p>
                )}
              </div>
              {inferred && (
                <p className="my-4 flex gap-3 rounded-2xl border border-border-soft bg-mango/10 p-4 text-sm leading-relaxed">
                  <Info aria-hidden="true" className="size-5 shrink-0 text-food-orange-strong" />
                  <span>{resultsCopy.priceInferredNote}</span>
                </p>
              )}
              {needsReview && (
                <p className="m-0 flex items-start gap-2 px-4 py-3 text-xs leading-relaxed text-muted [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
                  {copy.reviewRequired}
                </p>
              )}
              {!full && (
                <div className="px-4 pb-4">
                  {" "}
                  <button
                    type="button"
                    id={actionId}
                    className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-ink bg-food-orange-strong px-5 py-3 text-sm font-extrabold text-white shadow-[0_3px_0_var(--color-ink)] hover:bg-food-orange-dark disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={onShowWaiter}
                  >
                    {ui.viewOrder}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        {full && (
          <aside className="hidden min-w-0 rounded-2xl border border-border-soft bg-mango/5 p-3 lg:block lg:p-4">
            <h3 className="mb-4 flex items-center gap-2 text-base font-extrabold">
              <ClipboardList aria-hidden="true" className="size-5 text-food-orange-strong" />
              {ui.waiterPreview}
            </h3>
            <WaiterOrderCard
              menu={menu}
              selections={selections}
              locale={locale}
              reviewedVariantIds={reviewedVariantIds}
              showTranslations={translations}
              preview
            />
          </aside>
        )}
      </div>
      {full && (
        <details open className="my-5 border-y border-border-soft py-4">
          <summary className="min-h-11 cursor-pointer font-bold">{copy.sourceDetails}</summary>
          <div className="grid gap-4 rounded-2xl border border-border-soft p-4 sm:grid-cols-3">
            <div>
              <Camera aria-hidden="true" className="mb-2 size-5" />
              <strong className="text-sm">{ui.source}</strong>
              <p className="mt-1 text-sm text-muted">{sourceLabel}</p>
            </div>
            <div>
              <Coins aria-hidden="true" className="mb-2 size-5" />
              <strong className="text-sm">{ui.currency}</strong>
              <p className="mt-1 text-sm text-muted">
                {[
                  ...new Set(
                    lines.flatMap((line) =>
                      line.variant.price?.currency ? [line.variant.price.currency] : [],
                    ),
                  ),
                ].join(" / ") || ui.notConfirmed}
                {inferred && ui.inferred}
              </p>
            </div>
            <div>
              <ShieldCheck aria-hidden="true" className="mb-2 size-5" />
              <strong className="text-sm">{copy.ingredients}</strong>
              <p className="mt-1 text-sm text-muted">{copy.ingredientNotice}</p>
            </div>
          </div>
        </details>
      )}
      {!full && (
        <p className="m-0 flex items-start gap-2 px-4 py-3 text-xs leading-relaxed text-muted [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
          <Info aria-hidden="true" />
          {copy.ingredientNotice}
        </p>
      )}
      {full && lines.length > 0 && (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border-soft pt-5">
          {onEditOrder && (
            <button
              type="button"
              className="min-h-11 rounded-full border border-ink bg-white px-5 text-sm font-bold"
              onClick={onEditOrder}
            >
              {ui.editOrder}
            </button>
          )}{" "}
          <button
            type="button"
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-ink bg-food-orange-strong px-5 py-3 text-sm font-extrabold text-white shadow-[0_3px_0_var(--color-ink)] hover:bg-food-orange-dark disabled:cursor-not-allowed disabled:opacity-50"
            disabled={needsReview}
            onClick={onShowWaiter}
          >
            {copy.show}
          </button>
        </footer>
      )}
    </section>
  );
}
