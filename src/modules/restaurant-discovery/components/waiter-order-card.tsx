import { useId } from "react";

import { menuCopy, orderIntroductions } from "@/modules/restaurant-discovery/components/menu-copy";
import {
  MenuSubtotal,
  menuSubtotal,
  orderLines,
} from "@/modules/restaurant-discovery/menu-presentation";
import type {
  InteractiveMenu,
  MenuSelection,
} from "@/modules/restaurant-discovery/menu-presentation";
import { formatMoney, isCurrency } from "@/shared/money";

export function WaiterOrderCard({
  menu,
  selections,
  locale,
}: {
  readonly menu: InteractiveMenu;
  readonly selections: ReadonlyArray<MenuSelection>;
  readonly locale: string;
}) {
  const titleId = useId();
  const copy = menuCopy(locale);
  const sourceLanguage = menu.sourceLanguage ?? "und";
  const originalIntroduction = menu.introduction.original ?? orderIntroductions.get(sourceLanguage);

  const translatedIntroduction =
    menu.introduction.translated ?? orderIntroductions.get(menu.targetLanguage);

  const lines = orderLines(menu, selections);
  const subtotal = menuSubtotal(menu, selections);

  const subtotalText = MenuSubtotal.$match(subtotal, {
    Empty: () => copy.empty,
    Unavailable: () => copy.priceCheck,
    Calculable: ({ amount, currency }) =>
      `${copy.subtotal}: ${formatMoney(amount, currency, locale)} ${currency}`,
  });

  return (
    <section className="waiter-card" aria-labelledby={titleId} lang={locale === "vi" ? "vi" : "en"}>
      <header>
        <h2 id={titleId}>{copy.orderTitle}</h2>
        {menu.venueName !== null && <p className="waiter-venue">{menu.venueName}</p>}
        <p className="waiter-status">{copy.notSubmitted}</p>
        {originalIntroduction !== undefined && (
          <p className="waiter-introduction" lang={sourceLanguage}>
            {originalIntroduction}
          </p>
        )}
        {translatedIntroduction !== undefined && (
          <p lang={menu.targetLanguage}>{translatedIntroduction}</p>
        )}
        {menu.sourceLanguage === null && <p>{copy.unknownLanguage}</p>}
      </header>
      <ol className="waiter-lines">
        {lines.map((line) => {
          const price = line.variant.price;

          return (
            <li key={line.variant.id}>
              <div className="waiter-dish">
                <strong
                  className="waiter-quantity"
                  aria-label={`${copy.quantity}: ${line.quantity}`}
                >
                  {line.quantity} ×
                </strong>
                <div>
                  <h3 lang={sourceLanguage}>{line.item.originalName}</h3>
                  <p className="waiter-variant" lang={sourceLanguage}>
                    {line.variant.originalLabel}
                  </p>
                </div>
              </div>
              {line.item.translatedName !== null && (
                <p className="waiter-translation" lang={menu.targetLanguage}>
                  {line.item.translatedName}
                </p>
              )}
              {line.variant.translatedLabel !== null && (
                <p className="waiter-translation" lang={menu.targetLanguage}>
                  {line.variant.translatedLabel}
                </p>
              )}
              {line.originalLanguageInstruction !== "" && (
                <p className="waiter-instruction" lang={sourceLanguage}>
                  {line.originalLanguageInstruction}
                </p>
              )}
              {line.instruction !== "" && (
                <p className="waiter-translation" lang={menu.targetLanguage}>
                  {line.instruction}
                </p>
              )}
              {line.lineAmount !== null &&
              price !== null &&
              price.currency !== null &&
              isCurrency(price.currency) ? (
                <p className="waiter-price">
                  {copy.linePrice}: {formatMoney(line.lineAmount, price.currency, locale)}{" "}
                  <span>{price.currency}</span>
                </p>
              ) : (
                <p className="waiter-price">{copy.unknownPrice}</p>
              )}
              {line.item.uncertainties.length > 0 && (
                <p className="waiter-check">
                  {copy.uncertainty}: {line.item.uncertainties.join("; ")}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <footer>
        <p className="waiter-subtotal">{subtotalText}</p>
        <p>{copy.fees}</p>
        {menu.provenance === "private_scan" && <p>{copy.privateOrder}</p>}
        {menu.provenance === "draft" && <p>{copy.draftOrder}</p>}
      </footer>
    </section>
  );
}
