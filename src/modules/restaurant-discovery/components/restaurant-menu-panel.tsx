import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { menuCopy } from "@/modules/restaurant-discovery/components/menu-copy";
import { MenuDishThumbnail } from "@/modules/restaurant-discovery/components/menu-dish-thumbnail";
import { MenuItemDetail } from "@/modules/restaurant-discovery/components/menu-item-detail";
import {
  defaultVariantIdFor,
  MenuItemRow,
  rowDisplayNameFor,
} from "@/modules/restaurant-discovery/components/menu-item-row";
import { MenuOrderSummary } from "@/modules/restaurant-discovery/components/menu-order-summary";
import { MenuPagesViewer } from "@/modules/restaurant-discovery/components/menu-pages-viewer";
import { WaiterOrderCard } from "@/modules/restaurant-discovery/components/waiter-order-card";
import type {
  InteractiveMenu,
  MenuSelection,
} from "@/modules/restaurant-discovery/menu-presentation";
import { menuBcp47TagFor, presentReviewed } from "@/modules/restaurant-discovery/menu-presentation";
import { listMenuPagesFn } from "@/modules/restaurant-discovery/restaurant-menu-media.functions";
import { getRestaurantFn } from "@/modules/restaurant-discovery/restaurant.functions";
import type { RestaurantSearch } from "@/modules/restaurant-discovery/restaurant.schema";
import type { ExchangeRate } from "@/shared/money";

type MenuChannel = RestaurantSearch["channel"];

/** Client-only scroll memory so tab switches restore the reader's place.
 *  Keyed by venue + channel; never leaves the browser. */
const menuPanelScrollTops: Map<string, number> = new Map();

const scrollKeyFor = (venueId: string, channel: MenuChannel): string => `${venueId}:${channel}`;

/** Published section keys render as traveler-facing headings ("wine_list"
 *  → "wine list"). Mirrors the shared controller's projection; the panel
 *  owns no section vocabulary of its own. */
const humanizeSection = (section: string): string =>
  section.replaceAll("-", " ").replaceAll("_", " ");

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
  rates,
  venueId,
  venueName,
  backLabel = "Back to overview",
  errorHeading = "The menu could not load.",
  retryLabel = "Try again",
  loadingLabel = "Loading the reviewed menu…",
  emptyLabel = "No curated menu offerings have been recorded for this branch yet.",
  menuTabLabel = "Reviewed menu",
  pagesTabLabel = "Menu pages",
}: {
  readonly channel: MenuChannel;
  readonly lang: string;
  readonly onBackToOverview: () => void;
  readonly rates?: ReadonlyMap<string, ExchangeRate> | undefined;
  readonly venueId: string;
  readonly venueName: string | null;
  readonly backLabel?: string | undefined;
  readonly errorHeading?: string | undefined;
  readonly retryLabel?: string | undefined;
  readonly loadingLabel?: string | undefined;
  readonly emptyLabel?: string | undefined;
  readonly menuTabLabel?: string | undefined;
  readonly pagesTabLabel?: string | undefined;
}) {
  const query = useQuery({
    queryKey: ["restaurant-menu", venueId, channel],
    queryFn: () => getRestaurantFn({ data: { venueId, channel } }),
    staleTime: 60000,
    retry: false,
  });

  // Secondary tab: published menu pages (photographs/scans). Mounted only
  // when at least one published page exists; the reviewed menu stays the
  // default tab.
  const [activeTab, setActiveTab] = useState<"menu" | "pages">("menu");

  const pagesQuery = useQuery({
    queryKey: ["restaurant-menu-pages", venueId],
    queryFn: () => listMenuPagesFn({ data: { venueId } }),
    staleTime: 60000,
    retry: false,
  });

  const pages = pagesQuery.data ?? [];
  const showPagesTab = pagesQuery.isSuccess && pages.length > 0;
  const tab = showPagesTab ? activeTab : "menu";

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = menuPanelScrollTops.get(scrollKeyFor(venueId, channel));

    if (scrollRef.current !== null && saved !== undefined) scrollRef.current.scrollTop = saved;
  }, [venueId, channel]);

  useEffect(
    () => () => {
      if (scrollRef.current !== null)
        menuPanelScrollTops.set(scrollKeyFor(venueId, channel), scrollRef.current.scrollTop);
    },
    [venueId, channel],
  );

  const offerings = query.data?.offerings ?? [];

  const sections =
    query.data === undefined
      ? new Map<string, string | null>()
      : new Map<string, string | null>(query.data.sections.map((row) => [row.id, row.section_key]));

  const menu =
    query.data === undefined ? null : presentReviewed(offerings, venueName, lang, sections);

  // Progressive-disclosure board state. Selection semantics mirror the
  // shared controller exactly (MenuSelection identity, 0–99 quantities,
  // instruction preservation); only the presentation is new. The
  // coordinator-owned interactive-menu keeps the canonical controller —
  // see the Agent A report for the merge (lift state or delegate here).
  const copy = menuCopy(lang);
  const dialog = useRef<HTMLDialogElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [activeVariants, setActiveVariants] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  const [selections, setSelections] = useState<ReadonlyArray<MenuSelection>>([]);

  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(() => new Set());

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

  return (
    <section className="restaurant-menu-panel" aria-label={venueName ?? "Restaurant menu"}>
      <div className="menu-panel-head">
        <button type="button" className="menu-panel-back" onClick={onBackToOverview}>
          <ArrowLeft aria-hidden="true" />
          {backLabel}
        </button>
      </div>
      {showPagesTab && (
        <div className="menu-panel-tabs" role="tablist" aria-label={venueName ?? "Menu views"}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "menu"}
            className={tab === "menu" ? "menu-panel-tab is-active" : "menu-panel-tab"}
            onClick={() => setActiveTab("menu")}
          >
            {menuTabLabel}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "pages"}
            className={tab === "pages" ? "menu-panel-tab is-active" : "menu-panel-tab"}
            onClick={() => setActiveTab("pages")}
          >
            {pagesTabLabel} ({pages.length})
          </button>
        </div>
      )}
      {query.isPending && (
        <div className="menu-panel-loading" aria-busy="true" aria-label={loadingLabel}>
          <div className="menu-panel-skeleton" />
          <div className="menu-panel-skeleton" />
          <div className="menu-panel-skeleton" />
        </div>
      )}
      {query.isError && (
        <div className="menu-panel-error" role="alert">
          <p>{errorHeading}</p>
          <button type="button" className="menu-panel-retry" onClick={() => void query.refetch()}>
            {retryLabel}
          </button>
        </div>
      )}
      {tab === "menu" && query.isSuccess && offerings.length === 0 && (
        <div className="menu-panel-empty" aria-live="polite">
          {emptyLabel}
        </div>
      )}
      {tab === "menu" && query.isSuccess && offerings.length > 0 && menu !== null && (
        <div
          ref={scrollRef}
          className="menu-panel-scroll"
          onScroll={(event) =>
            menuPanelScrollTops.set(scrollKeyFor(venueId, channel), event.currentTarget.scrollTop)
          }
        >
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
      {tab === "pages" && showPagesTab && <MenuPagesViewer pages={pages} />}
    </section>
  );
}
