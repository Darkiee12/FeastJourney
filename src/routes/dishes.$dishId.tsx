import {
  createFileRoute,
  getRouteApi,
  notFound,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";

import { toCarouselPublishedImage } from "@/components/dish/dish-carousel";
import { DishMedia } from "@/components/dish/dish-media";
import { getDishFn } from "@/modules/food-discovery/food.functions";
import type { DishProfile } from "@/modules/food-discovery/server/domain/dish";
import { DishPriceActions } from "@/modules/restaurant-discovery/components/dish-price-actions";
import {
  SaveDishButton,
  statusForDish,
  useFavoriteStatus,
} from "@/modules/user/components/save-dish-button";
import { localeSearchSchema, messagesFor } from "@/shared/i18n";

const rootRoute = getRouteApi("__root__");

const dishIdParamsSchema = z.object({
  dishId: z.string().min(1).max(120),
});

/** Server DishNotFound failures serialize without an Error message; match the tag. */
const dishNotFoundSchema = z.object({ _tag: z.literal("DishNotFound") });

export const Route = createFileRoute("/dishes/$dishId")({
  validateSearch: localeSearchSchema,
  loaderDeps: ({ search }) => ({ locale: search.lang }),
  loader: async ({ params, deps }): Promise<DishProfile> => {
    const parsed = dishIdParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw notFound();
    }

    try {
      return await getDishFn({ data: { id: parsed.data.dishId, locale: deps.locale } });
    } catch (error) {
      if (dishNotFoundSchema.safeParse(error).success) {
        throw notFound();
      }

      throw error;
    }
  },
  pendingComponent: DishPending,
  errorComponent: DishError,
  notFoundComponent: DishMissing,
  component: DishDetail,
});

function DishShell({ children }: { readonly children: React.ReactNode }) {
  return (
    <div
      className="dish-page mx-auto w-full max-w-5xl px-5 pt-8"
      style={{ paddingBottom: "max(4rem, env(safe-area-inset-bottom))" }}
    >
      {children}
    </div>
  );
}

/** Back prefers router history (dish cards, recommendations, saved rows all
 *  land here); only a direct load falls back to the homepage quiz section. */
function BackLink() {
  const { lang } = rootRoute.useSearch();
  const copy = messagesFor(lang);
  const router = useRouter();
  const navigate = useNavigate();

  const goBack = (): void => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.history.back();

      return;
    }

    void navigate({ to: "/", search: { lang }, hash: "recommend" });
  };

  return (
    <p className="mb-4 text-sm font-semibold">
      <button
        type="button"
        onClick={goBack}
        className="inline-flex min-h-11 cursor-pointer items-center text-brand-blue-hover underline underline-offset-4"
      >
        ← {copy.recBack}
      </button>
    </p>
  );
}

function DishPending() {
  const { lang } = rootRoute.useSearch();
  const copy = messagesFor(lang);

  return (
    <DishShell>
      <BackLink />
      <output className="block font-display text-3xl tracking-wide">{copy.dishLoading}</output>
      <div
        aria-hidden="true"
        className="mt-4 h-28 animate-pulse rounded-2xl border border-border-soft bg-white motion-reduce:animate-none"
      />
    </DishShell>
  );
}

function DishError({ reset }: { readonly reset: () => void }) {
  const { lang } = rootRoute.useSearch();
  const copy = messagesFor(lang);
  const router = useRouter();

  const retry = (): void => {
    reset();
    void router.invalidate();
  };

  return (
    <DishShell>
      <BackLink />
      <p
        role="alert"
        className="rounded-xl border-2 border-danger bg-white px-4 py-3 text-sm font-bold text-danger"
      >
        {copy.dishError}
      </p>
      <button
        type="button"
        onClick={retry}
        className="mt-4 inline-flex min-h-11 cursor-pointer items-center rounded-full bg-ink px-6 text-sm font-bold text-white transition hover:opacity-90"
      >
        {copy.recRetry}
      </button>
    </DishShell>
  );
}

function DishMissing() {
  const { lang } = rootRoute.useSearch();
  const copy = messagesFor(lang);

  return (
    <DishShell>
      <BackLink />
      <output className="block rounded-xl border-2 border-border-soft bg-white px-4 py-3 text-sm font-bold text-ink">
        {copy.dishNotFound}
      </output>
    </DishShell>
  );
}

