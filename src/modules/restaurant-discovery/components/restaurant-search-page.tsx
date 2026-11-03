import { useQuery } from "@tanstack/react-query";
import { Link, getRouteApi, useRouterState } from "@tanstack/react-router";
import { Crosshair, MapPin } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import {
  CurrencySelector,
  useExchangeRates,
  usePreferredCurrency,
} from "@/modules/restaurant-discovery/components/currency-tools";
import { FilterChips } from "@/modules/restaurant-discovery/components/filter-chips";
import { LocationChooser } from "@/modules/restaurant-discovery/components/location-chooser";
import {
  MapSearchBar,
  type SearchPick,
} from "@/modules/restaurant-discovery/components/map-search-bar";
import { PanelToolbar } from "@/modules/restaurant-discovery/components/panel-toolbar";
import {
  PriceComparePanel,
  type PriceCompareRow,
} from "@/modules/restaurant-discovery/components/price-compare-panel";
import { RestaurantCard } from "@/modules/restaurant-discovery/components/restaurant-card";
import type { RestaurantCardModel } from "@/modules/restaurant-discovery/components/restaurant-card";
import { restaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import { RestaurantFiltersSheet } from "@/modules/restaurant-discovery/components/restaurant-filters-sheet";
import type {
  MapBounds,
  FrameRequest,
} from "@/modules/restaurant-discovery/components/restaurant-map";
import { RestaurantMapPanel } from "@/modules/restaurant-discovery/components/restaurant-map-panel";
import { RestaurantMenuPanel } from "@/modules/restaurant-discovery/components/restaurant-menu-panel";
import { RestaurantReviewsPanel } from "@/modules/restaurant-discovery/components/restaurant-reviews-panel";
import { ResultsDrawer } from "@/modules/restaurant-discovery/components/results-drawer";
import {
  ResultsSheet,
  formatSheetSummary,
  resolveResultsState,
  type ResultsState,
  type SheetSnap,
} from "@/modules/restaurant-discovery/components/results-sheet";
import {
  VenueOverview,
  VenueOverviewSkeleton,
} from "@/modules/restaurant-discovery/components/venue-overview";
import {
  queryGeolocationPermission,
  readSavedCamera,
  readStoredPlace,
  requestUserPosition,
  writeSavedCamera,
  writeStoredPlace,
  type UserPosition,
} from "@/modules/restaurant-discovery/location-storage";
import { CITY_PRESETS, DEFAULT_MAP_CENTER } from "@/modules/restaurant-discovery/map-bounds";
import { selectMenuHighlights } from "@/modules/restaurant-discovery/menu-presentation";
import { panelForRoute, type RestaurantPanel } from "@/modules/restaurant-discovery/panel-state";
import { getRestaurantReviewSummaryFn } from "@/modules/restaurant-discovery/restaurant-reviews.functions";
import { getRestaurantFn } from "@/modules/restaurant-discovery/restaurant.functions";
import { restaurantSearchSchema } from "@/modules/restaurant-discovery/restaurant.schema";
import type {
  RestaurantSearch,
  RestaurantVenueView,
} from "@/modules/restaurant-discovery/restaurant.schema";
import type {
  DishRestaurantResult,
  RestaurantResult,
} from "@/modules/restaurant-discovery/server/index";
import { getSessionStateFn, type SessionState } from "@/modules/user/session.functions";
import { formatMoney } from "@/shared/money";

const route = getRouteApi("/restaurants/");

const mapAvailable = z.url().safeParse(import.meta.env.VITE_MAP_STYLE_URL).success;

function boundsZoom(west: number, east: number, south: number, north: number): number {
  const span = Math.max(Math.abs(east - west), Math.abs(north - south));

  if (span > 20) return 4;

  if (span > 5) return 6;

  if (span > 1) return 9;

  if (span > 0.2) return 11;

  return 13;
}

function useIsDesktop(): boolean {
  // SSR-safe: the first client render matches the server (mobile shell),
  // then syncs to the real viewport without remounting the map.
  const [desktop, setDesktop] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 64rem)");
    const update = () => setDesktop(query.matches);

    update();
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, []);

  return desktop;
}

function regionSearchKey(search: RestaurantSearch): string {
  return JSON.stringify({
    q: search.q,
    area: search.area,
    cuisine: search.cuisine,
    dish: search.dish ?? null,
    west: search.west ?? null,
    south: search.south ?? null,
    east: search.east ?? null,
    north: search.north ?? null,
    longitude: search.longitude ?? null,
    latitude: search.latitude ?? null,
    radius: search.radius,
    channel: search.channel,
    portion: search.portion ?? null,
  });
}

/** In-sheet loading placeholder: the map stays mounted behind it, no
 *  global blocking spinner, no fake percent, no timers. */
