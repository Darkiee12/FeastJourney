import { Fragment, useId, useRef, useState, type ReactNode } from "react";

import {
  menuCopy,
  menuScanResultsCopy,
  scanCurrencyCopy,
} from "@/modules/restaurant-discovery/components/menu-copy";
import { MenuItemDetail } from "@/modules/restaurant-discovery/components/menu-item-detail";
import {
  defaultVariantIdFor,
  MenuItemRow,
  rowDisplayNameFor,
} from "@/modules/restaurant-discovery/components/menu-item-row";
import { WaiterOrderCard } from "@/modules/restaurant-discovery/components/waiter-order-card";
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
  const copy = scanCurrencyCopy(locale === "vi" ? "vi" : "en");
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
  const [summaryOpen, setSummaryOpen] = useState(false);

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

  const openItem = (itemId: string): void => setExpandedId(itemId);

  const closeDetail = (itemId: string): void => {
    setExpandedId(null);
    document.getElementById(`menu-row-open-${itemId}`)?.focus();
  };

  let notice = copy.reviewedNotice;

  if (menu.provenance === "private_scan") notice = copy.privateNotice;

  if (menu.provenance === "draft") notice = copy.draftNotice;

  const sourceLanguage = menu.sourceLanguage ?? "und";

  const expandedItem =
    expandedId === null ? undefined : menu.items.find((item) => item.id === expandedId);

  const expandedSelectionId =
    expandedItem === undefined ? null : selectedVariantIdFor(expandedItem);

  const lines = orderLines(menu, currentSelections);

  const subtotal = menuSubtotal(menu, currentSelections);

  const subtotalText = MenuSubtotal.$match(subtotal, {
    Empty: () => copy.empty,
    Unavailable: () => copy.priceCheck,
    Calculable: ({ amount, currency }) =>
      `${copy.subtotal}: ${formatMoney(amount, currency, locale)} ${currency}`,
  });

  return (
    <section className="menu-order" aria-labelledby={titleId} lang={menuBcp47TagFor(locale)}>
      <h2 id={titleId} className="font-display text-3xl">
        {copy.menu}
      </h2>
      <p className="menu-order-notice">{notice}</p>
      {menu.items.length === 0 && <output>{copy.empty}</output>}
      {expandedItem !== undefined && expandedSelectionId !== null ? (
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
              onClick={() => onEditDish(expandedItem.id)}
            >
              {resultsCopy.correctDetails}
            </button>
          )}
        </>
      ) : (
        <div className="menu-board">
          {menu.items.map((item, index) => {
            const selectedId = selectedVariantIdFor(item);

            if (selectedId === null) return null;
            const previousSection = menu.items[index - 1]?.section;

            const sectionLabel =
              item.section === null || item.section === previousSection
                ? null
                : humanizeSection(item.section);

            return (
              <Fragment key={item.id}>
                {sectionLabel !== null && <h3 className="menu-order-section">{sectionLabel}</h3>}
                <ul className="menu-row-list">
                  <MenuItemRow
                    item={item}
                    locale={locale}
                    labels={{
                      add: copy.add,
                      openDetails: copy.openDetails,
                      quantity: copy.quantity,
                      priceUnknown: copy.unknownPrice,
                      uncertaintyMarker: copy.uncertainty,
                      inferredNote: resultsCopy.priceInferredNote,
                      possibleNote: resultsCopy.pricePossibleNote,
                    }}
                    rates={rates}
                    selectedVariantId={selectedId}
                    selection={currentSelections.find((entry) => entry.variantId === selectedId)}
                    sourceLanguage={menuBcp47TagFor(menu.sourceLanguage)}
                    targetLanguage={menuBcp47TagFor(menu.targetLanguage)}
                    thumbnail={
                      photoUrl === undefined
                        ? undefined
                        : item.assetIds.slice(0, 1).map((assetId) => (
                            <img
                              key={assetId}
                              src={photoUrl(assetId)}
                              alt=""
                              loading="lazy"
                              onError={(event) => {
                                event.currentTarget.style.display = "none";
                              }}
                            />
                          ))
                    }
                    onOpen={() => openItem(item.id)}
                    onSelection={changeSelection}
                  />
                </ul>
              </Fragment>
            );
          })}
        </div>
      )}
      {quantity > 0 && (
        <div className="menu-order-bar menu-order-bar-compact">
          <output aria-live="polite">
            {copy.selected}: {quantity} · {subtotalText}
          </output>
          <ConvertedSubtotal
            menu={menu}
            selections={currentSelections}
            locale={locale}
            rates={rates}
          />
          <div className="menu-order-bar-actions">
            <button
              type="button"
              aria-expanded={summaryOpen}
              onClick={() => setSummaryOpen((open) => !open)}
            >
              {summaryOpen ? copy.collapseLines : copy.expandLines}
            </button>
            <button
              type="button"
              className="menu-order-primary"
              disabled={needsReview}
              aria-describedby={needsReview ? `${titleId}-review` : undefined}
              onClick={() => dialog.current?.showModal()}
            >
              {copy.show}
            </button>
          </div>
          {needsReview && <output id={`${titleId}-review`}>{copy.reviewRequired}</output>}
          {summaryOpen && (
            <ul className="menu-order-lines">
              {lines.map((line) => (
                <li key={line.variant.id}>
                  <span lang={sourceLanguage}>
                    {line.quantity}× {line.item.originalName} — {line.variant.originalLabel}
                  </span>
                  <span className="menu-order-lines-qty">
                    <button
                      type="button"
                      aria-label={`${copy.remove}: ${rowDisplayNameFor(line.item)}`}
                      disabled={line.quantity <= 1}
                      onClick={() =>
                        changeSelection({ ...line, quantity: Math.max(1, line.quantity - 1) })
                      }
                    >
                      −
                    </button>
                    <output aria-label={copy.quantity}>{line.quantity}</output>
                    <button
                      type="button"
                      aria-label={`${copy.add}: ${rowDisplayNameFor(line.item)}`}
                      disabled={line.quantity >= 99}
                      onClick={() =>
                        changeSelection({ ...line, quantity: Math.min(99, line.quantity + 1) })
                      }
                    >
                      +
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <dialog ref={dialog} className="menu-waiter-dialog" aria-label={copy.orderTitle}>
        <form method="dialog">
          <button type="submit" className="menu-order-back">
            {copy.back}
          </button>
        </form>
        <WaiterOrderCard menu={menu} selections={currentSelections} locale={locale} />
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
