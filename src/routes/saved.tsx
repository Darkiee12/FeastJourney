import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { PersonalNav } from "@/components/personal-nav";
import { getDishSummariesFn } from "@/modules/food-discovery/food.functions";
import { venueTint } from "@/modules/restaurant-discovery/components/restaurant-card";
import {
  favoriteIdsQueryKey,
  SaveDishButton,
  statusForDish,
  useFavoriteIds,
  type SaveButtonStatus,
} from "@/modules/user/components/save-dish-button";
import { listFavoritesFn } from "@/modules/user/profile.functions";
import type { SessionState } from "@/modules/user/session.functions";
import { localeSearchSchema, messagesFor } from "@/shared/i18n";
import type { Locale } from "@/shared/i18n";

const rootRoute = getRouteApi("__root__");

/**
 * Loader boundary for favorite rows: keep only the decimal dish id the UI
 * needs, validated here so row-shape drift fails fast instead of rendering
 * half-parsed favorites.
 */
const savedDishSchema = z.object({ dish_id: z.string().regex(/^[0-9]+$/) });

/** First-page size for saved enumeration; further pages load on demand. */
const SAVED_PAGE_SIZE = 100;

/** Batch card projection caps at 50 ids per call; larger lists fan out. */
const SUMMARY_CHUNK_SIZE = 50;

const chunkIds = (ids: ReadonlyArray<string>, size: number): Array<Array<string>> => {
  const chunks: Array<Array<string>> = [];

  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }

  return chunks;
};

export const Route = createFileRoute("/saved")({
  validateSearch: localeSearchSchema,
  beforeLoad: async ({ context, search }) => {
    if (context.session.status === "signed-out") {
      throw redirect({ to: "/sign-in", search: { returnTo: "/saved", lang: search.lang } });
    }

    if (context.session.status === "unavailable") {
      // SAFETY: literal unavailable marker for the component's discriminated
      // union branch; no untrusted input is asserted.
      return { user: null, unavailable: true } as const;
    }

    // SAFETY: literal loaded marker; identity comes from the verified root context.
    return { user: context.session.user, unavailable: false } as const;
  },
  loader: async ({ context }) => {
    if ("unavailable" in context && context.unavailable) {
      // SAFETY: literal unavailable marker with an empty dish list; the list
      // shape matches the loaded branch so the component narrows safely.
      return { dishIds: [], userId: null, unavailable: true } as const;
    }

    const favorites = await listFavoritesFn({ data: { limit: SAVED_PAGE_SIZE, offset: 0 } });

    // SAFETY: literal loaded marker; dish ids are validated by
    // savedDishSchema at the loader boundary.
    return {
      dishIds: favorites.map((entry) => savedDishSchema.parse(entry).dish_id),
      userId: context.user.id,
      unavailable: false,
    } as const;
  },
  pendingComponent: SavedPending,
  errorComponent: SavedError,
  notFoundComponent: SavedMissing,
  component: SavedDishes,
});

function SavedPending() {
  const { lang } = rootRoute.useSearch();
  const copy = messagesFor(lang);

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-10">
      <output className="block text-lg font-semibold text-muted">{copy.savedLoading}</output>
    </div>
  );
}

function SavedError({ reset }: { readonly reset: () => void }) {
  const { lang } = rootRoute.useSearch();
  const copy = messagesFor(lang);

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-10">
      <p
        role="alert"
        className="rounded-xl border-2 border-danger bg-white px-4 py-3 text-sm font-bold text-danger"
      >
        {copy.savedLoadError}
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 inline-flex min-h-11 cursor-pointer items-center rounded-full bg-ink px-6 text-sm font-bold text-white transition hover:opacity-90"
      >
        {copy.saveDishRetry}
      </button>
    </div>
  );
}

function SavedMissing() {
  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-10">
      <output className="block rounded-xl border-2 border-border-soft bg-white px-4 py-3 text-sm font-bold text-ink">
        This page is not available.
      </output>
    </div>
  );
}

function SavedDishes() {
  const { lang } = rootRoute.useSearch();
  const { session } = rootRoute.useRouteContext();
  const loaderData = Route.useLoaderData();
  const copy = messagesFor(lang);

  if ("unavailable" in loaderData && loaderData.unavailable) {
    return (
      <div
        className="mx-auto w-full max-w-2xl px-5 pt-10"
        style={{ paddingBottom: "max(4rem, env(safe-area-inset-bottom))" }}
      >
        <h1 className="font-display text-[clamp(2.25rem,7vw,3.5rem)] leading-none tracking-wide text-balance">
          {copy.savedTitle}
        </h1>
        <div className="mt-4">
          <PersonalNav />
        </div>
        <p role="note" className="mt-4 max-w-[60ch] text-base font-semibold text-ink">
          {copy.savedUnavailableNote}
        </p>
      </div>
    );
  }

  return (
    <SavedList
      initialIds={loaderData.dishIds}
      initialUserId={loaderData.userId}
      lang={lang}
      session={session}
    />
  );
}

