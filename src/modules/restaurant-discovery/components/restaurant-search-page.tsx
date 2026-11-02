import { useQuery } from "@tanstack/react-query";
import { Link, getRouteApi } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type SheetSnap,
} from "@/modules/restaurant-discovery/components/results-sheet";
import { VenueOverview } from "@/modules/restaurant-discovery/components/venue-overview";
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
import {
  browsePanel,
  menuPanel,
  overviewPanel,
  panelVenueId,
  reviewsPanel,
  type RestaurantPanel,
} from "@/modules/restaurant-discovery/panel-state";
import { getRestaurantReviewSummaryFn } from "@/modules/restaurant-discovery/restaurant-reviews.functions";
import { getRestaurantFn } from "@/modules/restaurant-discovery/restaurant.functions";
import { restaurantSearchSchema } from "@/modules/restaurant-discovery/restaurant.schema";
import type { RestaurantSearch } from "@/modules/restaurant-discovery/restaurant.schema";
import type {
  DishRestaurantResult,
  RestaurantResult,
} from "@/modules/restaurant-discovery/server/index";
import { getSessionStateFn, type SessionState } from "@/modules/user/session.functions";

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

export function RestaurantSearchPage() {
  const data = route.useLoaderData();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const preference = usePreferredCurrency();
  const copy = restaurantCopy(search.lang);
  const isDesktop = useIsDesktop();

  const [panel, setPanel] = useState<RestaurantPanel>(browsePanel);
  const selected = panelVenueId(panel);
  const previewOpen = panel.kind !== "browse";
  const [proposedBounds, setProposedBounds] = useState<MapBounds | null>(null);
  const [message, setMessage] = useState("");
  const [locating, setLocating] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetKey, setSheetKey] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [sheetSnap, setSheetSnap] = useState<SheetSnap>(0);
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

  const dishSlug = search.fromDish ?? data.results.dish?.slug ?? null;
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

  const applyPatch = (patch: Partial<RestaurantSearch>) => {
    const parsed = restaurantSearchSchema.safeParse({ ...search, ...patch });

    if (!parsed.success) {
      setMessage(parsed.error.issues.map((issue) => issue.message).join(". "));

      return;
    }

    setMessage("");
    void navigate({
      search: { ...parsed.data, lang: search.lang, fromDish: search.fromDish },
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

  const handleSelect = (id: string) => {
    setPanel(overviewPanel(id));

    if (!isDesktop) setSheetSnap(1);

    if (isDesktop) setDrawerOpen(true);
  };

  const closePreview = (focusResults: boolean) => {
    setPanel(browsePanel);

    if (focusResults) listTitleRef.current?.focus({ preventScroll: true });
  };

  const channelLabel = channelLabelFor(search.channel, copy);

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
  const selectedModel = selectedVenue === undefined ? null : modelFor(selectedVenue);

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
    setPanel(overviewPanel(venueId));

    if (!isDesktop) setSheetSnap(1);
  };

  const showMenuPanel = (venueId: string) => {
    setPanel(menuPanel(venueId));

    if (!isDesktop) setSheetSnap(2);
  };

  const showReviewsPanel = (venueId: string) => {
    setPanel(reviewsPanel(venueId));

    if (!isDesktop) setSheetSnap(2);
  };

  const showDishZero = isDishMode && rows.length === 0 && !datasetEmpty && data.areas.length > 0;

  const showDatasetZero = rows.length === 0 && (datasetEmpty || !hasScope);

  const showFiltersTight =
    rows.length === 0 && hasScope && !isDishMode && !datasetEmpty && data.areas.length > 0;

  const showNoArea =
    rows.length === 0 && hasScope && !isDishMode && !datasetEmpty && data.areas.length === 0;

  const countLabel =
    rows.length === 1 ? copy.placesOne : copy.placesCount.replace("{count}", String(rows.length));

  const resultsBody = (
    <>
      <FilterChips
        copy={copy}
        search={search}
        lang={search.lang}
        dishName={dishName}
        dishSlug={dishSlug}
        cuisineLabel={cuisineLabel}
        onPatch={applyPatch}
      />
      {conversion.unavailable && (
        <p aria-live="polite" className="mapapp-note">
          {copy.priceNote}
        </p>
      )}
      {showDatasetZero && (
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
      {isDishMode && datasetEmpty && (
        <p aria-live="polite" className="mapapp-note">
          {copy.noReviewedBody}
        </p>
      )}
      {showDishZero && (
        <div className="mapapp-status" aria-live="polite">
          <h3>{copy.noReviewedTitle}</h3>
          <p>{copy.noReviewedBody}</p>
          <div className="mapapp-status-actions">
            <button type="button" className="mapapp-primary-btn" onClick={clearDish}>
              {copy.browseNearby}
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
      {showFiltersTight && (
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
      {showNoArea && (
        <div className="mapapp-status" aria-live="polite">
          <h3>{copy.noAreaTitle}</h3>
          <p>{copy.noAreaBody}</p>
          <div className="mapapp-status-actions">
            <button type="button" className="mapapp-primary-btn" onClick={expandArea}>
              {copy.expandArea}
            </button>
            <button type="button" className="mapapp-ghost-btn" onClick={clearAll}>
              {copy.clearFilters}
            </button>
          </div>
        </div>
      )}
      {rows.length > 0 && (
        <>
          <p aria-live="polite" className="mapapp-count">
            {countLabel}
            {rows.length === search.limit &&
              ` · ${copy.placesCapped.replace("{limit}", String(search.limit))}`}
          </p>
          <ul className="mapapp-list" hidden={previewOpen && selectedModel !== null}>
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
            selectedModel !== null &&
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
                      <button
                        type="button"
                        className="mapapp-ghost-btn"
                        onClick={() => closePreview(true)}
                      >
                        {copy.backToResults}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h3>{copy.detailLoadingTitle}</h3>
                    <p>{copy.detailLoadingBody}</p>
                  </>
                )}
              </div>
            ) : (
              <VenueOverview
                copy={copy}
                highlights={highlights}
                lang={search.lang}
                locale={search.lang}
                offerings={detail.offerings}
                onBackToResults={() => closePreview(true)}
                backToResultsLabel={copy.backToResults}
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
                  distanceKm: selectedModel.distanceKm,
                }}
              />
            ))}
          {panel.kind === "menu" && selected !== null && (
            <RestaurantMenuPanel
              channel={search.channel}
              lang={search.lang}
              onBackToOverview={() => showOverviewPanel(selected)}
              rates={conversion.rates}
              venueId={selected}
              venueName={selectedModel?.name ?? null}
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
      <details className="mapapp-options">
        <summary>{copy.displayOptions}</summary>
        <CurrencySelector preference={preference} />
        <label className="mapapp-sort">
          <span>{copy.sortLabel}</span>
          <select
            value={search.sort}
            onChange={(event) => {
              const value = event.target.value;

              if (
                value === "recommended" ||
                value === "nearest" ||
                value === "price_low" ||
                value === "price_high"
              ) {
                applyPatch({ sort: value });
              }
            }}
          >
            <option value="recommended">{copy.sortRecommended}</option>
            <option value="nearest" disabled={search.longitude === undefined}>
              {copy.sortNearest}
            </option>
            <option value="price_low" disabled={!isDishMode}>
              {copy.sortPriceLow}
            </option>
            <option value="price_high" disabled={!isDishMode}>
              {copy.sortPriceHigh}
            </option>
          </select>
        </label>
      </details>
    </>
  );

  const chooserVisible = chooserManual || (chooserAuto && !chooserDismissed);

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
              emptyNote={isDishMode ? copy.noReviewedBody : copy.mapEmpty}
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
            {userPos?.accuracyMeters !== null && userPos?.accuracyMeters !== undefined && (
              <span className="mapapp-accuracy" aria-live="polite">
                {copy.locationAccuracy.replace("{meters}", String(userPos.accuracyMeters))}
              </span>
            )}
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
              aria-label={copy.recenter}
              title={copy.recenter}
            >
              <span aria-hidden="true" className="mapapp-recenter-dot" />
            </button>
          </div>
        </div>
        {isDesktop ? (
          <ResultsDrawer
            copy={copy}
            open={drawerOpen}
            onToggle={() => setDrawerOpen((open) => !open)}
            title={copy.resultsTitle}
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
            <p className="mapapp-region" aria-live="polite">
              {regionLabel}
            </p>
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
              summary={`${countLabel} · ${regionLabel}`}
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
