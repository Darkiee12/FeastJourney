import { useMutation } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createFileRoute,
  getRouteApi,
  redirect,
  useChildMatches,
} from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import {
  AdminEmptyState,
  AdminErrorState,
  AdminGhostButton,
  AdminPageHeading,
  AdminRouteError,
  AdminTable,
  AdminToolbar,
} from "@/components/admin/ui";
import { adminDishesListFn } from "@/modules/food-discovery/admin.functions";
import { authorizeFn } from "@/modules/user/admin.functions";
import { getSessionFn } from "@/modules/user/session.functions";
import { formatAdminDate } from "@/shared/format";
import { localeSearchSchema, messagesFor, type Locale, type Messages } from "@/shared/i18n";

const rootRoute = getRouteApi("__root__");

const dishesSearch = localeSearchSchema.extend({
  status: z.enum(["draft", "review", "published", "archived"]).default("review"),
  cursor: z.string().default("0"),
});

export const Route = createFileRoute("/admin/dishes")({
  validateSearch: dishesSearch,
  loaderDeps: ({ search }) => ({ status: search.status, cursor: search.cursor }),
  beforeLoad: async ({ search }) => {
    const session = await getSessionFn();

    if (session.user === null) {
      throw redirect({ to: "/sign-in", search: { returnTo: "/admin/dishes", lang: search.lang } });
    }

    const { allowed } = await authorizeFn({
      data: { checks: [{ resource: "food", actions: ["read"] }] },
    });

    if (!allowed) {
      throw redirect({ to: "/", search: { lang: search.lang } });
    }

    return {};
  },
  loader: async ({ deps }) =>
    dishListSchema.parse(
      await adminDishesListFn({ data: { status: deps.status, limit: 20, cursor: deps.cursor } }),
    ),
  component: AdminDishes,
  errorComponent: AdminRouteError,
});

const dishListItemSchema = z.object({
  display_name: z.string().nullable(),
  id: z.string(),
  slug: z.string(),
  status: z.string(),
  created_at: z.union([z.string(), z.date()]),
  updated_at: z.union([z.string(), z.date()]),
});

const dishListSchema = z.array(dishListItemSchema);

type DishListItem = z.infer<typeof dishListItemSchema>;

const statusLabel = (status: string, copy: Messages): string => {
  if (status === "published") {
    return copy.adminPublished;
  }

  if (status === "review") {
    return copy.adminInReview;
  }

  if (status === "draft") {
    return copy.adminDraft;
  }

  if (status === "archived") {
    return copy.adminArchived;
  }

  return status;
};

type DisplayTimestamp = Date | string;

const formatDate = (value: DisplayTimestamp, lang: Locale): string => formatAdminDate(value, lang);

const STATUSES = ["draft", "review", "published", "archived"] as const;

function AdminDishes() {
  const { lang } = rootRoute.useSearch();
  const { status } = Route.useSearch();
  const childMatches = useChildMatches();
  const copy = messagesFor(lang);
  const initial = Route.useLoaderData();

  if (childMatches.length > 0) {
    return <Outlet />;
  }

  return (
    <div className="flex flex-col gap-4">
      <AdminPageHeading
        title={copy.adminDishesHeading}
        action={
          <Link
            to="/admin/places"
            search={{ lang, query: "", kind: "", parentId: "", page: 1 }}
            className="inline-flex min-h-11 items-center rounded-lg border border-border-soft bg-white px-4 py-2 text-sm font-semibold text-brand-blue underline hover:bg-cream"
          >
            {copy.adminPlaces}
          </Link>
        }
      />

      <fieldset className="rounded-2xl border border-border-soft bg-white p-4">
        <legend className="px-1 text-sm font-bold">{copy.adminFilterByStatus}</legend>
        <AdminToolbar>
          <ul className="flex flex-row flex-wrap gap-2">
            {STATUSES.map((entry) => (
              <li key={entry}>
                <Link
                  to="/admin/dishes"
                  search={{ lang, status: entry, cursor: "0" }}
                  aria-current={entry === status ? "true" : undefined}
                  className="inline-flex min-h-11 items-center rounded-full border border-border-soft px-4 py-2 text-sm font-semibold aria-current:border-food-orange aria-current:bg-cream aria-current:font-bold aria-current:text-food-orange-dark"
                >
                  {statusLabel(entry, copy)}
                </Link>
              </li>
            ))}
          </ul>
        </AdminToolbar>
      </fieldset>

      <DishRows key={`${lang}:${status}`} initial={initial} />
    </div>
  );
}

function DishRows({ initial }: { readonly initial: ReadonlyArray<DishListItem> }) {
  const { lang } = rootRoute.useSearch();
  const { status, cursor } = Route.useSearch();
  const copy = messagesFor(lang);
  const [extra, setExtra] = useState<ReadonlyArray<DishListItem>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const rows = [...initial, ...extra];
  const lastId = rows.length > 0 ? (rows[rows.length - 1]?.id ?? "0") : "0";

  const loadMore = useMutation({
    mutationFn: async () =>
      dishListSchema.parse(
        await adminDishesListFn({ data: { status, limit: 20, cursor: lastId } }),
      ),
    onSuccess: (page) => {
      setExtra((previous) => [...previous, ...page]);
      setLoadError(null);
    },
    onError: () => {
      setLoadError(copy.adminLoadFailed);
    },
  });

  const handleRetry = (): void => {
    loadMore.mutate();
  };

  return (
    <>
      <div aria-live="polite" className="flex flex-col gap-3">
        {loadError !== null ? (
          <AdminErrorState
            message={loadError}
            retryLabel={copy.commonRetry}
            onRetry={handleRetry}
            pending={loadMore.isPending}
          />
        ) : null}
        {rows.length === 0 ? (
          <AdminEmptyState message={copy.adminNoResults} />
        ) : (
          <AdminTable minWidthClass="min-w-[30rem]">
            <thead>
              <tr className="border-b border-border-soft bg-cream">
                <th scope="col" className="px-3 py-2 font-semibold">
                  {copy.adminDishName}
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  {copy.adminStatus}
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  {copy.adminUpdated}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((dish) => (
                <tr key={dish.id} className="border-b border-border-soft last:border-0">
                  <td className="px-3 py-2">
                    <Link
                      to="/admin/dishes/$dishId"
                      params={{ dishId: dish.id }}
                      search={{ lang, fromStatus: status, fromCursor: cursor }}
                      className="inline-flex min-h-11 items-center font-medium text-brand-blue underline"
                    >
                      {dish.display_name ?? dish.slug}
                    </Link>
                    {dish.display_name !== null ? (
                      <span className="block text-xs text-muted">{dish.slug}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{statusLabel(dish.status, copy)}</td>
                  <td className="px-3 py-2">{formatDate(dish.updated_at, lang)}</td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        )}
      </div>

      {rows.length > 0 ? (
        <div>
          <AdminGhostButton
            type="button"
            disabled={loadMore.isPending}
            aria-busy={loadMore.isPending}
            onClick={handleRetry}
          >
            {copy.adminNextPage}
          </AdminGhostButton>
        </div>
      ) : null}
    </>
  );
}