export function SearchResultsSkeleton({ label }: { label: string }) {
  return (
    <div className="mapapp-skeleton" aria-live="polite" aria-busy="true" aria-label={label}>
      <p className="mapapp-note">{label}</p>
      <ul className="mapapp-list" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <li key={index} className="mapapp-skel-card">
            <span className="mapapp-skel-line wide" />
            <span className="mapapp-skel-line" />
            <span className="mapapp-skel-line narrow" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Peek-strip label for an empty result set. The verified count never
 *  dominates an empty sheet: the peek shows the concise state title. */
function emptyPeekLabel(kind: ResultsState, copy: RestaurantCopy): string {
  if (kind === "no-evidence") return copy.noReviewedTitle;

  if (kind === "no-area") return copy.noAreaTitle;

  if (kind === "no-scope") return copy.chooserTitle;

  if (kind === "empty-catalog") return copy.emptyDatasetTitle;

  if (kind === "no-match") return copy.noMatchTitle;

  return copy.resultsTitle;
}

/** Map-overlay copy for each empty condition. Basemap labels stay
 *  untouched: this text only describes the app record set. */
/** Overlay copy contract for the map when pins cannot be shown. */
interface MapEmptyCopy {
  readonly title?: string;
  readonly body: string;
}

function mapEmptyText(
  kind: ResultsState | null,
  copy: RestaurantCopy,
  isDishMode: boolean,
): MapEmptyCopy {
  if (kind === "loading") {
    return { body: copy.emptySearching };
  }

  if (kind === "no-evidence") return { title: copy.noReviewedTitle, body: copy.noReviewedBody };

  if (kind === "no-area") return { title: copy.noAreaTitle, body: copy.noAreaBody };

  if (kind === "no-scope") return { title: copy.chooserTitle, body: copy.chooserBody };

  if (kind === "empty-catalog") {
    return { title: copy.emptyDatasetTitle, body: copy.emptyDatasetBody };
  }

  if (kind === "no-match") return { title: copy.noMatchTitle, body: copy.noMatchBody };

  if (isDishMode) return { body: copy.noReviewedBody };

  return { body: copy.mapEmpty };
}

/** Sheet snap for the first paint: a URL-backed venue panel must be
 *  visible immediately, never hidden under the peek strip. */
function initialSnapForUrl(search: {
  readonly venue?: string | undefined;
  readonly view: string;
}): SheetSnap {
  if (search.venue === undefined || search.view === "browse") return 0;

  if (search.view === "overview") return 1;

  return 2;
}

/** Canonical in-map href for a result card. Panel transitions stay on the
 *  /restaurants route (same mounted map, no refetch), so Back restores the
 *  exact list, filters, and camera. */
function venueHrefFor(model: RestaurantCardModel): string {
  const params = new URLSearchParams();

  params.set("lang", model.detailSearch.lang);
  params.set("channel", model.detailSearch.channel);
  params.set("venue", model.id);
  params.set("view", "menu");

  if (model.detailSearch.variant !== undefined) {
    params.set("item", model.detailSearch.variant);
  }

  if (model.detailSearch.dish !== undefined) {
    params.set("dish", model.detailSearch.dish);
  }

  if (model.detailSearch.fromDish !== undefined) {
    params.set("fromDish", model.detailSearch.fromDish);
  }

  return `/restaurants?${params.toString()}`;
}

export function RestaurantSearchPage() {
  const data = route.useLoaderData();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const preference = usePreferredCurrency();
  const copy = restaurantCopy(search.lang);
  const isDesktop = useIsDesktop();

  // Canonical URL-backed restaurant state: the selected venue and panel
  // live in ?venue=&view=, so deep links, refreshes, and browser Back
  // restore them without a second page. Ephemeral UI (snaps, scroll,
  // hover) stays local, and the map stays mounted because panel changes
  // never leave this route.
  const selected = search.venue ?? null;
  const panel: RestaurantPanel = panelForRoute(search);
  const previewOpen = panel.kind !== "browse";
  const [proposedBounds, setProposedBounds] = useState<MapBounds | null>(null);
  const [message, setMessage] = useState("");
  const [locating, setLocating] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetKey, setSheetKey] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(true);
  // Deep links and refreshes hydrate the venue panel from the URL; the
  // sheet opens enough to show it instead of hiding it under the peek
  // strip. Later panel switches manage the snap explicitly.
  const [sheetSnap, setSheetSnap] = useState<SheetSnap>(() => initialSnapForUrl(search));
  // Local typed panel state for the in-map Results | Compare prices
  // toggle. No route change, no refetch: rows are already server-ordered.
  const [compareOpen, setCompareOpen] = useState(false);
  const [frame, setFrame] = useState<FrameRequest | null>(null);
  const [userPos, setUserPos] = useState<UserPosition | null>(null);
  const [chooserManual, setChooserManual] = useState(false);
  const [chooserDismissed, setChooserDismissed] = useState(false);
  const [chooserAuto, setChooserAuto] = useState(false);

  const initRan = useRef(false);
  const firstSearch = useRef(search);
  const latestKey = useRef("");
  const listTitleRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const isDishMode = data.results.dish !== null;

  const rows: ReadonlyArray<RestaurantResult | DishRestaurantResult> = isDishMode
    ? data.results.dishItems
    : data.results.items;

  const currencies = data.results.dishItems.flatMap((item) =>
    item.currency === null ? [] : [item.currency],
  );

  const conversion = useExchangeRates(currencies, preference.currency);

  const requestRates = new Map(
    data.results.comparisonRates
      .filter((rate) => rate.quote === preference.currency)
      .map((rate) => [rate.base, rate]),
  );

  const dishName = data.results.dish?.name ?? data.results.dish?.slug ?? null;

  const hasCoords = search.longitude !== undefined || search.west !== undefined;
  const hasScope = search.area !== "" || hasCoords || search.q !== "" || search.cuisine !== "";
  const datasetEmpty = data.areas.length === 0 && rows.length === 0;

  const searchKey = useMemo(() => regionSearchKey(search), [search]);

  const panelKind = panel.kind;

  useEffect(() => {
    if (panelKind !== "browse") panelRef.current?.focus({ preventScroll: true });
  }, [panelKind, selected]);

  useEffect(() => {
    latestKey.current = searchKey;
  }, [searchKey]);

  const reportCamera = useCallback(
    (camera: { longitude: number; latitude: number; zoom: number }) => {
      writeSavedCamera({ searchKey: latestKey.current, ...camera });
    },
    [],
  );

  // Mount-once initial center, SSR-safe: pure rules from the loader
  // search. Session-camera restore happens via frame in the init effect.
  const [initialCenter] = useState(() => {
    const s = firstSearch.current;

    if (s.longitude !== undefined && s.latitude !== undefined) {
      return { longitude: s.longitude, latitude: s.latitude, zoom: 13 };
    }

    if (
      s.west !== undefined &&
      s.south !== undefined &&
      s.east !== undefined &&
      s.north !== undefined
    ) {
      const crosses = s.east < s.west;

      const longitude = crosses
        ? (((((s.west + s.east + 360) / 2 + 180) % 360) + 360) % 360) - 180
        : (s.west + s.east) / 2;

      return {
        longitude,
        latitude: (s.south + s.north) / 2,
        zoom: boundsZoom(s.west, s.east, s.south, s.north),
      };
    }

    return { ...DEFAULT_MAP_CENTER };
  });

  const [suppressFit, setSuppressFit] = useState(false);

  const regionLabel = (() => {
    if (search.longitude !== undefined) return copy.mapRegionOrigin;

    if (search.west !== undefined) return copy.mapRegionBounds;

    if (search.area !== "") return copy.mapRegionArea.replace("{area}", search.area);

    return copy.mapRegionDefault;
  })();

  const cuisineLabel =
    search.cuisine === ""
      ? null
      : (data.cuisines.find((cuisine) => cuisine.slug === search.cuisine)?.displayName ??
        search.cuisine);

  const activeFilterCount =
    (search.cuisine === "" ? 0 : 1) +
    (search.channel === "dine_in" ? 0 : 1) +
    (search.portion === undefined ? 0 : 1) +
    (search.budget === undefined ? 0 : 1) +
    (search.sort === "recommended" ? 0 : 1);

  const applyPatch = (patch: Partial<RestaurantSearch & RestaurantVenueView>) => {
    const parsed = restaurantSearchSchema.safeParse({ ...search, ...patch });

    if (!parsed.success) {
      setMessage(parsed.error.issues.map((issue) => issue.message).join(". "));

      return;
    }

    setMessage("");
    // Panel identity rides along: filter edits must never close the open
    // venue. Explicit patch keys win (e.g. a venue-scoped clear), otherwise
    // the current URL state is preserved; undefined keys are stripped.
    void navigate({
      search: {
        ...parsed.data,
        lang: search.lang,
        fromDish: search.fromDish,
        venue: "venue" in patch ? patch.venue : search.venue,
        view: "view" in patch ? patch.view : search.view,
        item: "item" in patch ? patch.item : search.item,
      },
    });
  };

  const applyCity = (id: string) => {
    const city = CITY_PRESETS.find((entry) => entry.id === id);

    if (city === undefined) return;
    writeStoredPlace({ kind: "city", id });
    setMessage("");
    setProposedBounds(null);
    setChooserManual(false);
    setChooserDismissed(true);
    setChooserAuto(false);
    setFrame({
      key: `city-${id}-${Date.now()}`,
      longitude: city.longitude,
      latitude: city.latitude,
      zoom: city.zoom,
    });
    void navigate({
      replace: true,
      search: {
        ...search,
        area: "",
        longitude: undefined,
        latitude: undefined,
        west: city.west,
        south: city.south,
        east: city.east,
        north: city.north,
        sort: search.sort === "nearest" ? "recommended" : search.sort,
      },
    });
  };

  const locateUser = async (opts: { silent: boolean }) => {
    setLocating(true);

    try {
      const position = await requestUserPosition();
      setLocating(false);
      setMessage("");
      setUserPos(position);
      setChooserManual(false);
      setChooserDismissed(true);
      setChooserAuto(false);
      setFrame({
        key: `user-${Date.now()}`,
        longitude: position.longitude,
        latitude: position.latitude,
        zoom: 14,
      });
      void navigate({
        replace: true,
        search: {
          ...search,
          area: "",
          longitude: position.longitude,
          latitude: position.latitude,
          west: undefined,
          east: undefined,
          south: undefined,
          north: undefined,
        },
      });
    } catch {
      setLocating(false);

      if (!opts.silent) {
        setMessage(copy.locationDenied);
        setChooserManual(true);
      } else {
        setChooserAuto(true);
      }
    }
  };

  // Location-first initialization, exactly once per mount.
  useEffect(() => {
    if (initRan.current) return;

    initRan.current = true;
    const s = firstSearch.current;
    const hasRegion = s.area !== "" || s.longitude !== undefined || s.west !== undefined;

    if (hasRegion) {
      const saved = readSavedCamera(regionSearchKey(s));

      if (saved !== null) {
        setSuppressFit(true);
        setFrame({ key: `restore-${Date.now()}`, ...saved });
      }

      return;
    }

    const stored = readStoredPlace();

    if (stored !== null) {
      const city = CITY_PRESETS.find((entry) => entry.id === stored.id);

      if (city !== undefined) {
        setProposedBounds(null);
        setFrame({
          key: `city-${city.id}-${Date.now()}`,
          longitude: city.longitude,
          latitude: city.latitude,
          zoom: city.zoom,
        });
        void navigate({
          replace: true,
          search: {
            ...s,
            area: "",
            longitude: undefined,
            latitude: undefined,
            west: city.west,
            south: city.south,
            east: city.east,
            north: city.north,
            sort: s.sort === "nearest" ? "recommended" : s.sort,
          },
        });

        return;
      }
    }

    void queryGeolocationPermission().then((permission) => {
      if (permission !== "granted") {
        setChooserAuto(true);

        return;
      }

      void requestUserPosition()
        .then((position) => {
          setUserPos(position);
          setFrame({
            key: `user-${Date.now()}`,
            longitude: position.longitude,
            latitude: position.latitude,
            zoom: 14,
          });
          void navigate({
            replace: true,
            search: {
              ...firstSearch.current,
              area: "",
              longitude: position.longitude,
              latitude: position.latitude,
              west: undefined,
              east: undefined,
              south: undefined,
              north: undefined,
            },
          });
        })
        .catch(() => {
          setChooserAuto(true);
        });
    });
    // Mount-only: reacting later would fight the user's own navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const expandArea = () => {
    setMessage("");
    void navigate({
      search: {
        ...search,
        area: "",
        longitude: undefined,
        latitude: undefined,
        west: undefined,
        south: undefined,
        east: undefined,
        north: undefined,
        sort: search.sort === "nearest" ? "recommended" : search.sort,
      },
    });
  };

  const clearDish = () => {
    setMessage("");

    const nextSort =
      search.sort === "price_low" || search.sort === "price_high" ? "recommended" : search.sort;

    void navigate({
      search: {
        ...search,
        dish: undefined,
        portion: undefined,
        budget: undefined,
        currency: undefined,
        sort: nextSort,
      },
    });
  };

  const clearAll = () => {
    setMessage("");
    void navigate({
      search: {
        ...search,
        q: "",
        area: "",
        cuisine: "",
        dish: undefined,
        portion: undefined,
        budget: undefined,
        currency: undefined,
        longitude: undefined,
        latitude: undefined,
        west: undefined,
        south: undefined,
        east: undefined,
        north: undefined,
        channel: "dine_in",
        sort: "recommended",
        radius: 5000,
        venue: undefined,
        view: "browse",
        item: undefined,
      },
    });
  };

  const submitText = (text: string) => {
    if (text === "") return;

    applyPatch({
      q: text,
      dish: undefined,
      cuisine: undefined,
      portion: undefined,
      budget: undefined,
      currency: undefined,
    });
  };

  const applyPick = (pick: SearchPick) => {
    if (pick.kind === "dish") {
      applyPatch({
        dish: pick.id,
        q: "",
        cuisine: undefined,
        portion: undefined,
        budget: undefined,
        currency: undefined,
      });

      return;
    }

    applyPatch({
      cuisine: pick.id,
      q: "",
      dish: undefined,
      portion: undefined,
      budget: undefined,
      currency: undefined,
    });
  };

  const openPanel = (venueId: string, view: "overview" | "menu" | "reviews"): void => {
    void navigate({ search: { ...search, venue: venueId, view } });
  };

  const handleSelect = (id: string) => {
    openPanel(id, "overview");

    if (!isDesktop) setSheetSnap(1);

    if (isDesktop) setDrawerOpen(true);
  };

  const closePreview = (focusResults: boolean) => {
    void navigate({ search: { ...search, venue: undefined, view: "browse", item: undefined } });

    if (focusResults) listTitleRef.current?.focus({ preventScroll: true });
  };

  // Results-level Back: when the Food Journey carried a dish filter
  // (`fromDish`), Back returns to that dish; otherwise browse is the root
  // and the toolbar renders no Back at all.
  const goDish = () => {
    if (search.fromDish === undefined) return;

    void navigate({
      to: "/dishes/$dishId",
      params: { dishId: search.fromDish },
      search: { lang: search.lang },
    });
  };

  const channelLabel = channelLabelFor(search.channel, copy);

  // The currency selector only earns its place when comparable priced
  // dish evidence is on screen; otherwise it stays hidden instead of
  // implying conversions that do not exist.
  const showCurrency =
    isDishMode &&
    rows.some((venue) => isDishRow(venue) && venue.amount !== null && venue.currency !== null);

  const modelFor = (venue: RestaurantResult | DishRestaurantResult): RestaurantCardModel => {
    const dish = isDishRow(venue) ? venue : null;

    return {
      id: venue.id,
      name: venue.name,
      area: venue.area,
      address: venue.address,
      distanceKm: venue.distance_meters === null ? null : (venue.distance_meters / 1000).toFixed(1),
      dish:
        dish === null
          ? null
          : {
              itemName: dish.item_name,
              variantName: dish.variant_name,
              amount: dish.amount,
              currency: dish.currency,
              matchKind: dish.match_kind,
              evidenceDate: dish.evidence_observed_at.slice(0, 10),
              stale: dish.current_enough === false,
              channelLabel,
              sourceCategory: dish.source_category,
              rate:
                requestRates.get(dish.currency ?? "") ?? conversion.rates.get(dish.currency ?? ""),
            },
      detailSearch: {
        lang: search.lang,
        channel: search.channel,
        variant: dish?.variant_id,
        dish: search.dish,
        fromDish: search.fromDish,
      },
    };
  };

  const selectedVenue = selected === null ? undefined : rows.find((venue) => venue.id === selected);
  const rowModel = selectedVenue === undefined ? null : modelFor(selectedVenue);

  const resultsLabel = copy.resultsTitle;
  const compareLabel = copy.comparePrices;
  const compareGroupLabel = copy.resultsViewLabel;

  // Comparison rows reuse the card model: same canonical dish, same
  // server ordering, no refetch. Venues without priced dish evidence are
  // kept so the panel can render its honest empty/unpriced states.
  const compareRows: ReadonlyArray<PriceCompareRow> = isDishMode
    ? rows.flatMap((venue) => {
        const model = modelFor(venue);

        if (model.dish === null) {
          return [];
        }

        return [
          {
            venueId: model.id,
            venueName: model.name,
            area: model.area,
            itemName: model.dish.itemName,
            variantName: model.dish.variantName,
            amount: model.dish.amount,
            currency: model.dish.currency,
            evidenceDate: model.dish.evidenceDate,
            stale: model.dish.stale,
            channelLabel: model.dish.channelLabel,
            sourceCategory: model.dish.sourceCategory,
            rate: model.dish.rate,
            venueHref: venueHrefFor(model),
          },
        ];
      })
    : [];

  const detailQuery = useQuery({
    queryKey: ["restaurant-detail", selected, search.channel],
    queryFn: () => getRestaurantFn({ data: { venueId: selected ?? "", channel: search.channel } }),
    enabled: selected !== null,
    staleTime: 60000,
    retry: false,
  });

  const summaryQuery = useQuery({
    queryKey: ["customer-reviews", selected, "summary"],
    queryFn: () => getRestaurantReviewSummaryFn({ data: { venueId: selected ?? "" } }),
    enabled: selected !== null,
    staleTime: 60000,
    retry: false,
  });

  const sessionQuery = useQuery({
    queryKey: ["session-state"],
    queryFn: () => getSessionStateFn(),
    staleTime: 60000,
    retry: false,
  });

  const session: SessionState = sessionQuery.data ?? { status: "unavailable" };

  const detail =
    selected !== null && detailQuery.data !== undefined && detailQuery.data.venue.id === selected
      ? detailQuery.data
      : null;

  // Deep links hydrate even when the venue is outside the current result
  // page: the detail query (keyed by venue + channel) supplies the card
  // identity, so users never have to find the pin first.
  let selectedModel: RestaurantCardModel | null = rowModel;

  if (selectedModel === null && detail !== null) {
    selectedModel = {
      id: detail.venue.id,
      name: detail.venue.name,
      area: detail.venue.area,
      address: detail.venue.address,
      distanceKm: null,
      dish: null,
      detailSearch: {
        lang: search.lang,
        channel: search.channel,
        variant: search.item,
        dish: search.dish,
        fromDish: search.fromDish,
      },
    };
  }

  const highlights = useMemo(
    () => (detail === null ? [] : selectMenuHighlights(detail.offerings, 3)),
    [detail],
  );

  const reviewSummary =
    selected !== null &&
    summaryQuery.data !== undefined &&
    summaryQuery.data.venueId === selected &&
    summaryQuery.data.total > 0
      ? { total: summaryQuery.data.total, average: summaryQuery.data.average }
      : null;

  const showOverviewPanel = (venueId: string) => {
    openPanel(venueId, "overview");

    if (!isDesktop) setSheetSnap(1);
  };

  const showMenuPanel = (venueId: string) => {
    openPanel(venueId, "menu");

    if (!isDesktop) setSheetSnap(2);
  };

  const showReviewsPanel = (venueId: string) => {
    openPanel(venueId, "reviews");

    if (!isDesktop) setSheetSnap(2);
  };

  const navigating = useRouterState({ select: (state) => state.isLoading });

  // Distinct empty conditions share one resolver with the sheet, drawer,
  // and map overlay: loading / no-scope / no-evidence / no-area /
  // empty-catalog / no-match are never conflated.
  const emptyKind: ResultsState | null = resolveResultsState({
    rows: rows.length,
    isDishMode,
    datasetEmpty,
    hasScope,
    hasArea: data.areas.length > 0,
    isLoading: navigating,
  });

  const loadingLabel = copy.emptySearching;

  const mapEmpty = mapEmptyText(emptyKind, copy, isDishMode);

  const countLabel =
    rows.length === 1 ? copy.placesOne : copy.placesCount.replace("{count}", String(rows.length));

  // Price-scope label mirrors the actual geographic filter: center+radius
  // reports "Within X km", a bounded viewport reports "In this map area"
  // (never a false radius), otherwise the named area.
  let priceScopeLabel = copy.priceSummaryMapArea;

  if (search.longitude !== undefined) {
    const radiusText = search.radius >= 1000 ? `${search.radius / 1000} km` : `${search.radius} m`;

    priceScopeLabel = copy.priceSummaryWithin.replace("{radius}", radiusText);
  } else if (search.area !== "") {
    priceScopeLabel = search.area;
  }

  const venueName = selectedModel?.name ?? detail?.venue.name ?? "";

  // Compact browse context beneath the toolbar title: dish and/or radius
  // only, and only when relevant. Every other filter stays in the chips.
  let toolbarContext: string | null = null;

  if (panel.kind === "browse") {
    const parts: Array<string> = [];

    if (dishName !== null) parts.push(dishName);

    if (search.longitude !== undefined) {
      const radiusText =
        search.radius >= 1000 ? `${search.radius / 1000} km` : `${search.radius} m`;

      parts.push(copy.priceSummaryWithin.replace("{radius}", radiusText));
    } else if (search.area !== "") {
      parts.push(search.area);
    }

    toolbarContext = parts.length > 0 ? parts.join(" · ") : null;
  }

  // One route-aware toolbar per view: the single primary Back. Venue panels
  // render no own back buttons; every transition stays on this route (same
  // mounted map, no refetch), preserving dish/radius/venue/item/quantities
  // through the URL and the existing stores.
  let toolbar: ReactNode;

  if (panel.kind === "overview") {
    toolbar = (
      <PanelToolbar
        view="overview"
        title={venueName}
        backText={copy.resultsTitle}
        backLabel={copy.backToResults}
        onBack={() => closePreview(true)}
      />
    );
  } else if (panel.kind === "menu") {
    toolbar = (
      <PanelToolbar
        view="menu"
        title={venueName}
        backText={venueName === "" ? copy.backToResults : venueName}
        backLabel={copy.menuBackToOverview}
        onBack={selected === null ? null : () => showOverviewPanel(selected)}
      />
    );
  } else if (panel.kind === "reviews") {
    toolbar = (
      <PanelToolbar
        view="reviews"
        title={venueName}
        sectionLabel={copy.panelReviewsTitle}
        backText={venueName === "" ? copy.backToResults : venueName}
        backLabel={copy.menuBackToOverview}
        onBack={selected === null ? null : () => showOverviewPanel(selected)}
      />
    );
  } else {
    toolbar = (
      <PanelToolbar
        view="browse"
        title={copy.resultsTitle}
        countLabel={countLabel}
        contextLine={toolbarContext}
        backText={search.fromDish === undefined ? null : copy.backToDish}
        backLabel={copy.backToDish}
        onBack={search.fromDish === undefined ? null : goDish}
      />
    );
  }

  const resultsBody = (
    <>
      {toolbar}
      {!previewOpen && (
        <FilterChips
          copy={copy}
          search={search}
          dishName={dishName}
          cuisineLabel={cuisineLabel}
          onPatch={applyPatch}
        />
      )}
      {!previewOpen && conversion.unavailable && (
        <p aria-live="polite" className="mapapp-note">
          {copy.priceNote}
        </p>
      )}
      {!previewOpen && emptyKind === "loading" && <SearchResultsSkeleton label={loadingLabel} />}
      {!previewOpen && emptyKind === "no-scope" && (
        <div className="mapapp-status" aria-live="polite">
          <h3>{copy.chooserTitle}</h3>
          <p>{copy.chooserBody}</p>
          <div className="mapapp-status-actions">
            <button
              type="button"
              className="mapapp-primary-btn"
              onClick={() => setChooserManual(true)}
            >
              <MapPin aria-hidden="true" />
              {copy.regionChoose}
            </button>
            <Link className="mapapp-ghost-btn" to="/dishes" search={{ lang: search.lang }}>
              {copy.emptyExplore}
            </Link>
          </div>
        </div>
      )}
      {!previewOpen && emptyKind === "empty-catalog" && (
        <div className="mapapp-status" aria-live="polite">
          <h3>{copy.emptyDatasetTitle}</h3>
          <p>{copy.emptyDatasetBody}</p>
          <div className="mapapp-status-actions">
            <Link className="mapapp-primary-btn" to="/dishes" search={{ lang: search.lang }}>
              {copy.emptyExplore}
            </Link>
            <Link className="mapapp-ghost-btn" to="/scan" search={{ lang: search.lang }}>
              {copy.emptyScan}
            </Link>
          </div>
        </div>
      )}
      {!previewOpen && emptyKind === "no-evidence" && (
        <div className="mapapp-status" aria-live="polite">
          <h3>{copy.noReviewedTitle}</h3>
          <p>{copy.noReviewedBody}</p>
          <div className="mapapp-status-actions">
            <button type="button" className="mapapp-primary-btn" onClick={clearDish}>
              {copy.clearDish}
            </button>
            <button type="button" className="mapapp-ghost-btn" onClick={expandArea}>
              {copy.expandArea}
            </button>
            <button type="button" className="mapapp-ghost-btn" onClick={clearAll}>
              {copy.clearFilters}
            </button>
          </div>
        </div>
      )}
      {!previewOpen && emptyKind === "no-match" && (
        <div className="mapapp-status" aria-live="polite">
          <h3>{copy.noMatchTitle}</h3>
          <p>{copy.noMatchBody}</p>
          <div className="mapapp-status-actions">
            <button type="button" className="mapapp-primary-btn" onClick={clearAll}>
              {copy.clearFilters}
            </button>
            <button type="button" className="mapapp-ghost-btn" onClick={expandArea}>
              {copy.expandArea}
            </button>
          </div>
        </div>
      )}
      {!previewOpen && emptyKind === "no-area" && (
        <div className="mapapp-status" aria-live="polite">
          <h3>{copy.noAreaTitle}</h3>
          <p>{copy.noAreaBody}</p>
          <div className="mapapp-status-actions">
            <button
              type="button"
              className="mapapp-primary-btn"
              onClick={() => setChooserManual(true)}
            >
              <MapPin aria-hidden="true" />
              {copy.regionChoose}
            </button>
            <button type="button" className="mapapp-ghost-btn" onClick={expandArea}>
              {copy.expandArea}
            </button>
            <button type="button" className="mapapp-ghost-btn" onClick={clearAll}>
              {copy.clearFilters}
            </button>
          </div>
        </div>
      )}
      {!previewOpen && rows.length > 0 && (
        <>
          <p aria-live="polite" className="mapapp-count">
            {countLabel}
            {rows.length === search.limit &&
              ` · ${copy.placesCapped.replace("{limit}", String(search.limit))}`}
          </p>
          {isDishMode && dishName !== null && data.results.ranges.length > 0 && (
            <div className="mapapp-price-scope" aria-live="polite">
              <p className="mapapp-price-scope-head">
                {dishName} · {priceScopeLabel}
              </p>
              {data.results.ranges.map((range) => (
                <p key={range.currency} className="mapapp-price-scope-range">
                  {formatMoney(range.minimum, range.currency, search.lang)}
                  {" – "}
                  {formatMoney(range.maximum, range.currency, search.lang)}{" "}
                  <span>{range.currency}</span>
                  {" · "}
                  {copy.priceSummaryVenues.replace("{count}", String(range.venue_count))}
                </p>
              ))}
              <button
                type="button"
                className="mapapp-ghost-btn"
                onClick={() => setCompareOpen(true)}
              >
                {compareLabel}
              </button>
            </div>
          )}
          {isDishMode && (
            <fieldset className="mapapp-viewtoggle">
              <legend className="sr-only">{compareGroupLabel}</legend>{" "}
              <button
                type="button"
                aria-pressed={!compareOpen}
                className="mapapp-ghost-btn"
                onClick={() => setCompareOpen(false)}
              >
                {resultsLabel}
              </button>
              <button
                type="button"
                aria-pressed={compareOpen}
                className="mapapp-ghost-btn"
                onClick={() => setCompareOpen(true)}
              >
                {compareLabel}
              </button>
            </fieldset>
          )}
          {isDishMode && compareOpen && selectedModel === null && (
            <PriceComparePanel
              rows={compareRows}
              sortMode={search.sort}
              ratesAvailable={!conversion.unavailable}
              locale={search.lang}
            />
          )}
          <ul
            className="mapapp-list"
            hidden={selectedModel !== null || (isDishMode && compareOpen)}
          >
            {rows.map((venue) => {
              const model = modelFor(venue);

              return (
                <li
                  key={venue.id}
                  id={`res-card-${venue.id}`}
                  data-selected={selected === venue.id}
                >
                  <RestaurantCard
                    copy={copy}
                    model={model}
                    selected={selected === venue.id}
                    onShowOnMap={
                      mapAvailable
                        ? () => {
                            handleSelect(venue.id);

                            if (!isDesktop) setSheetSnap(0);
                          }
                        : null
                    }
                    onOpenVenue={() => handleSelect(venue.id)}
                    onViewMenu={() => showMenuPanel(venue.id)}
                  />
                </li>
              );
            })}
          </ul>
        </>
      )}
      {(panel.kind === "overview" || panel.kind === "menu" || panel.kind === "reviews") && (
        <div ref={panelRef} tabIndex={-1} data-panel={panel.kind}>
          {panel.kind === "overview" &&
            selected !== null &&
            (detail === null ? (
              <div className="mapapp-status" aria-live="polite">
                {detailQuery.isError ? (
                  <>
                    <h3>{copy.detailFailedTitle}</h3>
                    <p>{copy.detailFailedBody}</p>
                    <div className="mapapp-status-actions">
                      <button
                        type="button"
                        className="mapapp-primary-btn"
                        onClick={() => void detailQuery.refetch()}
                      >
                        {copy.retryAction}
                      </button>
                    </div>
                  </>
                ) : (
                  <VenueOverviewSkeleton
                    label={copy.detailLoadingTitle}
                    hint={copy.detailLoadingBody}
                  />
                )}
              </div>
            ) : (
              <VenueOverview
                copy={copy}
                highlights={highlights}
                lang={search.lang}
                locale={search.lang}
                offerings={detail.offerings}
                fromDish={search.fromDish ?? null}
                onOpenMenuItem={() => showMenuPanel(detail.venue.id)}
                onShowMenu={() => showMenuPanel(detail.venue.id)}
                onShowReviews={() => showReviewsPanel(detail.venue.id)}
                photos={detail.photos}
                rates={conversion.rates}
                reviewSummary={reviewSummary}
                venue={{
                  id: detail.venue.id,
                  name: detail.venue.name,
                  businessName: detail.venue.business_name,
                  area: detail.venue.area,
                  address: detail.venue.address,
                  latitude: detail.venue.latitude,
                  longitude: detail.venue.longitude,
                  distanceKm: selectedModel?.distanceKm ?? null,
                }}
              />
            ))}
          {panel.kind === "menu" && selected !== null && (
            <RestaurantMenuPanel
              key={`${selected}:${search.channel}`}
              channel={search.channel}
              lang={search.lang}
              onChannelChange={(value) => {
                void navigate({ search: { ...search, channel: value } });
              }}
              rates={conversion.rates}
              venueId={selected}
              venueName={selectedModel?.name ?? null}
              countryCode={detail?.venue.country_code ?? null}
              initialExpandedItemId={search.item}
            />
          )}
          {panel.kind === "reviews" && selected !== null && (
            <RestaurantReviewsPanel
              locale={search.lang}
              onBackToOverview={() => showOverviewPanel(selected)}
              session={session}
              venueId={selected}
            />
          )}
        </div>
      )}
      {!previewOpen && (
        <details className="mapapp-options">
          <summary>{copy.displayOptions}</summary>
          {showCurrency && <CurrencySelector preference={preference} />}
        </details>
      )}
    </>
  );

  const chooserVisible = chooserManual || (chooserAuto && !chooserDismissed);

  const accuracyLabel =
    userPos?.accuracyMeters === null || userPos?.accuracyMeters === undefined
      ? null
      : copy.locationAccuracy.replace("{meters}", String(userPos.accuracyMeters));

  const cappedNote =
    rows.length === search.limit
      ? copy.placesCapped.replace("{limit}", String(search.limit))
      : null;

  const sheetSummary =
    emptyKind === null
      ? formatSheetSummary(countLabel, cappedNote)
      : emptyPeekLabel(emptyKind, copy);

  return (
    <div className="mapapp">
      <a href="#mapapp-results" className="mapapp-skip">
        {copy.skipMap}
      </a>
      <div className="mapapp-body" data-desktop={isDesktop}>
        <div className="mapapp-mapwrap">
          {mapAvailable ? (
            <RestaurantMapPanel
              points={rows}
              selected={selected}
              onSelect={handleSelect}
              onBounds={setProposedBounds}
              onCamera={reportCamera}
              lang={search.lang}
              center={initialCenter}
              emptyTitle={mapEmpty.title}
              emptyNote={mapEmpty.body}
              frame={frame}
              selectionPadding={
                isDesktop
                  ? { leftPx: drawerOpen ? 416 : 0 }
                  : { bottomRatio: sheetSnap === 2 ? 0.7 : 0.42 }
              }
              userPosition={userPos}
              fitKey={searchKey}
              suppressInitialFit={suppressFit}
            />
          ) : (
            <div className="discovery-map-fallback" aria-live="polite">
              <h2>{copy.mapFailedTitle}</h2>
              <p>{copy.mapConfigMissing}</p>
            </div>
          )}
          {proposedBounds !== null && mapAvailable && (
            <button
              type="button"
              className="mapapp-search-area"
              onClick={() => {
                // Pan never resets the dish: the spread preserves the
                // canonical dish filter; only the region is reframed.
                void navigate({
                  search: {
                    ...search,
                    ...proposedBounds,
                    area: "",
                    longitude: undefined,
                    latitude: undefined,
                    sort: search.sort === "nearest" ? "recommended" : search.sort,
                  },
                });
                setProposedBounds(null);
              }}
            >
              {copy.searchThisArea}
            </button>
          )}
          {chooserVisible && (
            <div className="mapapp-chooser-float">
              <LocationChooser
                copy={copy}
                locating={locating}
                dismissible
                onPickCity={applyCity}
                onUseLocation={() => void locateUser({ silent: false })}
                onDismiss={() => {
                  setChooserManual(false);
                  setChooserDismissed(true);
                  setChooserAuto(false);
                }}
              />
            </div>
          )}
          <div className="mapapp-maptools">
            <button
              type="button"
              className="mapapp-recenter"
              onClick={() => {
                if (userPos !== null) {
                  setFrame({
                    key: `recenter-${Date.now()}`,
                    longitude: userPos.longitude,
                    latitude: userPos.latitude,
                    zoom: 14,
                  });
                } else {
                  void locateUser({ silent: false });
                }
              }}
              disabled={locating}
              aria-label={
                accuracyLabel === null ? copy.recenter : `${copy.recenter} (${accuracyLabel})`
              }
              aria-describedby={accuracyLabel === null ? undefined : "mapapp-recenter-desc"}
              title={accuracyLabel === null ? copy.recenter : `${copy.recenter} (${accuracyLabel})`}
            >
              <Crosshair aria-hidden="true" />
            </button>
            {accuracyLabel !== null && (
              <span id="mapapp-recenter-desc" className="sr-only" aria-live="polite">
                {accuracyLabel}
              </span>
            )}
          </div>
        </div>
        {isDesktop ? (
          <ResultsDrawer
            copy={copy}
            open={drawerOpen}
            onToggle={() => setDrawerOpen((open) => !open)}
            title={copy.resultsTitle}
            state={emptyKind}
          >
            <MapSearchBar
              copy={copy}
              cuisines={data.cuisines}
              initialText={search.q}
              activeFilterCount={activeFilterCount}
              locationBusy={locating}
              overlay={false}
              onSubmitText={submitText}
              onPick={applyPick}
              onNearMe={() => void locateUser({ silent: false })}
              onOpenFilters={() => {
                setSheetKey((key) => key + 1);
                setSheetOpen(true);
              }}
              onOpenLocation={() => setChooserManual(true)}
            />
            {!previewOpen && (
              <p className="mapapp-region" aria-live="polite">
                {regionLabel}
              </p>
            )}
            <div id="mapapp-results">
              <h2 ref={listTitleRef} tabIndex={-1} className="sr-only">
                {copy.resultsTitle}
              </h2>
              {message !== "" && (
                <p role="alert" className="mapapp-alert">
                  {message}
                </p>
              )}
              {resultsBody}
            </div>
          </ResultsDrawer>
        ) : (
          <>
            <div className="mapapp-topsearch">
              <MapSearchBar
                copy={copy}
                cuisines={data.cuisines}
                initialText={search.q}
                activeFilterCount={activeFilterCount}
                locationBusy={locating}
                overlay
                onSubmitText={submitText}
                onPick={applyPick}
                onNearMe={() => void locateUser({ silent: false })}
                onOpenFilters={() => {
                  setSheetKey((key) => key + 1);
                  setSheetOpen(true);
                }}
                onOpenLocation={() => setChooserManual(true)}
              />
            </div>
            <ResultsSheet
              copy={copy}
              snap={sheetSnap}
              onSnapChange={setSheetSnap}
              title={copy.resultsTitle}
              summary={sheetSummary}
              state={emptyKind}
            >
              <div id="mapapp-results">
                <h2 ref={listTitleRef} tabIndex={-1} className="sr-only">
                  {copy.resultsTitle}
                </h2>
                {message !== "" && (
                  <p role="alert" className="mapapp-alert">
                    {message}
                  </p>
                )}
                {resultsBody}
              </div>
            </ResultsSheet>
          </>
        )}
      </div>
      <RestaurantFiltersSheet
        key={sheetKey}
        copy={copy}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        search={search}
        cuisines={data.cuisines}
        portions={data.results.portions}
        currencyCodes={preference.codes}
        dishActive={isDishMode}
        canSortNearest={search.longitude !== undefined}
        onApply={applyPatch}
        dishName={dishName}
        onClearDish={() => {
          setSheetOpen(false);
          clearDish();
        }}
        onClear={() => {
          setSheetOpen(false);
          clearAll();
        }}
      />
    </div>
  );
}

function isDishRow(row: RestaurantResult | DishRestaurantResult): row is DishRestaurantResult {
  return "variant_id" in row;
}

function channelLabelFor(channel: RestaurantSearch["channel"], copy: RestaurantCopy): string {
  if (channel === "takeaway") {
    return copy.takeaway;
  }

  if (channel === "delivery") {
    return copy.delivery;
  }

  return copy.dineIn;
}