function DishDetail() {
  const { lang } = rootRoute.useSearch();
  const { session } = rootRoute.useRouteContext();
  const copy = messagesFor(lang);
  const dish = Route.useLoaderData();

  const title = dish.name ?? dish.englishName ?? dish.slug;

  const showEnglish =
    dish.name !== undefined && dish.englishName !== undefined && dish.name !== dish.englishName;

  const nativeNames = dish.nativeNames.filter((entry) => entry.name !== title);

  const updatedLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(
        new Date(dish.lastUpdate * 1000),
      ),
    [lang, dish.lastUpdate],
  );

  const detailUserId = session.status === "signed-in" ? session.user.id : null;

  const detailFavorites = useFavoriteStatus([dish.id], detailUserId);

  const originPlace = dish.places.find((entry) => entry.kind === "country") ?? dish.places[0];
  const region = originPlace?.name ?? originPlace?.iso3166 ?? null;
  const photo = toCarouselPublishedImage(dish.image, dish.id);

  return (
    <DishShell>
      <BackLink />
      <article className="dish-passport">
        <div className="dish-passport-photo">
          {photo === null ? (
            <span aria-hidden="true" className="dish-passport-initial">
              {Array.from(title)[0] ?? ""}
            </span>
          ) : (
            <DishMedia
              image={photo}
              eager
              sizes="(max-width: 768px) 100vw, 45vw"
              unavailableLabel={copy.carouselPhotoSoon}
              loadingLabel={copy.discoverLocalLoading}
              className="absolute inset-0 h-full w-full"
            />
          )}
          {region !== null ? <p className="dish-stamp">{region}</p> : null}
        </div>
        <div className="dish-passport-body">
          <h1 className="dish-passport-title font-display">{title}</h1>
          {showEnglish ? <p className="dish-passport-english">{dish.englishName}</p> : null}
          {nativeNames.length > 0 ? (
            <ul className="dish-passport-native" lang="mul">
              {nativeNames.map((entry) => (
                <li key={`${entry.languageTag}:${entry.name}`} lang={entry.languageTag}>
                  {entry.name}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="dish-passport-actions">
            <DishPriceActions
              dishId={dish.id}
              dishSlug={dish.slug}
              lang={lang}
              restaurantsLabel={lang === "vi" ? "Nhà hàng" : "Restaurants"}
              compareLabel={lang === "vi" ? "So sánh giá" : "Compare prices"}
            />
            <SaveDishButton
              dishId={dish.id}
              lang={lang}
              returnTo={`/dishes/${dish.slug}`}
              session={session}
              status={statusForDish(detailFavorites, dish.id)}
            />
          </div>
          <p className="dish-passport-updated">
            {copy.dishUpdated}:{" "}
            <time dateTime={new Date(dish.lastUpdate * 1000).toISOString()}>{updatedLabel}</time>
          </p>
        </div>
      </article>

      <div className="dish-sheet">
        <div className="dish-sheet-main">
          {dish.description !== null ? (
            <section aria-labelledby="dish-about" className="dish-panel">
              <h2 id="dish-about" className="dish-panel-title font-display">
                {copy.dishAbout}
              </h2>
              <p lang={dish.descriptionLanguage ?? undefined} className="dish-about-text">
                {dish.description}
              </p>
            </section>
          ) : null}

          <section aria-labelledby="dish-ingredients" className="dish-panel">
            <h2 id="dish-ingredients" className="dish-panel-title font-display">
              {copy.dishIngredients}
            </h2>
            {dish.ingredients.length === 0 ? (
              <p className="dish-panel-empty">
                No ingredient information is available for this dish yet — always confirm with the
                people making your food.
              </p>
            ) : (
              <ul className="dish-ingredients">
                {dish.ingredients.map((entry) => (
                  <li key={entry.id} data-role={entry.role}>
                    {entry.name ?? "Unnamed ingredient"}
                    <span>{entry.role}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="dish-sheet-side">
          {dish.places.length > 0 ? (
            <section aria-labelledby="dish-places" className="dish-panel">
              <h2 id="dish-places" className="dish-panel-title font-display">
                {copy.dishPlaces}
              </h2>
              <ul className="dish-place-stamps">
                {dish.places.map((entry) => (
                  <li key={entry.id}>
                    <span className="dish-place-name">
                      {entry.name ?? entry.iso3166 ?? entry.id}
                    </span>
                    <span className="dish-place-meta">
                      {entry.association}
                      {entry.isDisputed ? " · disputed" : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {dish.cuisines.length > 0 || dish.categories.length > 0 ? (
            <section aria-labelledby="dish-taxonomy" className="dish-panel">
              <h2 id="dish-taxonomy" className="sr-only">
                {copy.dishCuisines} · {copy.dishCategories}
              </h2>
              {dish.cuisines.length > 0 ? (
                <>
                  <h3 className="dish-panel-label">{copy.dishCuisines}</h3>
                  <ul className="dish-chips">
                    {dish.cuisines.map((entry) => (
                      <li key={entry.id}>{entry.name ?? entry.slug}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              {dish.categories.length > 0 ? (
                <>
                  <h3 className="dish-panel-label">{copy.dishCategories}</h3>
                  <ul className="dish-chips">
                    {dish.categories.map((entry) => (
                      <li key={entry.id}>{entry.name ?? entry.slug}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          ) : null}

          <details className="dish-panel dish-sources">
            <summary id="dish-sources">{copy.dishSources}</summary>
            {dish.sources.length === 0 ? (
              <p className="dish-panel-empty">No sources are listed for this dish yet.</p>
            ) : (
              <ul>
                {dish.sources.map((entry) => (
                  <li key={entry.recordId}>
                    <p className="font-bold text-ink">
                      {entry.provider}
                      {entry.externalId.length > 0 ? ` · ${entry.externalId}` : null}
                    </p>
                    {entry.attribution !== null ? (
                      <p className="mt-1 text-muted">{entry.attribution}</p>
                    ) : null}
                    {entry.license !== null ? (
                      <p className="mt-1 text-xs font-bold text-muted">License: {entry.license}</p>
                    ) : null}
                    {entry.canonicalUrl !== null ? (
                      <p className="mt-1">
                        <a
                          href={entry.canonicalUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-bold text-brand-blue-hover underline underline-offset-4"
                        >
                          Source link
                        </a>
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </aside>
      </div>
    </DishShell>
  );
}
