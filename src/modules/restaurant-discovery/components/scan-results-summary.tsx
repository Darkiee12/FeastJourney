import {
  BookOpen,
  Coins,
  Images,
  Languages,
  ScanLine,
  Tag,
  Camera,
  Pencil,
  Sparkles,
} from "lucide-react";

import {
  menuResultsCopy,
  menuResultsCount,
  menuCopy,
  menuScanResultsCopy,
} from "@/modules/restaurant-discovery/components/menu-copy";
import { MenuPhotoViewer } from "@/modules/restaurant-discovery/components/menu-item-detail";
import {
  priceAssociationOf,
  priceTrustOf,
  type InteractiveMenu,
} from "@/modules/restaurant-discovery/menu-presentation";

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

  const inferred = prices.some((price) => priceTrustOf(price) === "inferred");

  const unresolved = prices.some(
    (price) =>
      price.currency === null ||
      priceAssociationOf(price) !== "clear" ||
      priceTrustOf(price) === "unknown",
  );

  let currencyNote = ui.asListed;

  if (inferred) currencyNote = resultsCopy.priceInferredNote;
  else if (unresolved || currencies.length === 0) currencyNote = ui.currencyUnconfirmed;

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
  onScanAnother,
}: {
  readonly locale: string;
  readonly itemCount: number;
  readonly onEditMenu: () => void;
  readonly onScanAnother?: (() => void) | undefined;
}) {
  const ui = menuResultsCopy(locale);

  return (
    <header className="flex flex-wrap items-center justify-between gap-4 py-2">
      <div className="flex min-w-0 items-start gap-3 [&>svg]:size-8 [&>svg]:shrink-0 [&>svg]:text-food-orange sm:[&>svg]:size-10 [&_h1]:m-0 [&_h1]:text-2xl [&_h1]:leading-tight [&_h1]:font-extrabold [&_h1]:tracking-tight sm:[&_h1]:text-3xl [&_p]:mt-2 [&_p]:text-sm [&_p]:leading-relaxed">
        <Sparkles aria-hidden="true" />
        <div>
          <h1 id="scan-results-title" tabIndex={-1}>
            {ui.success}
          </h1>
          <p>{menuResultsCount(locale, "scanned", itemCount)}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {onScanAnother && (
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-ink bg-white px-4 text-sm font-bold shadow-[0_2px_0_var(--color-ink)] [&_svg]:size-4"
            onClick={onScanAnother}
          >
            <Camera aria-hidden="true" />
            {ui.rescan}
          </button>
        )}
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
