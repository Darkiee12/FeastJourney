import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { DishCarousel } from "@/components/dish/dish-carousel";
import {
  DiscoveryFallback,
  DiscoveryLoadingState,
  resolveDiscoveryFallbackState,
} from "@/components/home/discovery-fallback";
import {
  DiscoveryLocation,
  discoveryCityLabelFor,
  discoveryHeadingFor,
  discoveryServedScopeFor,
  discoverySubtitleFor,
  type DiscoveryCityOption,
  type DiscoveryServedScope,
} from "@/components/home/discovery-location";
import { isCityPlaceId, sanitizeCountryCode } from "@/components/home/recommend/quiz-model";
import { usePreciseLocation } from "@/components/home/recommend/use-precise-location";
import { getLocalCarouselFn, listCountriesFn } from "@/modules/food-discovery/food.functions";
import { getQuizRegionFn } from "@/modules/food-discovery/quiz.functions";
import { useFavoriteStatus } from "@/modules/user/components/save-dish-button";
import type { Locale, Messages } from "@/shared/i18n";

const rootRoute = getRouteApi("__root__");

const CAROUSEL_LIMIT = 5;

function countryNameFor(
  countries:
    | ReadonlyArray<{ readonly iso3166: string | null; readonly displayName: string | undefined }>
    | undefined,
  code: string | null,
): string | null {
  if (code === null) {
    return null;
  }

  return countries?.find((entry) => entry.iso3166 === code)?.displayName ?? code;
}

/**
 * Homepage food discovery: show relevant published dishes immediately,
 * letting location improve relevance rather than gate it. One exclusive
 * scope per request (precise nearby, city, country, or worldwide); the
 * server falls back honestly (nearby -> country -> honest empty; city ->
 * ancestor country -> honest empty) and labels the served scope honestly.
 * Scoped requests never widen to the worldwide pool: an empty city/country
 * pool renders the region-empty panel with an explicit "explore worldwide"
 * action, never silent unrelated dishes. Cards on screen are always
 * described by the scope that served them — never by a newly selected
 * region — because headings follow the last served response, not the
 * pending request.
 */
