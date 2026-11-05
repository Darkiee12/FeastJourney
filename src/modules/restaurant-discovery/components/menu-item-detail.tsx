import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Info,
  Minus,
  Plus,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { SharedSelect } from "@/components/ui/select";
import { menuScanResultsCopy } from "@/modules/restaurant-discovery/components/menu-copy";
import {
  canonicalDishHrefFor,
  MenuPrice,
  PriceConfidenceNote,
  type MenuRowItem,
} from "@/modules/restaurant-discovery/components/menu-item-row";
import type { MenuSelection } from "@/modules/restaurant-discovery/menu-presentation";
import { isAmount, isCurrency, type ExchangeRate } from "@/shared/money";

/**
 * Focused dish detail: the only place for full description, portion
 * selector, source/provenance, ingredients, warnings, AI-label, photo and
 * canonical dish links, instructions and consent. Never rendered inside
 * rows. Quantity writes go through the SAME `MenuSelection` channel as the
 * shared selection controller (coordinator-owned interactive-menu): this
 * component constructs `{variantId, quantity, instruction,
 * originalLanguageInstruction}` exactly like MenuItemCard, changing only
 * presentation.
 */
export interface MenuDetailLabels {
  readonly back: string;
  readonly variant: string;
  readonly asListed: string;
  readonly quantity: string;
  readonly add: string;
  readonly remove: string;
  readonly addToOrder: string;
  readonly unknownPrice: string;
  readonly unknownCurrency: string;
  readonly priceSource: string;
  readonly exploreDish: string;
  readonly photo: string;
  readonly ingredients: string;
  readonly ingredientNotice: string;
  readonly printedIngredients: string;
  readonly inferredIngredients: string;
  readonly explanation: string;
  readonly originalDescription: string;
  readonly uncertainty: string;
  readonly instructions: string;
  readonly enteredInstruction: string;
  readonly waiterInstruction: string;
  readonly instructionHelp: string;
  readonly reviewedInstructions: string;
  readonly inferredNote?: string | undefined;
  readonly possibleNote?: string | undefined;
}

/**
 * Accessible in-place photo viewer for menu evidence. Same-origin private
 * URLs keep authorized access (cookies ride the request); no forced new
 * tab. Native dialog owns Escape + focus return; zoom is explicit
 * step buttons (100–300%) with a plain text level, honoring reduced
 * motion (no transitions). One viewer instance per mount. Triggers render
 * real 72px photographic thumbnails (never a bare "Open photo N" box);
 * the images are decorative (empty alt) with the page label kept as the
 * accessible name, and menu scans are only ever labeled menu photos —
 * never dish photos.
 */
export function MenuPhotoViewer({
  photos,
  photoUrl,
  locale,
  presentation = "compact",
}: {
  readonly photos: ReadonlyArray<{ readonly assetId: string; readonly page: number }>;
  readonly photoUrl: (assetId: string) => string;
  readonly locale: string;
  readonly presentation?: "compact" | "overview";
}): ReactNode {
  const copy = menuScanResultsCopy(locale);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  const open = photos.find((photo) => photo.assetId === openId) ?? null;

  const inspect = (assetId: string): void => {
    setZoom(1);
    setOpenId(assetId);
  };

  useEffect(() => {
    if (open !== null) {
      dialogRef.current?.showModal();
      closeRef.current?.focus();
    }
  }, [open]);

  const close = (): void => {
    dialogRef.current?.close();
    setOpenId(null);
  };

  const zoomIn = (): void => setZoom((level) => Math.min(3, Math.round((level + 0.5) * 10) / 10));

  const zoomOut = (): void => setZoom((level) => Math.max(1, Math.round((level - 0.5) * 10) / 10));

  if (photos.length === 0) return null;

  return (
    <span
      className={
        presentation === "overview"
          ? "flex min-w-0 snap-x snap-mandatory gap-3 overflow-x-auto rounded-2xl"
          : "menu-detail-photos"
      }
    >
      {photos.map((photo) => (
        <button
          key={photo.assetId}
          type="button"
          className={
            presentation === "overview"
              ? "relative block min-w-0 shrink-0 basis-full snap-start overflow-hidden rounded-2xl border-0 bg-cream p-0 text-left text-sm text-ink focus-visible:outline-2 focus-visible:outline-brand-blue"
              : "menu-detail-photo-open"
          }
          onClick={() => inspect(photo.assetId)}
          aria-label={copy.photoOpen.replace("{n}", String(photo.page))}
        >
          <img
            src={photoUrl(photo.assetId)}
            alt=""
            loading="lazy"
            width={72}
            height={72}
            className={
              presentation === "overview"
                ? "block h-44 w-full object-cover md:h-72"
                : "menu-photo-thumb"
            }
          />
          <span
            className={
              presentation === "overview"
                ? "absolute bottom-3 left-3 rounded-lg bg-ink/90 px-2 py-1 text-xs font-semibold text-white"
                : undefined
            }
          >
            {copy.photoOpen.replace("{n}", String(photo.page))}
          </span>
        </button>
      ))}
      {open === null ? null : (
        <dialog
          ref={dialogRef}
          className="menu-photo-dialog"
          aria-label={copy.photoOpen.replace("{n}", String(open.page))}
          onClose={close}
        >
          <div className="menu-photo-zoombar">
            <button type="button" onClick={zoomOut} disabled={zoom <= 1} aria-label={copy.zoomOut}>
              <ZoomOut aria-hidden="true" />
            </button>
            <output>{copy.zoomLevel.replace("{percent}", String(Math.round(zoom * 100)))}</output>
            <button type="button" onClick={zoomIn} disabled={zoom >= 3} aria-label={copy.zoomIn}>
              <ZoomIn aria-hidden="true" />
            </button>
          </div>
          <div className="menu-photo-scroll">
            <img
              src={photoUrl(open.assetId)}
              alt={copy.photoOpen.replace("{n}", String(open.page))}
              style={{ transform: `scale(${zoom})` }}
            />
          </div>
          <button type="button" ref={closeRef} className="menu-detail-back" onClick={close}>
            {copy.photoClose}
          </button>
        </dialog>
      )}
    </span>
  );
}

