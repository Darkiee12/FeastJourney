import { ShoppingBag, Soup } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

import {
  menuResultsCopy,
  menuResultsCount,
  menuCopy,
  menuScanResultsCopy,
  scanCurrencyCopy,
} from "@/modules/restaurant-discovery/components/menu-copy";
import { MenuItemDetail } from "@/modules/restaurant-discovery/components/menu-item-detail";
import {
  defaultVariantIdFor,
  MenuItemRow,
} from "@/modules/restaurant-discovery/components/menu-item-row";
import { MenuOrderReview } from "@/modules/restaurant-discovery/components/menu-order-review";
import { WaiterOrderCard } from "@/modules/restaurant-discovery/components/waiter-order-card";
import {
  menuBcp47TagFor,
  MenuSubtotal,
  menuSubtotal,
} from "@/modules/restaurant-discovery/menu-presentation";
import type {
  InteractiveMenu,
  MenuSelection,
} from "@/modules/restaurant-discovery/menu-presentation";
import { convertAmount, formatMoney, isCurrency } from "@/shared/money";
import type { ExchangeRate } from "@/shared/money";

type MenuItem = InteractiveMenu["items"][number];

const humanizeSection = (section: string): string =>
  section.replaceAll("-", " ").replaceAll("_", " ");

/**
 * Approximate converted subtotal for the compact summary and waiter dialog.
 * Original totals stay primary inside the waiter card; this line is the
 * informational equivalent only, marked approximate with the reference
 * rate date. Unknown, mixed, or ambiguous prices keep the existing
 * incomplete-total behavior — never a misleading complete total.
 */
function ConvertedSubtotal({
  menu,
  selections,
  locale,
  rates,
}: {
  readonly menu: InteractiveMenu;
  readonly selections: ReadonlyArray<MenuSelection>;
  readonly locale: string;
  readonly rates: ReadonlyMap<string, ExchangeRate> | undefined;
}): ReactNode {
  const copy = scanCurrencyCopy(locale);
  const subtotal = menuSubtotal(menu, selections);

  return MenuSubtotal.$match(subtotal, {
    Empty: () => null,
    Unavailable: () => null,
    Calculable: ({ amount, currency }) => {
      const rate = rates?.get(currency);

      if (rate === undefined || rate.quote === currency || !isCurrency(rate.quote)) return null;

      const converted = convertAmount(amount, currency, rate.quote, rate);

      return (
        <p
          className="menu-order-converted"
          title={`${copy.approximateConversion}: ${rate.effectiveDate} · ${rate.provider}`}
        >
          ≈ {formatMoney(converted, rate.quote, locale)} {rate.quote} · {copy.approximateConversion}
        </p>
      );
    },
  });
}