export function DiscoverySection({ copy, lang }: { copy: Messages; lang: Locale }) {
  const { session } = rootRoute.useRouteContext();

  // Precise location is explicit-only: the shared locator never prompts on
  // mount or on render. Coordinates never enter query keys, logs, or
  // persisted state — the precise scope keys on the locator success count.
  const precise = usePreciseLocation();

  // Explicit visitor choices. The destination overrides trusted detection;
  // worldwide is an explicit mode. A city choice carries a canonical place
  // id plus its display label and clears the country lane. Neither is
  // overwritten by async detection.
  const [worldwide, setWorldwide] = useState(false);
  const [destination, setDestination] = useState<string | null>(null);
  const [city, setCity] = useState<DiscoveryCityOption | null>(null);
  // Rotation seed for another set: same scope + same seed renders the same
  // set (stable within the session); bumping it renders another set.
  const [rotation, setRotation] = useState(0);
  const [activeScope, setActiveScope] = useState<string | null>(null);

  // Last SERVED response (scope + country/city + supplemented + precise
  // flag). Labels and the selector always describe these cards; a pending
  // refetch keeps the old labels until its own response commits.
  const [served, setServed] = useState<{
    key: string;
    scopeKey: string | null;
    country: string | null;
    city: DiscoveryCityOption | null;
    precise: boolean;
    supplemented: boolean;
  } | null>(null);

  // Trusted approximate country shared with the quiz cache key, so the
  // homepage issues one region request, not two. Cloudflare `cf-*` headers
  // are only honored behind a verified trusted proxy (see trusted-region);
  // locally only DEV_VISITOR_COUNTRY applies, otherwise the answer is an
  // honest null and discovery falls back to worldwide automatically.
  const quizRegionQuery = useQuery({
    queryKey: ["geo", "quiz-region"],
    queryFn: () => getQuizRegionFn(),
    retry: 1,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const trustedCountry = sanitizeCountryCode(quizRegionQuery.data?.country ?? "");

  const countriesQuery = useQuery({
    queryKey: ["catalog", "countries", lang],
    queryFn: () => listCountriesFn({ data: { locale: lang } }),
    retry: 1,
    staleTime: 5 * 60_000,
  });

  const effectiveCountry = destination ?? trustedCountry;
  const preciseFix = precise.status === "success" ? precise.fix : null;
  const geoSettled = !quizRegionQuery.isPending;

  // Exactly one scope per request — never coordinates, country, city, or
  // worldwide alongside each other. A city choice beats the country lane
  // but never travels with it.
  let scopeKey: string | null = null;

  if (worldwide) {
    scopeKey = "world";
  } else if (preciseFix !== null) {
    scopeKey = `nearby-${precise.successCount.toString()}`;
  } else if (city !== null) {
    scopeKey = `city-${city.id}`;
  } else if (effectiveCountry !== null) {
    scopeKey = `country-${effectiveCountry}`;
  } else if (geoSettled) {
    scopeKey = "world-auto";
  }

  const isAutoWorldwide = scopeKey === "world-auto";

  if (scopeKey !== activeScope) {
    setActiveScope(scopeKey);
    setRotation(0);
  }

  const carouselQuery = useQuery({
    enabled: scopeKey !== null,
    queryKey: ["catalog", "local-carousel", lang, scopeKey ?? "none", rotation],
    placeholderData: keepPreviousData,
    queryFn: () => {
      if (scopeKey === "world" || scopeKey === "world-auto") {
        return getLocalCarouselFn({
          data: { limit: CAROUSEL_LIMIT, locale: lang, seed: rotation, worldwide: true },
        });
      }

      if (preciseFix !== null) {
        return getLocalCarouselFn({
          data: {
            country: effectiveCountry ?? undefined,
            latitude: preciseFix.latitude,
            limit: CAROUSEL_LIMIT,
            locale: lang,
            longitude: preciseFix.longitude,
            seed: rotation,
          },
        });
      }

      if (city !== null && isCityPlaceId(city.id)) {
        return getLocalCarouselFn({
          data: { place: city.id, limit: CAROUSEL_LIMIT, locale: lang, seed: rotation },
        });
      }

      if (effectiveCountry !== null) {
        return getLocalCarouselFn({
          data: { country: effectiveCountry, limit: CAROUSEL_LIMIT, locale: lang, seed: rotation },
        });
      }

      throw new Error("location not ready");
    },
    retry: 1,
    staleTime: 60_000,
  });

  const requestKey = scopeKey === null ? null : `${scopeKey}:${rotation.toString()}`;

  if (
    requestKey !== null &&
    carouselQuery.data !== undefined &&
    (served === null || served.key !== requestKey)
  ) {
    // A city request never banks the ambient country: when the city falls
    // back to its ancestor country, the label resolves from the city's own
    // country hint instead of misnaming the trusted region.
    let servedCountry: string | null = null;

    if (!worldwide && city === null) {
      servedCountry = effectiveCountry;
    }

    setServed({
      key: requestKey,
      scopeKey,
      country: servedCountry,
      city,
      precise: preciseFix !== null,
      supplemented: carouselQuery.data.supplemented,
    });
  }

  const items = carouselQuery.data?.items ?? [];
  const total = items.length;
  const visibleIds = items.map((dish) => dish.id);
  const userId = session.status === "signed-in" ? session.user.id : null;
  const favoriteStatus = useFavoriteStatus(visibleIds, userId);

  // Explicit refresh: a new rotation seed renders another set from the same
  // scope. keepPreviousData keeps the current cards visible while the new
  // set loads, so there is no empty-state flash mid-refresh.
  const showAnotherSet = (): void => {
    setRotation((value) => value + 1);
  };

  // Scope line follows the scope actually served, not the scope asked for:
  // a precise request that fell back to country dishes is labeled regional,
  // a city request served from its own subtree is labeled with the city
  // named, a city that fell back to the ancestor country is labeled
  // regional with that country, and worldwide fallback is labeled worldwide
  // — never local. A sparse nearby pool topped up with country dishes
  // (supplemented) is regional with the country named. While a scope change
  // is still loading, the heading already names the requested scope so the
  // skeleton below it is never mislabeled.
  const servedScopeName = carouselQuery.data?.scope ?? null;

  const servedScope = discoveryServedScopeFor({
    preciseActive: served?.precise ?? false,
    servedScope: servedScopeName,
    supplemented: served?.supplemented ?? false,
  });

  const servedCity = served?.city ?? null;

  // City cards name the city; every other served lane names the served
  // country (a city fallback resolves through the city's own country hint).
  // An unresolved city with no usable label never fabricates a location:
  // it falls back to the country/worldwide lines below.
  let servedRegionName = countryNameFor(
    countriesQuery.data,
    served?.country ?? servedCity?.country ?? null,
  );

  if (servedScope === "city" && servedCity !== null) {
    servedRegionName = discoveryCityLabelFor(servedCity) ?? servedRegionName;
  }

  let requestedRegionName = countryNameFor(countriesQuery.data, effectiveCountry);

  if (city !== null) {
    requestedRegionName =
      discoveryCityLabelFor(city) ??
      countryNameFor(countriesQuery.data, city.country ?? effectiveCountry);
  }

  // A scope change (new country, precise fix, worldwide toggle) invalidates
  // the served cards: the section shows the skeleton with the newly
  // requested scope instead of stale cards under a stale label.
  const scopeChanged = served !== null && served.scopeKey !== scopeKey;

  // The subtitle always matches the heading's scope: country results get
  // the country line, worldwide fallback owns the catalog-gap explanation.
  // Heading + subtitle can never contradict ("around the world" above
  // "local favorites" is the exact mismatch this prevents).
  let heading = copy.discoverLocalTitle;
  let subtitle = copy.discoveryWorldwideNote;

  if (scopeChanged || servedScope === null) {
    if (effectiveCountry !== null || worldwide || city !== null) {
      let requestedScope: DiscoveryServedScope = "regional";

      if (worldwide) {
        requestedScope = "worldwide";
      } else if (preciseFix !== null) {
        requestedScope = "nearby";
      } else if (city !== null) {
        requestedScope = "city";
      }

      heading = discoveryHeadingFor({
        lang,
        regionName: requestedRegionName,
        scope: requestedScope,
      });
      subtitle = discoverySubtitleFor({
        lang,
        regionName: requestedRegionName,
        scope: requestedScope,
        supplemented: false,
      });
    }
  } else {
    heading = discoveryHeadingFor({ lang, regionName: servedRegionName, scope: servedScope });
    subtitle = discoverySubtitleFor({
      lang,
      regionName: servedRegionName,
      scope: servedScope,
      supplemented: served?.supplemented ?? false,
    });
  }

  // A scope change (new country, precise fix, worldwide toggle) invalidates
  // the served cards: show the skeleton with the newly requested scope
  // instead of stale cards under a stale label. Plain refetches (rotation,
  // "show another set") keep the cards with a small updating note.
  const loading = scopeKey !== null && (carouselQuery.isPending || scopeChanged);
  const failed = carouselQuery.isError || quizRegionQuery.isError;
  const refetching = !carouselQuery.isPending && carouselQuery.isFetching && total > 0;

  const preciseDenied =
    precise.status === "denied" || precise.status === "timeout" || precise.status === "unavailable";

  const preciseDisabled = precise.status === "unsupported" || precise.status === "insecure";

  const servedCountryCode = served?.country ?? null;

  // Pending selector state mirrors the pending request: an explicit city
  // choice reads as the city lane immediately, like worldwide does.
  let pendingSelection: "regional" | "worldwide" | "city" = "regional";

  if (worldwide) {
    pendingSelection = "worldwide";
  } else if (city !== null) {
    pendingSelection = "city";
  }

  const selection = servedScope ?? pendingSelection;

  const cityActive = city !== null || servedCity !== null;

  const showBackToRegion =
    (served?.precise === true || worldwide || city !== null) && effectiveCountry !== null;

  const countryRadio = cityActive ? null : (servedCountryCode ?? effectiveCountry);

  const fallbackState = resolveDiscoveryFallbackState({
    failed,
    geoSettled,
    isAutoWorldwide,
    loading,
    located: scopeKey !== null,
    total,
    worldwide: scopeKey === "world" || servedScopeName === "worldwide",
  });

  return (
    <section
      id="discover"
      aria-labelledby="discover-heading"
      className="scroll-mt-18 bg-cream px-5 py-16 sm:px-8"
    >
      <div className="mx-auto max-w-6xl">
        <h2
          id="discover-heading"
          className="font-display mb-3 text-[clamp(2.25rem,6vw,3.5rem)] leading-[1.05] tracking-[0.015em] text-balance"
        >
          {heading}
        </h2>

        <p className="mb-8 max-w-[60ch] text-lg text-muted">{subtitle}</p>

        <div className="mb-8">
          <DiscoveryLocation
            countries={(countriesQuery.data ?? []).flatMap((entry) =>
              entry.iso3166 === null
                ? []
                : [{ code: entry.iso3166, label: entry.displayName ?? entry.iso3166 }],
            )}
            countriesLoading={countriesQuery.isPending}
            currentLabel={servedRegionName ?? requestedRegionName ?? copy.discoverAroundWorld}
            disabled={false}
            lang={lang}
            locating={precise.status === "locating"}
            preciseDenied={preciseDenied}
            preciseDisabled={preciseDisabled}
            selectedCountry={countryRadio}
            selection={selection}
            selectedCity={servedCity ?? city}
            showBackToRegion={showBackToRegion}
            onBackToRegion={() => {
              precise.reset();
              setCity(null);
              setWorldwide(false);
            }}
            onChooseCountry={(code) => {
              precise.reset();
              setCity(null);
              setDestination(code);
              setWorldwide(false);
            }}
            onChooseCity={(option) => {
              precise.reset();
              setDestination(null);
              setCity(option);
              setWorldwide(false);
            }}
            onExploreWorldwide={() => {
              setCity(null);
              setWorldwide(true);
            }}
            onUsePrecise={() => {
              setCity(null);
              precise.request();
            }}
          />
        </div>

        {fallbackState === "loading" ? <DiscoveryLoadingState copy={copy} /> : null}

        {fallbackState === "ready" ? (
          <div>
            {refetching ? (
              <output className="mb-2 block text-sm font-semibold text-muted">
                {copy.discoverLocalLoading}
              </output>
            ) : null}
            <DishCarousel
              autoplay
              copy={copy}
              favoriteStatus={favoriteStatus}
              items={items}
              label={heading}
              lang={lang}
              resetKey={`${scopeKey ?? "pending"}:${rotation.toString()}`}
              session={session}
            />
            <div className="mt-4">
              <button
                type="button"
                onClick={showAnotherSet}
                aria-label={lang === "vi" ? "Xem loạt món khác" : "Show another set"}
                className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border-2 border-border-soft bg-white px-5 text-sm font-bold text-ink transition hover:border-ink"
              >
                <RefreshCwIcon aria-hidden="true" className="size-4 flex-none" />
                {lang === "vi" ? "Xem loạt món khác" : "Show another set"}
              </button>
            </div>
          </div>
        ) : null}

        <DiscoveryFallback
          copy={copy}
          emptyTagline={copy.discoveryCatalogTagline}
          state={fallbackState}
          onExploreWorldwide={() => {
            setCity(null);
            setWorldwide(true);
          }}
          onRetry={() => {
            void carouselQuery.refetch();
          }}
        />
      </div>
    </section>
  );
}
