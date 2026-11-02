import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { InteractiveMenuView } from "@/modules/restaurant-discovery/components/interactive-menu";
import { MenuPagesViewer } from "@/modules/restaurant-discovery/components/menu-pages-viewer";
import { presentReviewed } from "@/modules/restaurant-discovery/menu-presentation";
import { listMenuPagesFn } from "@/modules/restaurant-discovery/restaurant-menu-media.functions";
import { getRestaurantFn } from "@/modules/restaurant-discovery/restaurant.functions";
import type { RestaurantSearch } from "@/modules/restaurant-discovery/restaurant.schema";
import type { ExchangeRate } from "@/shared/money";

type MenuChannel = RestaurantSearch["channel"];

/** Client-only scroll memory so tab switches restore the reader's place.
 *  Keyed by venue + channel; never leaves the browser. */
const menuPanelScrollTops: Map<string, number> = new Map();

const scrollKeyFor = (venueId: string, channel: MenuChannel): string => `${venueId}:${channel}`;

/** Self-fetching reviewed menu panel for one venue + sales channel.
 *  Fetches through getRestaurantFn with TanStack Query key
 *  ['restaurant-menu', venueId, channel]; projects section rows into
 *  presentReviewed and renders the shared InteractiveMenuView (with the
 *  waiter card), never a separate renderer. Reviewed observations only —
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
  // default tab and its renderer is unchanged.
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
          <InteractiveMenuView menu={menu} locale={lang} rates={rates} />
        </div>
      )}
      {tab === "pages" && showPagesTab && <MenuPagesViewer pages={pages} />}
    </section>
  );
}