export function InteractiveMenuView({
  menu,
  locale,
  photoUrl,
  initialVariant,
  rates,
  onEditDish,
}: {
  readonly menu: InteractiveMenu;
  readonly locale: string;
  readonly photoUrl?: (assetId: string) => string;
  readonly initialVariant?: string;
  readonly rates?: ReadonlyMap<string, ExchangeRate>;
  readonly onEditDish?: ((itemKey: string) => void) | undefined;
}) {
  const ui = menuResultsCopy(locale);
  const scan = menu.provenance === "private_scan";
  const copy = menuCopy(locale);
  const resultsCopy = menuScanResultsCopy(locale);
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);

  const [activeVariants, setActiveVariants] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  const [selections, setSelections] = useState<ReadonlyArray<MenuSelection>>([]);
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [section, setSection] = useState<string | null>(null);
  const detailDialog = useRef<HTMLDialogElement>(null);
  const reviewDialog = useRef<HTMLDialogElement>(null);

  const restoreOrderFocus = (): void => {
    for (const id of [`${titleId}-mobile-order`, `${titleId}-desktop-order`]) {
      const trigger = document.getElementById(id);

      if (trigger !== null && trigger.getClientRects().length > 0) {
        trigger.focus({ preventScroll: true });

        return;
      }
    }
  };

  const availableIds = new Set(
    menu.items.flatMap((item) => item.variants.map((variant) => variant.id)),
  );

  const currentSelections = selections.flatMap((selection) =>
    availableIds.has(selection.variantId) ? [selection] : [],
  );

  const quantity = currentSelections.reduce((total, selection) => total + selection.quantity, 0);

  const needsReview = currentSelections.some((selection) => {
    if (selection.instruction.trim() === "" && selection.originalLanguageInstruction.trim() === "")
      return false;

    return (
      selection.instruction.trim() === "" ||
      selection.originalLanguageInstruction.trim() === "" ||
      !reviewed.has(selection.variantId)
    );
  });

  const changeSelection = (next: MenuSelection): void =>
    setSelections((previous) => {
      const rest = previous.filter((selection) => selection.variantId !== next.variantId);

      return next.quantity === 0 ? rest : [...rest, next];
    });

  const selectedVariantIdFor = (item: MenuItem): string | null => {
    const activeId = activeVariants.get(item.id);

    if (activeId !== undefined && item.variants.some((variant) => variant.id === activeId))
      return activeId;

    const initial = item.variants.find((variant) => variant.id === initialVariant);

    if (initial !== undefined) return initial.id;

    return defaultVariantIdFor(item);
  };

  const openItem = (itemId: string): void => {
    setExpandedId(itemId);
    detailDialog.current?.showModal();
  };

  const closeDetail = (itemId: string): void => {
    detailDialog.current?.close();
    setExpandedId(null);
    document.getElementById(`menu-row-open-${itemId}`)?.focus();
  };

  let notice = copy.reviewedNotice;

  if (menu.provenance === "private_scan") notice = copy.privateNotice;

  if (menu.provenance === "draft") notice = copy.draftNotice;

  const expandedItem =
    expandedId === null ? undefined : menu.items.find((item) => item.id === expandedId);

  const expandedSelectionId =
    expandedItem === undefined ? null : selectedVariantIdFor(expandedItem);

  const subtotal = menuSubtotal(menu, currentSelections);

  const subtotalText = MenuSubtotal.$match(subtotal, {
    Empty: () => copy.empty,
    Unavailable: () => ui.totalToConfirm,
    Calculable: ({ amount, currency }) => formatMoney(amount, currency, locale),
  });

  return (
    <section
      className={menu.provenance === "private_scan" ? "min-w-0 break-words text-ink" : "menu-order"}
      aria-labelledby={titleId}
      lang={menuBcp47TagFor(locale)}
    >
      <h2 id={titleId} className={scan ? "sr-only" : "font-display text-3xl"}>
        {copy.menu}
      </h2>
      <p className="mb-4 text-xs leading-relaxed text-muted">{notice}</p>
      {menu.items.length === 0 && <output>{copy.empty}</output>}
      <dialog
        ref={detailDialog}
        className="menu-waiter-dialog"
        aria-label={copy.openDetails}
        onClose={() => setExpandedId(null)}
      >
        {expandedItem !== undefined && expandedSelectionId !== null && (
          <>
            <MenuItemDetail
              item={expandedItem}
              locale={locale}
              labels={{
                back: copy.back,
                variant: copy.variant,
                asListed: copy.asListed,
                quantity: copy.quantity,
                add: copy.add,
                remove: copy.remove,
                addToOrder: copy.addToOrder,
                unknownPrice: copy.unknownPrice,
                unknownCurrency: copy.unknownCurrency,
                priceSource: copy.priceSource,
                exploreDish: copy.exploreDish,
                photo: copy.photo,
                ingredients: copy.ingredients,
                ingredientNotice: copy.ingredientNotice,
                printedIngredients: copy.printedIngredients,
                inferredIngredients: copy.inferredIngredients,
                explanation: copy.explanation,
                originalDescription: copy.originalDescription,
                uncertainty: copy.uncertainty,
                instructions: copy.instructions,
                enteredInstruction: copy.enteredInstruction,
                waiterInstruction: copy.waiterInstruction,
                instructionHelp: copy.instructionHelp,
                reviewedInstructions: copy.reviewedInstructions,
                inferredNote: resultsCopy.priceInferredNote,
                possibleNote: resultsCopy.pricePossibleNote,
              }}
              rates={rates}
              activeVariantId={expandedSelectionId}
              selection={currentSelections.find((entry) => entry.variantId === expandedSelectionId)}
              reviewed={reviewed.has(expandedSelectionId)}
              sourceLanguage={menuBcp47TagFor(menu.sourceLanguage)}
              targetLanguage={menuBcp47TagFor(menu.targetLanguage)}
              notice={notice}
              photoUrl={photoUrl}
              onBack={() => closeDetail(expandedItem.id)}
              onVariant={(id) =>
                setActiveVariants((previous) => new Map([...previous, [expandedItem.id, id]]))
              }
              onSelection={changeSelection}
              onReview={(accepted) =>
                setReviewed((previous) => {
                  const next = new Set(previous);

                  if (accepted) next.add(expandedSelectionId);
                  else next.delete(expandedSelectionId);

                  return next;
                })
              }
            />
            {onEditDish !== undefined && (
              <button
                type="button"
                className="menu-results-edit"
                onClick={() => {
                  detailDialog.current?.close();
                  onEditDish(expandedItem.id);
                }}
              >
                {resultsCopy.correctDetails}
              </button>
            )}
          </>
        )}
      </dialog>
      {menu.items.length > 0 && (
        <nav className="mb-5 flex flex-wrap gap-2" aria-label={ui.categories}>
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border-soft bg-white px-4 py-2 text-sm font-bold aria-pressed:border-food-orange-dark aria-pressed:bg-food-orange-strong aria-pressed:text-white [&_svg]:size-4"
            aria-pressed={section === null}
            onClick={() => setSection(null)}
          >
            <Soup aria-hidden="true" />
            {ui.allDishes} <span>({menu.items.length})</span>
          </button>
          {[
            ...new Set(menu.items.flatMap((item) => (item.section === null ? [] : [item.section]))),
          ].map((label) => (
            <button
              type="button"
              key={label}
              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border-soft bg-white px-4 py-2 text-sm font-bold aria-pressed:border-food-orange-dark aria-pressed:bg-food-orange-strong aria-pressed:text-white"
              aria-pressed={section === label}
              onClick={() => setSection(label)}
            >
              {humanizeSection(label)}{" "}
              <span>({menu.items.filter((item) => item.section === label).length})</span>
            </button>
          ))}
        </nav>
      )}
      <div
        className={
          scan
            ? "grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]"
            : "grid min-w-0 items-start gap-5"
        }
      >
        <div className="grid min-w-0 gap-4">
          {[...new Set(menu.items.map((item) => item.section))].flatMap((label) => {
            if (section !== null && label !== section) return [];

            const items = menu.items.filter((item) => item.section === label);

            let sectionTitle = ui.dishes;

            if (label !== null) sectionTitle = humanizeSection(label);

            return [
              <section
                className="min-w-0 overflow-hidden rounded-2xl border border-border-soft bg-white px-3 sm:px-5"
                key={label ?? "unsectioned"}
              >
                <h3 className="m-0 flex items-center gap-2 border-b border-border-soft py-5 text-lg font-extrabold sm:text-xl">
                  <Soup aria-hidden="true" className="size-6 shrink-0 text-food-orange-strong" />
                  {sectionTitle}
                  <span className="rounded-full bg-mango/20 px-2 py-1 text-xs font-semibold whitespace-nowrap">
                    {menuResultsCount(locale, "dishes", items.length)}
                  </span>
                </h3>
                <ul className="m-0 grid min-w-0 list-none gap-0 p-0">
                  {items.map((item) => {
                    const selectedId = selectedVariantIdFor(item);

                    if (selectedId === null) return null;

                    return (
                      <MenuItemRow
                        key={item.id}
                        presentation={scan ? "scan" : "standard"}
                        item={item}
                        locale={locale}
                        labels={{
                          add: copy.add,
                          openDetails: copy.openDetails,
                          quantity: copy.quantity,
                          priceUnknown: copy.unknownPrice,
                          uncertaintyMarker: copy.uncertainty,
                          inferredNote: ui.currencyInferred,
                          possibleNote: resultsCopy.pricePossibleNote,
                        }}
                        rates={rates}
                        selectedVariantId={selectedId}
                        selection={currentSelections.find(
                          (entry) => entry.variantId === selectedId,
                        )}
                        sourceLanguage={menuBcp47TagFor(menu.sourceLanguage)}
                        targetLanguage={menuBcp47TagFor(menu.targetLanguage)}
                        onOpen={() => openItem(item.id)}
                        onEdit={onEditDish === undefined ? undefined : () => onEditDish(item.id)}
                        onSelection={changeSelection}
                      />
                    );
                  })}
                </ul>
              </section>,
            ];
          })}
        </div>
        {menu.provenance === "private_scan" && (
          <aside className="sticky top-24 hidden max-h-[calc(100dvh-7rem)] min-w-0 overflow-y-auto rounded-2xl border border-border-soft bg-white lg:block">
            <MenuOrderReview
              actionId={`${titleId}-desktop-order`}
              menu={menu}
              selections={currentSelections}
              locale={locale}
              rates={rates}
              needsReview={needsReview}
              onSelection={changeSelection}
              onDetails={openItem}
              onShowWaiter={() => reviewDialog.current?.showModal()}
            />
          </aside>
        )}
      </div>
      {(quantity > 0 || menu.provenance === "private_scan") && (
        <div
          className={
            scan
              ? "fixed right-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 z-20 mx-auto flex max-w-xl items-center justify-between gap-3 rounded-2xl border border-ink bg-ink p-3 text-white shadow-lg lg:hidden"
              : "menu-order-bar"
          }
        >
          <output
            aria-live="polite"
            className="flex min-w-0 items-center gap-2 text-xs font-bold [&>svg]:size-5 [&>svg]:shrink-0 [&_small]:mt-1 [&_small]:block [&_small]:font-normal"
          >
            <ShoppingBag aria-hidden="true" />
            <span>
              {menuResultsCount(locale, "items", quantity)}
              {quantity > 0 && <small>{subtotalText}</small>}
            </span>
          </output>
          <button
            type="button"
            id={`${titleId}-mobile-order`}
            className="min-h-11 shrink-0 rounded-full border border-food-orange-dark bg-food-orange-strong px-4 py-2 text-sm font-bold text-white hover:bg-food-orange-dark"
            onClick={() => reviewDialog.current?.showModal()}
          >
            {ui.viewOrder}
          </button>
        </div>
      )}
      <dialog
        ref={reviewDialog}
        className="fixed inset-x-0 bottom-0 m-0 max-h-[90dvh] w-full max-w-none overflow-y-auto overscroll-contain rounded-t-3xl border border-border-soft bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-ink shadow-xl backdrop:bg-ink/60 sm:inset-0 sm:m-auto sm:w-[calc(100%-2rem)] sm:max-w-5xl sm:rounded-3xl sm:p-6"
        aria-label={copy.orderTitle}
        onClose={() => {
          if (!dialog.current?.open) restoreOrderFocus();
        }}
      >
        <form method="dialog">
          <button className="mb-4 min-h-11 rounded-lg border border-ink bg-white px-4 text-sm font-semibold">
            {ui.close}
          </button>
        </form>
        <MenuOrderReview
          full
          reviewedVariantIds={reviewed}
          onEditOrder={() => reviewDialog.current?.close()}
          menu={menu}
          selections={currentSelections}
          locale={locale}
          rates={rates}
          needsReview={needsReview}
          onSelection={changeSelection}
          onDetails={(itemId) => {
            reviewDialog.current?.close();
            openItem(itemId);
          }}
          onShowWaiter={() => {
            reviewDialog.current?.close();
            dialog.current?.showModal();
          }}
        />
      </dialog>
      <dialog
        ref={dialog}
        className="menu-waiter-dialog"
        aria-label={copy.orderTitle}
        onClose={restoreOrderFocus}
      >
        <form method="dialog">
          <button type="submit" className="menu-order-back">
            {copy.back}
          </button>
        </form>
        <WaiterOrderCard
          menu={menu}
          selections={currentSelections}
          locale={locale}
          reviewedVariantIds={reviewed}
          preview
        />
        <ConvertedSubtotal
          menu={menu}
          selections={currentSelections}
          locale={locale}
          rates={rates}
        />
      </dialog>
    </section>
  );
}