function SavedList({
  initialIds,
  initialUserId,
  lang,
  session,
}: {
  readonly initialIds: ReadonlyArray<string>;
  readonly initialUserId: string | null;
  readonly lang: Locale;
  readonly session: SessionState;
}) {
  // Authoritative ids: the loader paints first, then these shared queries own
  // updates — removals invalidate the same key every SaveDishButton writes,
  // so the list, cards, and detail pages can never disagree. Scoped to the
  // verified account: the key remounts all paging state on identity change,
  // so one account never sees another's pages.
  const userId = session.status === "signed-in" ? session.user.id : null;

  return (
    <SavedPages
      key={userId ?? "signed-out"}
      userId={userId}
      initialIds={initialIds}
      initialUserId={initialUserId}
      lang={lang}
      session={session}
    />
  );
}

function SavedPages({
  userId,
  initialIds,
  initialUserId,
  lang,
  session,
}: {
  readonly userId: string | null;
  readonly initialIds: ReadonlyArray<string>;
  readonly initialUserId: string | null;
  readonly lang: Locale;
  readonly session: SessionState;
}) {
  const copy = messagesFor(lang);
  const [pageCount, setPageCount] = useState(1);

  const loaderIdsForUser = userId !== null && initialUserId === userId ? [...initialIds] : [];
  const firstPageInitialData = loaderIdsForUser.length > 0 ? loaderIdsForUser : undefined;
  const firstPage = useFavoriteIds(userId, SAVED_PAGE_SIZE, 0, firstPageInitialData);

  const extraPages = useQueries({
    queries: Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => {
      const offset = (index + 1) * SAVED_PAGE_SIZE;

      return {
        queryKey: [...favoriteIdsQueryKey(userId ?? "signed-out"), `offset:${offset}`],
        queryFn: async (): Promise<Array<string>> => {
          const rows = await listFavoritesFn({
            data: { limit: SAVED_PAGE_SIZE, offset },
          });

          return rows.map((entry) => savedDishSchema.parse(entry).dish_id);
        },
        enabled: userId !== null,
        staleTime: 60_000,
        retry: 1,
      };
    }),
  });

  const pagesData = [
    firstPage.data ?? loaderIdsForUser,
    ...extraPages.map((page) => page.data ?? []),
  ];

  const dishIds = pagesData.flat();

  const lastPageSize =
    extraPages.length > 0
      ? (extraPages[extraPages.length - 1]?.data?.length ?? SAVED_PAGE_SIZE)
      : (firstPage.data?.length ?? initialIds.length);

  const hasMore = lastPageSize >= SAVED_PAGE_SIZE && dishIds.length > 0;
  const pagesPending = firstPage.isPending || extraPages.some((page) => page.isPending);

  const pagesFailed =
    (firstPage.isError && firstPage.data === undefined) ||
    extraPages.some((page) => page.isError && page.data === undefined);

  const chunks = chunkIds(dishIds, SUMMARY_CHUNK_SIZE);

  const summaries = useQuery({
    queryKey: ["favorites", "summaries", lang, ...chunks.map((chunk) => chunk.join(","))],
    queryFn: async () => {
      const parts = await Promise.all(
        chunks.map((chunk) => getDishSummariesFn({ data: { ids: chunk, locale: lang } })),
      );

      return parts.flat();
    },
    enabled: dishIds.length > 0,
    staleTime: 60_000,
    retry: 1,
  });

  const byId = new Map((summaries.data ?? []).map((entry) => [entry.id, entry] as const));

  const combinedStatus = {
    data: dishIds,
    isPending: pagesPending && dishIds.length === 0,
    isError: pagesFailed,
    refetch: () => {
      void firstPage.refetch();

      for (const page of extraPages) {
        void page.refetch();
      }
    },
    dataUpdatedAt: firstPage.dataUpdatedAt,
  };

  return (
    <div
      className="mx-auto w-full max-w-2xl px-5 pt-10"
      style={{ paddingBottom: "max(4rem, env(safe-area-inset-bottom))" }}
    >
      <p className="mb-4 text-sm font-semibold">
        <Link
          to="/"
          search={{ lang }}
          className="text-brand-blue-hover underline underline-offset-4"
        >
          FeastJourney
        </Link>
      </p>

      <h1 className="font-display text-[clamp(2.25rem,7vw,3.5rem)] leading-none tracking-wide text-balance">
        {copy.savedTitle}
      </h1>
      <div className="mt-4">
        <PersonalNav />
      </div>

      {pagesPending && dishIds.length === 0 ? (
        <output className="mt-4 block text-base text-muted">{copy.savedLoading}</output>
      ) : null}

      {pagesFailed ? (
        <p
          role="alert"
          className="mt-4 rounded-xl border-2 border-danger bg-white px-4 py-3 text-sm font-bold text-danger"
        >
          {copy.savedLoadError}
          <button
            type="button"
            onClick={() => {
              combinedStatus.refetch();
            }}
            className="mt-2 inline-flex min-h-11 cursor-pointer items-center rounded-full bg-danger px-5 text-sm font-bold text-white transition hover:opacity-90"
          >
            {copy.saveDishRetry}
          </button>
        </p>
      ) : null}

      {dishIds.length === 0 && !pagesPending && !pagesFailed ? (
        <p className="mt-4 max-w-[60ch] text-base text-muted">{copy.savedEmpty}</p>
      ) : null}

      {summaries.isPending && dishIds.length > 0 ? (
        <output className="mt-6 block text-base text-muted">{copy.savedDetailsLoading}</output>
      ) : null}

      {summaries.isError ? (
        <p
          role="alert"
          className="mt-6 rounded-xl border-2 border-danger bg-white px-4 py-3 text-sm font-bold text-danger"
        >
          {copy.savedDetailsError}
        </p>
      ) : null}

      <ul className="saved-grid mt-6">
        {dishIds.map((dishId) => {
          const summary = byId.get(dishId);

          if (summary === undefined) {
            if (summaries.isPending || summaries.isError) {
              return null;
            }

            return (
              <UnavailableRow
                key={dishId}
                dishId={dishId}
                lang={lang}
                status={statusForDish(combinedStatus, dishId)}
              />
            );
          }

          return (
            <FavoriteRow
              key={dishId}
              dishId={dishId}
              slug={summary.slug}
              title={summary.name ?? summary.englishName ?? summary.slug}
              region={summary.regionNames[0] ?? null}
              lang={lang}
              session={session}
              status={statusForDish(combinedStatus, dishId)}
            />
          );
        })}
      </ul>

      {hasMore && !pagesFailed ? (
        <button
          type="button"
          onClick={() => {
            setPageCount(pageCount + 1);
          }}
          disabled={pagesPending}
          aria-busy={pagesPending}
          className="mt-6 inline-flex min-h-11 cursor-pointer items-center rounded-full border-2 border-ink bg-white px-6 text-sm font-bold text-ink transition hover:bg-ink hover:text-white disabled:cursor-wait disabled:opacity-70"
        >
          {pagesPending ? copy.saveDishLoading : copy.savedShowMore}
        </button>
      ) : null}
    </div>
  );
}

