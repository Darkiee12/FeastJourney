import { Fragment, useId, useRef, useState } from "react";

import { ObservedPrice } from "@/modules/restaurant-discovery/components/currency-tools";
import { menuCopy } from "@/modules/restaurant-discovery/components/menu-copy";
import { WaiterOrderCard } from "@/modules/restaurant-discovery/components/waiter-order-card";
import type {
  InteractiveMenu,
  MenuSelection,
} from "@/modules/restaurant-discovery/menu-presentation";
import { menuBcp47TagFor } from "@/modules/restaurant-discovery/menu-presentation";
import { isAmount, isCurrency, type ExchangeRate } from "@/shared/money";

type MenuItem = InteractiveMenu["items"][number];

const humanizeSection = (section: string): string =>
  section.replaceAll("-", " ").replaceAll("_", " ");

function MenuItemCard({
  item,
  menu,
  locale,
  selectedId,
  selection,
  reviewed,
  onVariant,
  onSelection,
  onReview,
  photoUrl,
  rates,
}: {
  readonly item: MenuItem;
  readonly menu: InteractiveMenu;
  readonly locale: string;
  readonly selectedId: string;
  readonly selection: MenuSelection | undefined;
  readonly reviewed: boolean;
  readonly onVariant: (id: string) => void;
  readonly onSelection: (selection: MenuSelection) => void;
  readonly onReview: (reviewed: boolean) => void;
  readonly photoUrl: ((assetId: string) => string) | undefined;
  readonly rates: ReadonlyMap<string, ExchangeRate> | undefined;
}) {
  const copy = menuCopy(locale);
  const variant = item.variants.find((entry) => entry.id === selectedId);
  const quantity = selection?.quantity ?? 0;
  const sourceLanguage = menu.sourceLanguage ?? "und";

  if (variant === undefined) return null;

  const changeQuantity = (next: number): void =>
    onSelection({
      variantId: variant.id,
      quantity: next,
      instruction: selection?.instruction ?? "",
      originalLanguageInstruction: selection?.originalLanguageInstruction ?? "",
    });

  const price = variant.price;

  const knownPrice =
    price !== null &&
    price.amount !== null &&
    price.currency !== null &&
    isAmount(price.amount) &&
    isCurrency(price.currency);

  return (
    <article className="menu-order-item">
      <h3 lang={sourceLanguage}>{item.originalName}</h3>
      {item.translatedName !== null && (
        <p className="menu-order-translation" lang={menu.targetLanguage}>
          {item.translatedName}
        </p>
      )}
      {item.translatedDescription !== null && (
        <p lang={menu.targetLanguage}>{item.translatedDescription}</p>
      )}
      {item.originalDescription !== null && (
        <details>
          <summary>{copy.originalDescription}</summary>
          <p lang={sourceLanguage}>{item.originalDescription}</p>
        </details>
      )}
      {item.explanatorySummary !== null && (
        <details>
          <summary>{copy.explanation}</summary>
          <p lang={menu.targetLanguage}>{item.explanatorySummary}</p>
        </details>
      )}
      <label htmlFor={`menu-variant-${item.id}`}>{copy.variant}</label>
      <select
        id={`menu-variant-${item.id}`}
        value={variant.id}
        onChange={(event) => onVariant(event.target.value)}
        lang={sourceLanguage}
      >
        {item.variants.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.originalLabel === "" ? copy.asListed : entry.originalLabel}
            {entry.translatedLabel === null ? "" : ` / ${entry.translatedLabel}`}
          </option>
        ))}
      </select>
      {knownPrice ? (
        <ObservedPrice
          amount={price.amount}
          currency={price.currency}
          locale={locale}
          rate={rates?.get(price.currency)}
        />
      ) : (
        <p className="menu-order-price">{copy.unknownPrice}</p>
      )}
      {!knownPrice && price !== null && price.rawText !== "" && (
        <p>
          {price.rawText} · {copy.unknownCurrency}
        </p>
      )}
      <p className="menu-order-source">{variant.provenance}</p>
      {variant.sourceUrl !== undefined && variant.sourceUrl !== null && (
        <a href={variant.sourceUrl} target="_blank" rel="noreferrer">
          {copy.priceSource}
        </a>
      )}
      {item.dishId !== null && (
        <a href={`/dishes/${encodeURIComponent(item.dishId)}?lang=${encodeURIComponent(locale)}`}>
          {copy.exploreDish}
        </a>
      )}
      {item.ingredients !== undefined &&
        item.ingredients !== null &&
        item.ingredients.length > 0 && (
          <details>
            <summary>{copy.ingredients}</summary>
            <p>{copy.ingredientNotice}</p>
            {(["printed", "inferred"] as const).map((evidence) => {
              const ingredients =
                item.ingredients?.filter((ingredient) => ingredient.evidence === evidence) ?? [];

              if (ingredients.length === 0) return null;

              return (
                <div key={evidence}>
                  <h4>
                    {evidence === "printed" ? copy.printedIngredients : copy.inferredIngredients}
                  </h4>
                  <ul>
                    {ingredients.map((ingredient) => (
                      <li key={`${evidence}:${ingredient.originalText}`}>
                        <span lang={sourceLanguage}>{ingredient.originalText}</span>
                        {ingredient.translatedText !== null && (
                          <span lang={menu.targetLanguage}> / {ingredient.translatedText}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </details>
        )}
      {item.uncertainties.length > 0 && (
        <p className="menu-order-check">
          {copy.uncertainty}: {item.uncertainties.join("; ")}
        </p>
      )}
      <fieldset
        className="menu-order-quantity"
        aria-label={`${copy.quantity}: ${item.originalName}, ${variant.originalLabel}`}
      >
        <button
          type="button"
          aria-label={`${copy.remove}: ${item.originalName}`}
          disabled={quantity === 0}
          onClick={() => changeQuantity(quantity - 1)}
        >
          −
        </button>
        <output aria-live="polite" aria-label={copy.quantity}>
          {quantity}
        </output>
        <button
          type="button"
          aria-label={`${copy.add}: ${item.originalName}`}
          disabled={quantity >= 99}
          onClick={() => changeQuantity(quantity + 1)}
        >
          +
        </button>
      </fieldset>
      {quantity > 0 && selection !== undefined && (
        <details className="menu-order-instructions">
          <summary>{copy.instructions}</summary>
          <p id={`instruction-help-${variant.id}`}>{copy.instructionHelp}</p>
          <label htmlFor={`instruction-${variant.id}`}>{copy.enteredInstruction}</label>
          <textarea
            id={`instruction-${variant.id}`}
            maxLength={500}
            value={selection.instruction}
            lang={menu.targetLanguage}
            aria-describedby={`instruction-help-${variant.id}`}
            onChange={(event) => {
              onSelection({ ...selection, instruction: event.target.value });
              onReview(false);
            }}
          />
          <label htmlFor={`waiter-instruction-${variant.id}`}>{copy.waiterInstruction}</label>
          <textarea
            id={`waiter-instruction-${variant.id}`}
            maxLength={500}
            value={selection.originalLanguageInstruction}
            lang={sourceLanguage}
            onChange={(event) => {
              onSelection({ ...selection, originalLanguageInstruction: event.target.value });
              onReview(false);
            }}
          />
          <label className="menu-order-consent">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => onReview(event.target.checked)}
            />
            {copy.reviewedInstructions}
          </label>
        </details>
      )}
      {photoUrl !== undefined && item.assetIds.length > 0 && (
        <div className="menu-order-photos">
          {item.assetIds.map((assetId, index) => (
            <a key={assetId} href={photoUrl(assetId)} target="_blank" rel="noreferrer">
              {copy.photo} {index + 1}
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

export function InteractiveMenuView({
  menu,
  locale,
  photoUrl,
  initialVariant,
  rates,
}: {
  readonly menu: InteractiveMenu;
  readonly locale: string;
  readonly photoUrl?: (assetId: string) => string;
  readonly initialVariant?: string;
  readonly rates?: ReadonlyMap<string, ExchangeRate>;
}) {
  const copy = menuCopy(locale);
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);

  const [activeVariants, setActiveVariants] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  const [selections, setSelections] = useState<ReadonlyArray<MenuSelection>>([]);
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(() => new Set());

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

  let notice = copy.reviewedNotice;

  if (menu.provenance === "private_scan") notice = copy.privateNotice;

  if (menu.provenance === "draft") notice = copy.draftNotice;

  return (
    <section className="menu-order" aria-labelledby={titleId} lang={menuBcp47TagFor(locale)}>
      <h2 id={titleId} className="font-display text-3xl">
        {copy.menu}
      </h2>
      <p className="menu-order-notice">{notice}</p>
      {menu.items.length === 0 && <output>{copy.empty}</output>}
      <div className="menu-order-list">
        {menu.items.map((item, index) => {
          const initial =
            item.variants.find((variant) => variant.id === initialVariant) ?? item.variants[0];

          if (initial === undefined) return null;
          const activeId = activeVariants.get(item.id);

          const selectedId =
            item.variants.find((variant) => variant.id === activeId)?.id ?? initial.id;

          const previousSection = menu.items[index - 1]?.section;

          const sectionLabel =
            item.section === null || item.section === previousSection
              ? null
              : humanizeSection(item.section);

          return (
            <Fragment key={item.id}>
              {sectionLabel !== null && <h3 className="menu-order-section">{sectionLabel}</h3>}
              <MenuItemCard
                key={item.id}
                item={item}
                menu={menu}
                locale={locale}
                selectedId={selectedId}
                selection={currentSelections.find((entry) => entry.variantId === selectedId)}
                reviewed={reviewed.has(selectedId)}
                photoUrl={photoUrl}
                rates={rates}
                onVariant={(id) =>
                  setActiveVariants((previous) => new Map([...previous, [item.id, id]]))
                }
                onSelection={changeSelection}
                onReview={(accepted) =>
                  setReviewed((previous) => {
                    const next = new Set(previous);

                    if (accepted) next.add(selectedId);
                    else next.delete(selectedId);

                    return next;
                  })
                }
              />
            </Fragment>
          );
        })}
      </div>
      <div className="menu-order-bar">
        <output aria-live="polite">
          {copy.selected}: {quantity}
        </output>
        <button
          type="button"
          className="menu-order-primary"
          disabled={quantity === 0 || needsReview}
          aria-describedby={needsReview ? `${titleId}-review` : undefined}
          onClick={() => dialog.current?.showModal()}
        >
          {copy.show}
        </button>
        {needsReview && <output id={`${titleId}-review`}>{copy.reviewRequired}</output>}
      </div>
      <dialog ref={dialog} className="menu-waiter-dialog" aria-label={copy.orderTitle}>
        <form method="dialog">
          <button type="submit" className="menu-order-back">
            {copy.back}
          </button>
        </form>
        <WaiterOrderCard menu={menu} selections={currentSelections} locale={locale} />
      </dialog>
    </section>
  );
}
