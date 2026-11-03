import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, BookOpen } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { menuCopy } from "@/modules/restaurant-discovery/components/menu-copy";
import { MenuDishThumbnail } from "@/modules/restaurant-discovery/components/menu-dish-thumbnail";
import { MenuItemDetail } from "@/modules/restaurant-discovery/components/menu-item-detail";
import {
  defaultVariantIdFor,
  MenuItemRow,
  rowDisplayNameFor,
} from "@/modules/restaurant-discovery/components/menu-item-row";
import { MenuLanguageSelector } from "@/modules/restaurant-discovery/components/menu-language-selector";
import { MenuOrderSummary } from "@/modules/restaurant-discovery/components/menu-order-summary";
import { MenuPagesViewer } from "@/modules/restaurant-discovery/components/menu-pages-viewer";
import {
  restaurantCopy,
  type RestaurantCopy,
} from "@/modules/restaurant-discovery/components/restaurant-copy";
import { WaiterOrderCard } from "@/modules/restaurant-discovery/components/waiter-order-card";
import {
  HINGLISH_STYLE,
  detectMenuBrowserLanguage,
  readSavedMenuLanguage,
  resolveMenuLanguage,
  writeSavedMenuLanguage,
} from "@/modules/restaurant-discovery/menu-language";
import type {
  InteractiveMenu,
  MenuSelection,
} from "@/modules/restaurant-discovery/menu-presentation";
import { menuBcp47TagFor, presentReviewed } from "@/modules/restaurant-discovery/menu-presentation";
import { useMenuSelection } from "@/modules/restaurant-discovery/menu-selection-store";
import { listMenuPagesFn } from "@/modules/restaurant-discovery/restaurant-menu-media.functions";
import { getRestaurantFn } from "@/modules/restaurant-discovery/restaurant.functions";
import type { RestaurantSearch } from "@/modules/restaurant-discovery/restaurant.schema";
import type { Locale } from "@/shared/i18n";
import type { ExchangeRate } from "@/shared/money";

type MenuChannel = RestaurantSearch["channel"];

/** Client-only scroll memory so tab switches restore the reader's place.
 *  Keyed by venue + channel; never leaves the browser. */
const menuPanelScrollTops: Map<string, number> = new Map();

const scrollKeyFor = (venueId: string, channel: MenuChannel, menuLang: string): string =>
  `${venueId}:${channel}:${menuLang}`;

/** Published section keys render as traveler-facing headings ("wine_list"
 *  → "wine list"). Mirrors the shared controller's projection; the panel
 *  owns no section vocabulary of its own. */
const humanizeSection = (section: string): string =>
  section.replaceAll("-", " ").replaceAll("_", " ");

/** Same-tab notice for menu-language saves (cross-tab arrives via
 *  the storage event). Mirrors the currency preference store. */
const menuLanguageStoreEvent = "feastjourney-menu-language";

const changeMenuLanguage = (value: string): void => {
  writeSavedMenuLanguage(value);
  window.dispatchEvent(new Event(menuLanguageStoreEvent));
};

const subscribeToMenuLanguage = (notify: () => void): (() => void) => {
  window.addEventListener("storage", notify);
  window.addEventListener(menuLanguageStoreEvent, notify);

  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener(menuLanguageStoreEvent, notify);
  };
};

type BoardItem = InteractiveMenu["items"][number];

/** Self-fetching reviewed menu panel for one venue + sales channel.
 *  Fetches through getRestaurantFn with TanStack Query key
 *  ['restaurant-menu', venueId, channel]; projects section rows into
 *  presentReviewed and mounts the progressive-disclosure board (compact
 *  MenuItemRow list, focused MenuItemDetail on demand, shared waiter
 *  card), never a separate renderer. Reviewed observations only —
 *  confirm current prices, taxes, service charges and dietary
 *  requirements with the venue. */