function UnavailableRow({
  dishId,
  lang,
  status,
}: {
  readonly dishId: string;
  readonly lang: Locale;
  readonly status: SaveButtonStatus;
}) {
  const { session } = rootRoute.useRouteContext();
  const copy = messagesFor(lang);

  return (
    <li className="saved-card">
      <h2 className="text-lg leading-tight font-extrabold">Dish {dishId}</h2>
      <p role="note" className="mt-2 text-sm text-muted">
        {copy.savedUnavailable}
      </p>
      <div className="mt-3">
        <SaveDishButton
          dishId={dishId}
          lang={lang}
          returnTo="/saved"
          session={session}
          status={status}
        />
      </div>
    </li>
  );
}

function FavoriteRow({
  dishId,
  slug,
  title,
  region,
  lang,
  session,
  status,
}: {
  readonly dishId: string;
  readonly slug: string;
  readonly title: string;
  readonly region: string | null;
  readonly lang: Locale;
  readonly session: SessionState;
  readonly status: SaveButtonStatus;
}) {
  return (
    <li className="saved-card" data-tint={venueTint(title)}>
      <div className="saved-card-top">
        <div className="min-w-0">
          {region === null ? null : <p className="saved-card-region">{region}</p>}
          <h2 className="saved-card-title">
            <Link to="/dishes/$dishId" params={{ dishId: slug }} search={{ lang }}>
              {title}
            </Link>
          </h2>
        </div>
        <span aria-hidden="true" className="res-stamp">
          <span className="res-stamp-initial">{Array.from(title)[0] ?? ""}</span>
        </span>
      </div>
      <SaveDishButton
        dishId={dishId}
        lang={lang}
        returnTo="/saved"
        session={session}
        status={status}
      />
    </li>
  );
}
