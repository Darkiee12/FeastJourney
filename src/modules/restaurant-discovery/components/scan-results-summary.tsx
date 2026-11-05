import { BookOpen, Coins, Images, Languages, ScanLine, Tag, Pencil, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import {
  menuResultsCopy,
  menuResultsCount,
  menuCopy,
  menuScanResultsCopy,
} from "@/modules/restaurant-discovery/components/menu-copy";
import { MenuPhotoViewer } from "@/modules/restaurant-discovery/components/menu-item-detail";
import type { InteractiveMenu } from "@/modules/restaurant-discovery/menu-presentation";

/**
 * Summary qualifier for the menu's shown currencies. "As listed" is reserved
 * for currency actually read from the printed source (interpreted provenance
 * "printed"). Inferred currency is labeled as inferred; reviewer-confirmed
 * currency is labeled as confirmed; anything else (unknown, absent legacy
 * provenance) stays explicitly unconfirmed rather than borrowing
 * printed-source authority.
 */
export type ScanCurrencyNoteKind = "as-listed" | "inferred" | "confirmed" | "unconfirmed";

export function scanCurrencyNoteKind(
  provenances: ReadonlyArray<string | undefined>,
  currencyCount: number,
): ScanCurrencyNoteKind {
  const known = provenances.map((code) => code ?? "unknown");

  if (currencyCount > 0 && known.every((code) => code === "printed")) return "as-listed";

  if (known.some((code) => code === "inferred")) return "inferred";

  if (currencyCount > 0 && known.every((code) => code === "printed" || code === "user-confirmed"))
    return "confirmed";

  return "unconfirmed";
}

/** Browser-safe summary of the actual private menu; no catalog enrichment or invented statistics. */
export function ScanResultsSummary({
  menu,
  photos,
  photoUrl,
  sourceName,
  targetName,
  locale,
  location,
}: {
  readonly menu: InteractiveMenu;
  readonly photos: ReadonlyArray<{ readonly assetId: string; readonly page: number }>;
  readonly photoUrl: (assetId: string) => string;
  readonly sourceName: string | null;
  readonly targetName: string;
  readonly locale: string;
  readonly location: string | null;
}) {
  const ui = menuResultsCopy(locale);
  const copy = menuCopy(locale);
  const resultsCopy = menuScanResultsCopy(locale);

  const readable = menu.items.filter((item) =>
    item.variants.some(
      (variant) =>
        variant.price !== null &&
        (variant.price.rawText.trim() !== "" || variant.price.amount !== null),
    ),
  ).length;

  const prices = menu.items.flatMap((item) =>
    item.variants.flatMap((variant) => (variant.price === null ? [] : [variant.price])),
  );

  const currencies = [
    ...new Set(prices.flatMap((price) => (price.currency === null ? [] : [price.currency]))),
  ];

  const noteKind = scanCurrencyNoteKind(
    prices.map((price) => price.currencyProvenance),
    currencies.length,
  );

  let currencyNote = ui.currencyUnconfirmed;

  if (noteKind === "as-listed") currencyNote = ui.asListed;
  else if (noteKind === "inferred") currencyNote = resultsCopy.priceInferredNote;
  else if (noteKind === "confirmed") currencyNote = resultsCopy.currencyConfirmedNote;

  return (
    <section
      className="grid min-w-0 gap-4 rounded-3xl border border-border-soft bg-white p-3 shadow-sm sm:p-5 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-6"
      aria-label={ui.summary}
    >
      {photos.length > 0 && (
        <div className="min-w-0">
          <MenuPhotoViewer
            photos={photos}
            photoUrl={photoUrl}
            locale={locale}
            presentation="overview"
          />
        </div>
      )}
      <div className="min-w-0 overflow-hidden rounded-2xl border border-border-soft bg-cream/60">
        <h2 className="sr-only md:not-sr-only md:m-0 md:flex md:items-center md:gap-2 md:bg-mango/10 md:px-4 md:py-4 md:text-lg md:font-extrabold [&_svg]:size-5 [&_svg]:text-food-orange-strong">
          <ScanLine aria-hidden="true" />
          {ui.summary}
        </h2>
        <dl className="m-0 grid grid-cols-3 divide-x divide-border-soft px-2 py-3 md:py-5 [&>div]:flex [&>div]:min-w-0 [&>div]:flex-col [&>div]:items-center [&>div]:gap-1 [&>div]:px-1 [&>div]:text-center [&_dt]:contents [&_dt>span]:order-2 [&_dt>span]:text-xs [&_dd]:m-0 [&_dd]:text-2xl [&_dd]:font-extrabold [&_dd]:tabular-nums [&_svg]:size-5 [&_svg]:text-food-orange-strong">
          <div>
            <dt>
              <BookOpen aria-hidden="true" />
              <span>{ui.dishesFound}</span>
            </dt>
            <dd>{menu.items.length}</dd>
          </div>
          <div>
            <dt>
              <Tag aria-hidden="true" />
              <span>{ui.readablePrices}</span>
            </dt>
            <dd>{readable}</dd>
          </div>
          <div>
            <dt>
              <Images aria-hidden="true" />
              <span>{ui.pages}</span>
            </dt>
            <dd>{photos.length}</dd>
          </div>
        </dl>
        <dl className="mx-4 my-0 grid divide-y divide-border-soft border-t border-border-soft pb-2 md:grid-cols-3 md:gap-3 md:divide-y-0 [&>div]:min-w-0 [&>div]:py-3 [&_dt]:flex [&_dt]:items-center [&_dt]:gap-2 [&_dt]:text-xs [&_dt]:text-muted [&_dd]:mt-1 [&_dd]:ml-6 [&_dd]:text-sm [&_dd]:leading-relaxed [&_dd]:font-bold md:[&_dd]:ml-0 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink [&_small]:mt-1 [&_small]:block [&_small]:text-xs [&_small]:font-normal [&_small]:text-muted">
          <div>
            <dt>
              <Languages aria-hidden="true" />
              {copy.menuLanguage}
            </dt>
            <dd>
              {sourceName ?? ui.notIdentified} <span aria-hidden="true">→</span> {targetName}
            </dd>
          </div>
          <div>
            <dt>
              <Coins aria-hidden="true" />
              {ui.currency}
            </dt>
            <dd>
              {currencies.join(" / ") || ui.notConfirmed}
              <small>{currencyNote}</small>
            </dd>
          </div>
          <div className={location === null ? "hidden md:block" : undefined}>
            <dt>
              <Images aria-hidden="true" />
              {ui.source}
            </dt>
            <dd>
              {ui.privatePhoto}
              {location !== null && <small>{location}</small>}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

export function ScanResultsHeading({
  locale,
  itemCount,
  onEditMenu,
  toolsTrigger,
}: {
  readonly locale: string;
  readonly itemCount: number;
  readonly onEditMenu: () => void;
  /** Compact entry point to the secondary tools workspace. */
  readonly toolsTrigger?: ReactNode | undefined;
}) {
  const ui = menuResultsCopy(locale);

  return (
    <header className="flex flex-wrap items-center justify-between gap-4 py-2">
      <div className="flex min-w-0 items-start gap-3 [&>svg]:size-8 [&>svg]:shrink-0 [&>svg]:text-food-orange sm:[&>svg]:size-10 [&_p]:mt-2 [&_p]:text-sm [&_p]:leading-relaxed">
        <Sparkles aria-hidden="true" />
        <div>
          <h1
            id="scan-results-title"
            tabIndex={-1}
            className="font-display m-0 text-2xl leading-[1.05] tracking-[0.015em] text-balance text-ink sm:text-3xl"
          >
            {ui.success}
          </h1>
          <p>{menuResultsCount(locale, "scanned", itemCount)}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {toolsTrigger}
        <button
          type="button"
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-ink bg-white px-4 text-sm font-bold shadow-[0_2px_0_var(--color-ink)] [&_svg]:size-4"
          onClick={onEditMenu}
        >
          <Pencil aria-hidden="true" />
          {ui.editMenu}
        </button>
      </div>
    </header>
  );
}