/** Portion selector renders only when the traveler has a real choice. */
export const showsVariantSelectorFor = (item: MenuRowItem): boolean => item.variants.length > 1;

const portionLabelFor = (
  originalLabel: string,
  translatedLabel: string | null,
  asListed: string,
): string => {
  if (originalLabel === "") return asListed;

  if (translatedLabel === null) return originalLabel;

  return `${originalLabel} / ${translatedLabel}`;
};

export function MenuItemDetail({
  item,
  locale,
  labels,
  rates,
  activeVariantId,
  selection,
  reviewed,
  sourceLanguage,
  targetLanguage,
  notice,
  media,
  photoUrl,
  onBack,
  onVariant,
  onSelection,
  onReview,
}: {
  readonly item: MenuRowItem;
  readonly locale: string;
  readonly labels: MenuDetailLabels;
  readonly rates?: ReadonlyMap<string, ExchangeRate> | undefined;
  readonly activeVariantId: string;
  readonly selection: MenuSelection | undefined;
  readonly reviewed: boolean;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly notice: string | null;
  readonly media?: ReactNode | undefined;
  readonly photoUrl?: ((assetId: string) => string) | undefined;
  readonly onBack: () => void;
  readonly onVariant: (variantId: string) => void;
  readonly onSelection: (selection: MenuSelection) => void;
  readonly onReview: (reviewed: boolean) => void;
}): ReactNode {
  const backRef = useRef<HTMLButtonElement>(null);
  const variant = item.variants.find((entry) => entry.id === activeVariantId) ?? item.variants[0];

  useEffect(() => {
    backRef.current?.focus();
  }, []);

  // Escape returns to the list. Document-level (not a section key
  // handler): the detail is a focused view, not an interactive control.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onBack();
      }
    };

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onBack]);

  if (variant === undefined) return null;

  const quantity = selection?.quantity ?? 0;
  const showSelector = showsVariantSelectorFor(item);
  const price = variant.price;

  const knownPrice =
    price !== null &&
    price.amount !== null &&
    price.currency !== null &&
    isAmount(price.amount) &&
    isCurrency(price.currency);

  const dishHref = canonicalDishHrefFor(item.dishId, locale);

  const changeQuantity = (next: number): void =>
    onSelection({
      variantId: variant.id,
      quantity: next,
      instruction: selection?.instruction ?? "",
      originalLanguageInstruction: selection?.originalLanguageInstruction ?? "",
    });

  const addOne = (): void => {
    if (quantity >= 99) return;

    changeQuantity(quantity + 1);
  };

  return (
    <section className="menu-order menu-detail" aria-label={item.originalName}>
      <button type="button" ref={backRef} className="menu-detail-back" onClick={onBack}>
        <ArrowLeft aria-hidden="true" />
        {labels.back}
      </button>
      {media === undefined ? null : <div className="menu-detail-media">{media}</div>}
      <h3 className="menu-detail-name" lang={sourceLanguage} tabIndex={-1}>
        {item.originalName}
      </h3>
      {item.translatedName !== null ? (
        <p className="menu-order-translation" lang={targetLanguage}>
          {item.translatedName}
        </p>
      ) : null}
      {item.translatedDescription !== null ? (
        <p lang={targetLanguage}>{item.translatedDescription}</p>
      ) : null}
      {item.originalDescription !== null ? (
        <details>
          <summary>{labels.originalDescription}</summary>
          <p lang={sourceLanguage}>{item.originalDescription}</p>
        </details>
      ) : null}
      {item.explanatorySummary !== null ? (
        <details>
          <summary>{labels.explanation}</summary>
          <p lang={targetLanguage}>{item.explanatorySummary}</p>
        </details>
      ) : null}
      {showSelector ? (
        <span className="menu-detail-variant">
          <SharedSelect
            id={`menu-detail-variant-${item.id}`}
            ariaLabel={labels.variant}
            value={variant.id}
            onValueChange={onVariant}
            size="compact"
            options={item.variants.map((entry) => ({
              label: portionLabelFor(entry.originalLabel, entry.translatedLabel, labels.asListed),
              value: entry.id,
            }))}
          />
        </span>
      ) : null}
      <MenuPrice price={price} locale={locale} rates={rates} />
      <PriceConfidenceNote
        price={price}
        inferredNote={labels.inferredNote}
        possibleNote={labels.possibleNote}
        associationNote={price?.associationNote}
      />
      {!knownPrice && price !== null && price.rawText !== "" ? (
        <p>
          {price.rawText} · {labels.unknownCurrency}
        </p>
      ) : null}
      <div className="menu-detail-links">
        <details className="menu-detail-source">
          <summary>
            <Info aria-hidden="true" />
            {labels.priceSource}
          </summary>
          <p>{variant.provenance}</p>
          {variant.sourceUrl !== undefined && variant.sourceUrl !== null ? (
            <a href={variant.sourceUrl} target="_blank" rel="noreferrer">
              {labels.priceSource}
              <ArrowUpRight aria-hidden="true" />
            </a>
          ) : null}
        </details>
        {dishHref !== null ? (
          <a className="menu-detail-dish" href={dishHref}>
            <BookOpen aria-hidden="true" />
            {labels.exploreDish}
          </a>
        ) : null}
        {photoUrl !== undefined && item.assetIds.length > 0 ? (
          <MenuPhotoViewer
            photos={item.assetIds.map((assetId, index) => ({ assetId, page: index + 1 }))}
            photoUrl={photoUrl}
            locale={locale}
          />
        ) : null}
      </div>
      {item.ingredients !== undefined &&
      item.ingredients !== null &&
      item.ingredients.length > 0 ? (
        <details>
          <summary>{labels.ingredients}</summary>
          <p>{labels.ingredientNotice}</p>
          {(["printed", "inferred"] as const).map((evidence) => {
            const ingredients =
              item.ingredients?.filter((ingredient) => ingredient.evidence === evidence) ?? [];

            if (ingredients.length === 0) return null;

            return (
              <div key={evidence}>
                <h4>
                  {evidence === "printed" ? labels.printedIngredients : labels.inferredIngredients}
                </h4>
                <ul>
                  {ingredients.map((ingredient) => (
                    <li key={`${evidence}:${ingredient.originalText}`}>
                      <span lang={sourceLanguage}>{ingredient.originalText}</span>
                      {ingredient.translatedText !== null ? (
                        <span lang={targetLanguage}> / {ingredient.translatedText}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </details>
      ) : null}
      {item.uncertainties.length > 0 ? (
        <p className="menu-order-check">
          {labels.uncertainty}: {item.uncertainties.join("; ")}
        </p>
      ) : null}
      {notice !== null ? <p className="menu-order-notice">{notice}</p> : null}
      <fieldset
        className="menu-order-quantity"
        aria-label={`${labels.quantity}: ${item.originalName}, ${variant.originalLabel}`}
      >
        <button
          type="button"
          aria-label={`${labels.remove}: ${item.originalName}`}
          disabled={quantity === 0}
          onClick={() => changeQuantity(quantity - 1)}
        >
          <Minus aria-hidden="true" />
        </button>
        <output aria-live="polite" aria-label={labels.quantity}>
          {quantity}
        </output>
        <button
          type="button"
          aria-label={`${labels.add}: ${item.originalName}`}
          disabled={quantity >= 99}
          onClick={() => changeQuantity(quantity + 1)}
        >
          <Plus aria-hidden="true" />
        </button>
      </fieldset>
      <button
        type="button"
        className="menu-order-primary"
        disabled={quantity >= 99}
        onClick={addOne}
      >
        {labels.addToOrder}
      </button>
      {quantity > 0 && selection !== undefined ? (
        <details className="menu-order-instructions" open>
          <summary>{labels.instructions}</summary>
          <p id={`instruction-help-${variant.id}`}>{labels.instructionHelp}</p>
          <label htmlFor={`instruction-${variant.id}`}>{labels.enteredInstruction}</label>
          <textarea
            id={`instruction-${variant.id}`}
            maxLength={500}
            value={selection.instruction}
            lang={targetLanguage}
            aria-describedby={`instruction-help-${variant.id}`}
            onChange={(event) => {
              onSelection({ ...selection, instruction: event.target.value });
              onReview(false);
            }}
          />
          <label htmlFor={`waiter-instruction-${variant.id}`}>{labels.waiterInstruction}</label>
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
            {labels.reviewedInstructions}
          </label>
        </details>
      ) : null}
    </section>
  );
}
