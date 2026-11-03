import {
  createFileRoute,
  getRouteApi,
  notFound,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";

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
      className="mx-auto w-full max-w-2xl px-5 pt-10"
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

  return (
    <DishShell>
      <BackLink />
      <h1 className="font-display text-[clamp(2.25rem,7vw,3.5rem)] leading-none tracking-wide text-balance">
        {title}
      </h1>
      {showEnglish ? (
        <p className="mt-2 text-lg font-semibold text-food-orange-strong">{dish.englishName}</p>
      ) : null}
      {nativeNames.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2" lang="mul">
          {nativeNames.map((entry) => (
            <li
              key={`${entry.languageTag}:${entry.name}`}
              lang={entry.languageTag}
              className="rounded-full border border-border-soft bg-cream px-3 py-1 text-xs font-bold text-muted"
            >
              {entry.name}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-3 text-xs font-semibold text-muted">
        {copy.dishUpdated}:{" "}
        <time dateTime={new Date(dish.lastUpdate * 1000).toISOString()}>{updatedLabel}</time>
      </p>

      <DishPriceActions
        dishId={dish.id}
        dishSlug={dish.slug}
        lang={lang}
        restaurantsLabel={lang === "vi" ? "Nhà hàng" : "Restaurants"}
        compareLabel={lang === "vi" ? "So sánh giá" : "Compare prices"}
      />
      <div className="mt-5">
        <SaveDishButton
          dishId={dish.id}
          lang={lang}
          returnTo={`/dishes/${dish.slug}`}
          session={session}
          status={statusForDish(detailFavorites, dish.id)}
        />
      </div>

      {dish.description !== null ? (
        <section aria-labelledby="dish-about" className="mt-6">
          <h2 id="dish-about" className="font-display text-2xl tracking-wide">
            {copy.dishAbout}
          </h2>
          <p
            lang={dish.descriptionLanguage ?? undefined}
            className="mt-2 max-w-[60ch] text-base leading-relaxed text-ink"
          >
            {dish.description}
          </p>
        </section>
      ) : null}

      <section aria-labelledby="dish-ingredients" className="mt-6">
        <h2 id="dish-ingredients" className="font-display text-2xl tracking-wide">
          {copy.dishIngredients}
        </h2>
        {dish.ingredients.length === 0 ? (
          <p className="mt-2 max-w-[60ch] text-base text-muted">
            No ingredient information is available for this dish yet — always confirm with the
            people making your food.
          </p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {dish.ingredients.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center gap-2 rounded-2xl border border-border-soft bg-white px-4 py-2 text-sm"
              >
                <span className="font-bold text-ink">{entry.name ?? "Unnamed ingredient"}</span>
                <span className="rounded-full border border-border-soft bg-cream px-3 py-1 text-xs font-bold text-muted">
                  {entry.role}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dish.cuisines.length > 0 || dish.categories.length > 0 ? (
        <section aria-labelledby="dish-taxonomy" className="mt-6">
          <h2 id="dish-taxonomy" className="sr-only">
            {copy.dishCuisines} · {copy.dishCategories}
          </h2>
          {dish.cuisines.length > 0 ? (
            <div className="mt-2">
              <h3 className="text-sm font-bold text-ink">{copy.dishCuisines}</h3>
              <ul className="mt-2 flex flex-wrap gap-2">
                {dish.cuisines.map((entry) => (
                  <li
                    key={entry.id}
                    className="rounded-full border border-border-soft bg-cream px-3 py-1 text-xs font-bold text-muted"
                  >
                    {entry.name ?? entry.slug}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {dish.categories.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-sm font-bold text-ink">{copy.dishCategories}</h3>
              <ul className="mt-2 flex flex-wrap gap-2">
                {dish.categories.map((entry) => (
                  <li
                    key={entry.id}
                    className="rounded-full border border-border-soft bg-cream px-3 py-1 text-xs font-bold text-muted"
                  >
                    {entry.name ?? entry.slug}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {dish.places.length > 0 ? (
        <section aria-labelledby="dish-places" className="mt-6">
          <h2 id="dish-places" className="font-display text-2xl tracking-wide">
            {copy.dishPlaces}
          </h2>
          <ul className="mt-3 grid gap-3">
            {dish.places.map((entry) => (
              <li
                key={entry.id}
                className="rounded-2xl border border-border-soft bg-white px-4 py-3 text-sm"
              >
                <p className="font-bold text-ink">{entry.name ?? entry.iso3166 ?? entry.id}</p>
                {entry.iso3166 !== null && entry.name !== undefined ? (
                  <p className="mt-1 text-muted">{entry.iso3166}</p>
                ) : null}
                <p className="mt-1 text-xs font-semibold text-muted">
                  {entry.association}
                  {entry.kind.length > 0 ? ` · ${entry.kind}` : null}
                  {entry.isDisputed ? " · disputed" : null}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="dish-sources" className="mt-6">
        <h2 id="dish-sources" className="font-display text-2xl tracking-wide">
          {copy.dishSources}
        </h2>
        {dish.sources.length === 0 ? (
          <p className="mt-2 max-w-[60ch] text-base text-muted">
            No sources are listed for this dish yet.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3">
            {dish.sources.map((entry) => (
              <li
                key={entry.recordId}
                className="rounded-2xl border border-border-soft bg-white px-4 py-3 text-sm"
              >
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
      </section>
    </DishShell>
  );
}