export function RestaurantMenuPanel({
  channel,
  lang,
  onBackToOverview,
  onChannelChange,
  rates,
  venueId,
  venueName,
  countryCode,
  initialExpandedItemId,
  backLabel,
  errorHeading,
  retryLabel,
  loadingLabel,
  emptyTitle,
  emptyBody,
  menuTabLabel,
  pagesTabLabel,
}: {
  readonly channel: MenuChannel;
  readonly lang: Locale;
  readonly onBackToOverview: () => void;
  readonly onChannelChange?: ((channel: MenuChannel) => void) | undefined;
  readonly rates?: ReadonlyMap<string, ExchangeRate> | undefined;
  readonly venueId: string;
  readonly venueName: string | null;
  readonly countryCode: string | null;
  readonly initialExpandedItemId?: string | undefined;
  readonly backLabel?: string | undefined;
  readonly errorHeading?: string | undefined;
  readonly retryLabel?: string | undefined;
  readonly loadingLabel?: string | undefined;
  readonly emptyTitle?: string | undefined;
  readonly emptyBody?: string | undefined;
  readonly menuTabLabel?: string | undefined;
  readonly pagesTabLabel?: string | undefined;
}) {
  const query = useQuery({
    queryKey: ["restaurant-menu", venueId, channel],
    queryFn: () => getRestaurantFn({ data: { venueId, channel } }),
    staleTime: 60000,
    retry: false,
  });

  const offerings = query.data?.offerings ?? [];

  // Independent menu-reading language: explicit session choice > saved
  // preference > app language > browser language > English. Switching it
  // re-projects the already-fetched rows client-side — zero new requests,
  // no discovery rerun, no map remount.
  //
  // Browser globals (saved preference, navigator.languages) are unreadable
  // during SSR and differ per visitor, so they enter through the external
  // store: the server snapshot resolves from the app language only, which
  // is exactly what the server rendered — hydration agrees, then the
  // client snapshot folds saved/browser preferences in with a normal
  // update. Reading them during render would both crash runtimes without
  // navigator.languages and mismatch hydration.
  const menuLang = useSyncExternalStore(
    subscribeToMenuLanguage,
    () =>
      resolveMenuLanguage({
        app: lang,
        browser: detectMenuBrowserLanguage(navigator.languages),
        saved: readSavedMenuLanguage(),
      }),
    () => resolveMenuLanguage({ app: lang }),
  );

  const projectionLang = menuLang === HINGLISH_STYLE ? "en" : menuLang;

  const availableTranslations: ReadonlyArray<string> = [
    ...new Set(
      offerings.flatMap((offering) =>
        offering.translation_language === null ? [] : [offering.translation_language],
      ),
    ),
  ];

  // Secondary tab: published menu pages (photographs/scans). The reviewed
  // menu stays the default tab, except when no structured items exist but
  // published pages do — then the pages lead (Case B). An explicit user
  // choice always wins over the default.
  const [tabOverride, setTabOverride] = useState<"menu" | "pages" | null>(null);

  const pagesQuery = useQuery({
    queryKey: ["restaurant-menu-pages", venueId],
    queryFn: () => listMenuPagesFn({ data: { venueId } }),
    staleTime: 60000,
    retry: false,
  });

  const pages = pagesQuery.data ?? [];
  const showPagesTab = pagesQuery.isSuccess && pages.length > 0;
  const offeringsEmpty = query.isSuccess && offerings.length === 0;
  const tab = tabOverride ?? (showPagesTab && offeringsEmpty ? "pages" : "menu");

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = menuPanelScrollTops.get(scrollKeyFor(venueId, channel, menuLang));

    if (scrollRef.current !== null && saved !== undefined) scrollRef.current.scrollTop = saved;
  }, [venueId, channel, menuLang]);

  useEffect(
    () => () => {
      if (scrollRef.current !== null)
        menuPanelScrollTops.set(
          scrollKeyFor(venueId, channel, menuLang),
          scrollRef.current.scrollTop,
        );
    },
    [venueId, channel, menuLang],
  );

  const sections =
    query.data === undefined
      ? new Map<string, string | null>()
      : new Map<string, string | null>(query.data.sections.map((row) => [row.id, row.section_key]));

  const menu =
    query.data === undefined
      ? null
      : presentReviewed(offerings, venueName, projectionLang, sections);

  // Progressive-disclosure board state. Selections live in the shared
  // venue+channel controller so quantities, variants, instructions, and
  // review acknowledgements survive overview ↔ menu ↔ reviews switches.
  const copy = menuCopy(lang);
  const rcopy: RestaurantCopy = restaurantCopy(lang);
  const backLabelText = backLabel ?? rcopy.menuBackToOverview;
  const errorHeadingText = errorHeading ?? rcopy.menuLoadFailed;
  const retryLabelText = retryLabel ?? rcopy.retryAction;
  const loadingLabelText = loadingLabel ?? rcopy.menuLoading;
  const emptyTitleText = emptyTitle ?? rcopy.menuEmptyTitle;
  const emptyBodyText = emptyBody ?? rcopy.menuEmptyBody;
  const menuTabText = menuTabLabel ?? rcopy.menuReviewedTab;
  const pagesTabText = pagesTabLabel ?? rcopy.menuPagesTab;
  const dialog = useRef<HTMLDialogElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(() => initialExpandedItemId ?? null);

  const { activeVariants, selections, reviewed, setActiveVariants, setSelections, setReviewed } =
    useMenuSelection(venueId, channel);

  const availableIds =
    menu === null
      ? new Set<string>()
      : new Set(menu.items.flatMap((item) => item.variants.map((variant) => variant.id)));

  const currentSelections = selections.flatMap((selection) =>
    availableIds.has(selection.variantId) ? [selection] : [],
  );

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

  let boardNotice = copy.reviewedNotice;

  if (menu?.provenance === "private_scan") boardNotice = copy.privateNotice;

  if (menu?.provenance === "draft") boardNotice = copy.draftNotice;

  const selectedVariantIdFor = (item: BoardItem): string | null => {
    const activeId = activeVariants.get(item.id);

    if (activeId !== undefined && item.variants.some((variant) => variant.id === activeId))
      return activeId;

    return defaultVariantIdFor(item);
  };

  const openItem = (itemId: string): void => {
    setExpandedId(itemId);

    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0;
  };

  const closeDetail = (itemId: string): void => {
    setExpandedId(null);
    document.getElementById(`menu-row-open-${itemId}`)?.focus();
  };

  const expandedItem =
    menu === null || expandedId === null
      ? undefined
      : menu.items.find((item) => item.id === expandedId);

  let expandedDetail: ReactNode = null;

  if (expandedItem !== undefined) {
    const selectedId = selectedVariantIdFor(expandedItem);

    if (selectedId !== null) {
      const item = expandedItem;

      expandedDetail = (
        <MenuItemDetail
          item={item}
          locale={lang}
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
          }}
          rates={rates}
          activeVariantId={selectedId}
          selection={currentSelections.find((entry) => entry.variantId === selectedId)}
          reviewed={reviewed.has(selectedId)}
          sourceLanguage={menuBcp47TagFor(menu?.sourceLanguage)}
          targetLanguage={menuBcp47TagFor(menu?.targetLanguage ?? lang)}
          notice={boardNotice}
          onBack={() => closeDetail(item.id)}
          onVariant={(id) => setActiveVariants((previous) => new Map([...previous, [item.id, id]]))}
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
      );
    }
  }

  const groupedSections: Array<{ readonly key: string | null; readonly items: Array<BoardItem> }> =
    [];

  if (menu !== null) {
    for (const item of menu.items) {
      const last = groupedSections[groupedSections.length - 1];

      if (last !== undefined && last.key === item.section) last.items.push(item);
      else groupedSections.push({ key: item.section, items: [item] });
    }
  }

  const singleList = groupedSections.length === 1 && groupedSections[0]?.key === null;

  const renderRow = (item: BoardItem): ReactNode => {
    const selectedId = selectedVariantIdFor(item);

    if (selectedId === null) return null;

    return (
      <MenuItemRow
        key={item.id}
        item={item}
        locale={lang}
        labels={{
          add: copy.add,
          openDetails: copy.openDetails,
          quantity: copy.quantity,
          priceUnknown: copy.unknownPrice,
        }}
        rates={rates}
        selectedVariantId={selectedId}
        selection={currentSelections.find((entry) => entry.variantId === selectedId)}
        sourceLanguage={menuBcp47TagFor(menu?.sourceLanguage)}
        targetLanguage={menuBcp47TagFor(menu?.targetLanguage ?? lang)}
        thumbnail={
          <MenuDishThumbnail itemId={item.id} itemName={rowDisplayNameFor(item)} media={null} />
        }
        onOpen={() => openItem(item.id)}
        onSelection={changeSelection}
      />
    );
  };

  // Case C: structured items exist but no price was observed for this
  // sales channel (channel only picks the price row; items persist).
  const allPricesUnknown =
    query.isSuccess &&
    offerings.length > 0 &&
    offerings.every((offering) => offering.amount === null);

  let channelName = rcopy.dineIn;

  if (channel === "takeaway") {
    channelName = rcopy.takeaway;
  } else if (channel === "delivery") {
    channelName = rcopy.delivery;
  }

  const channelChannels: ReadonlyArray<MenuChannel> = ["dine_in", "takeaway", "delivery"];

  const channelChipLabel = (value: MenuChannel): string => {
    if (value === "takeaway") return rcopy.takeaway;

    if (value === "delivery") return rcopy.delivery;

    return rcopy.dineIn;
  };

  return (
    <section className="restaurant-menu-panel" aria-label={venueName ?? "Restaurant menu"}>
      <div className="menu-panel-head">
        <button type="button" className="menu-panel-back" onClick={onBackToOverview}>
          <ArrowLeft aria-hidden="true" />
          {backLabelText}
        </button>
        <MenuLanguageSelector
          id={`menu-lang-${venueId}`}
          value={menuLang}
          available={availableTranslations}
          countryCode={countryCode}
          onChange={changeMenuLanguage}
          languageLabel={copy.menuLanguageLabel}
          hinglishLabel={copy.hinglishLabel}
          hinglishUnavailable={copy.hinglishUnavailable}
          unavailableLabel={copy.menuLanguageUnavailable}
          moreLanguagesLabel={copy.moreLanguagesLabel}
        />
        {onChannelChange !== undefined && (
          <fieldset className="menu-panel-channels">
            <legend className="sr-only">{rcopy.diningOptions}</legend>
            {channelChannels.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={channel === value}
                className={channel === value ? "menu-panel-chip is-active" : "menu-panel-chip"}
                onClick={() => onChannelChange(value)}
              >
                {channelChipLabel(value)}
              </button>
            ))}
          </fieldset>
        )}
      </div>
      {showPagesTab && (
        <div className="menu-panel-tabs" role="tablist" aria-label={venueName ?? "Menu views"}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "menu"}
            className={tab === "menu" ? "menu-panel-tab is-active" : "menu-panel-tab"}
            onClick={() => setTabOverride("menu")}
          >
            {menuTabText}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "pages"}
            className={tab === "pages" ? "menu-panel-tab is-active" : "menu-panel-tab"}
            onClick={() => setTabOverride("pages")}
          >
            {pagesTabText} ({pages.length})
          </button>
        </div>
      )}
      {query.isPending && (
        <div className="menu-panel-loading" aria-busy="true" aria-label={loadingLabelText}>
          <div className="menu-panel-skeleton" />
          <div className="menu-panel-skeleton" />
          <div className="menu-panel-skeleton" />
        </div>
      )}
      {query.isError && (
        <div className="menu-panel-error" role="alert">
          <p>{errorHeadingText}</p>
          <button type="button" className="menu-panel-retry" onClick={() => void query.refetch()}>
            {retryLabelText}
          </button>
        </div>
      )}
      {tab === "menu" && offeringsEmpty && (
        <div className="menu-panel-empty" aria-live="polite">
          <BookOpen aria-hidden="true" />
          <p>{emptyTitleText}</p>
          <p>{emptyBodyText}</p>
          {showPagesTab && (
            <button
              type="button"
              className="menu-panel-pages-link"
              onClick={() => setTabOverride("pages")}
            >
              {rcopy.menuEmptyPages} ({pages.length})
            </button>
          )}
          <Link
            className="menu-panel-scan"
            to="/scan"
            search={{ lang, venueId, returnVenue: venueId, returnView: "menu" }}
          >
            {rcopy.scanMenuAction}
          </Link>
          <Link
            className="menu-panel-contribute"
            to="/scan"
            search={{ lang, venueId, returnVenue: venueId, returnView: "menu" }}
          >
            {copy.helpAddMenu}
          </Link>
        </div>
      )}
      {tab === "menu" && query.isSuccess && offerings.length > 0 && menu !== null && (
        <div
          ref={scrollRef}
          className="menu-panel-scroll"
          onScroll={(event) =>
            menuPanelScrollTops.set(
              scrollKeyFor(venueId, channel, menuLang),
              event.currentTarget.scrollTop,
            )
          }
        >
          {allPricesUnknown && (
            <div className="menu-panel-channel-note" aria-live="polite">
              <p>{rcopy.menuNoChannel.replace("{channel}", channelName)}</p>
              <p>{rcopy.menuChannelHelp}</p>
              <Link
                className="menu-panel-scan"
                to="/scan"
                search={{ lang, venueId, returnVenue: venueId, returnView: "menu" }}
              >
                {rcopy.scanMenuAction}
              </Link>
            </div>
          )}
          {expandedDetail === null ? (
            <div className="menu-board" lang={menuBcp47TagFor(lang)}>
              <p className="menu-order-notice">{boardNotice}</p>
              {singleList ? (
                <ul className="menu-row-list">{groupedSections[0]?.items.map(renderRow)}</ul>
              ) : (
                groupedSections.map((group) => (
                  <div key={group.key ?? "main"}>
                    {group.key !== null ? (
                      <h3 className="menu-order-section">{humanizeSection(group.key)}</h3>
                    ) : null}
                    <ul className="menu-row-list">{group.items.map(renderRow)}</ul>
                  </div>
                ))
              )}
            </div>
          ) : (
            expandedDetail
          )}
          <MenuOrderSummary
            menu={menu}
            selections={currentSelections}
            locale={lang}
            onViewOrder={() => dialog.current?.showModal()}
            reviewBlocked={needsReview}
          />
          <dialog ref={dialog} className="menu-waiter-dialog" aria-label={copy.orderTitle}>
            <form method="dialog">
              <button type="submit" className="menu-order-back">
                {copy.back}
              </button>
            </form>
            <WaiterOrderCard
              menu={menu}
              selections={currentSelections}
              locale={lang}
              onQuantity={(variantId, quantity) => {
                const existing = currentSelections.find((entry) => entry.variantId === variantId);

                changeSelection({
                  variantId,
                  quantity,
                  instruction: existing?.instruction ?? "",
                  originalLanguageInstruction: existing?.originalLanguageInstruction ?? "",
                });
              }}
              onVariant={(previousVariantId, nextVariantId) => {
                const owner = menu.items.find((item) =>
                  item.variants.some((variant) => variant.id === nextVariantId),
                );

                if (owner !== undefined)
                  setActiveVariants(
                    (previous) => new Map([...previous, [owner.id, nextVariantId]]),
                  );

                const existing = currentSelections.find(
                  (entry) => entry.variantId === previousVariantId,
                );

                if (existing !== undefined) {
                  changeSelection({ ...existing, variantId: previousVariantId, quantity: 0 });
                  changeSelection({ ...existing, variantId: nextVariantId });
                }
              }}
            />
          </dialog>
        </div>
      )}
      {tab === "pages" && showPagesTab && (
        <div className="menu-panel-pages-wrap">
          <MenuPagesViewer pages={pages} />
          {offeringsEmpty && (
            <div className="menu-panel-pages-scan" aria-live="polite">
              <Link
                className="menu-panel-scan"
                to="/scan"
                search={{ lang, venueId, returnVenue: venueId, returnView: "menu" }}
              >
                {rcopy.menuScanUnderstand}
              </Link>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
