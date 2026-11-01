import { Link, createFileRoute, getRouteApi, redirect, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { z } from "zod";

import { PLACE_KINDS, type PlaceListItem } from "@/components/admin/places/place-contracts";
import { normalizeParentId } from "@/components/admin/places/place-grammar";
import { PlaceSelector } from "@/components/admin/places/PlaceSelector";
import { PlaceTable } from "@/components/admin/places/PlaceTable";
import { AdminSelectField } from "@/components/admin/select";
import {
  AdminEmptyState,
  AdminGhostButton,
  AdminPageHeading,
  AdminRouteError,
} from "@/components/admin/ui";
import { adminPlacesListFn } from "@/modules/food-discovery/place.functions";
import { placeKindSchema, type AdminPlacesList } from "@/modules/food-discovery/place.schema";
import { authorizeFn } from "@/modules/user/admin.functions";
import { getSessionFn } from "@/modules/user/session.functions";
import { localeSearchSchema, messagesFor, type Locale, type Messages } from "@/shared/i18n";

const rootRoute = getRouteApi("__root__");

const placesSearch = localeSearchSchema.extend({
  query: z.string().default(""),
  kind: z.string().default(""),
  parentId: z.string().default(""),
  page: z.coerce.number().int().min(1).default(1),
});

export const Route = createFileRoute("/admin/places")({
  validateSearch: placesSearch,
  loaderDeps: ({ search }) => ({
    query: search.query,
    kind: search.kind,
    parentId: search.parentId,
    page: search.page,
  }),
  beforeLoad: async ({ search }) => {
    const session = await getSessionFn();

    if (session.user === null) {
      throw redirect({ to: "/sign-in", search: { returnTo: "/admin/places", lang: search.lang } });
    }

    const { allowed } = await authorizeFn({
      data: { checks: [{ resource: "food", actions: ["read"] }] },
    });

    if (!allowed) {
      throw redirect({ to: "/", search: { lang: search.lang } });
    }

    return {};
  },
  loader: async ({ deps }): Promise<PlacesLoaderData> => {
    const kind = PLACE_KINDS.find((entry) => entry === deps.kind);
    const parentId = normalizeParentId(deps.parentId);
    const input: AdminPlacesList = { query: deps.query, page: deps.page - 1 };

    if (kind !== undefined) {
      input.kind = kind;
    }

    if (parentId !== null) {
      input.parentId = parentId;
    }

    const page = placeListPageSchema.parse(await adminPlacesListFn({ data: input }));

    return {
      items: page.items,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
  },
  component: AdminPlaces,
  errorComponent: AdminRouteError,
});

const placeListItemSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  kind: placeKindSchema,
  iso3166: z.string().nullable(),
  displayLatitude: z.number().nullable(),
  displayLongitude: z.number().nullable(),
  displayNote: z.string().nullable(),
});

const placeListPageSchema = z.object({
  items: z.array(placeListItemSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export interface PlacesLoaderData {
  readonly items: ReadonlyArray<PlaceListItem>;
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * Toolbar form with local drafts. Keyed by the applied URL filters so
 * back/forward navigation remounts with fresh drafts — no sync effect, no
 * stale values, and typing never remounts mid-keystroke.
 */
function PlacesFilterForm({
  copy,
  initialKind,
  initialParentId,
  initialQuery,
  lang,
  onApply,
}: {
  readonly copy: Messages;
  readonly initialKind: string;
  readonly initialParentId: string;
  readonly initialQuery: string;
  readonly lang: Locale;
  readonly onApply: (filters: { kind: string; parentId: string; query: string }) => void;
}): ReactNode {
  const [draftQuery, setDraftQuery] = useState(initialQuery);
  const [draftKind, setDraftKind] = useState(initialKind);
  const [draftParentId, setDraftParentId] = useState(initialParentId);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    // Single submit per Enter keypress or Search click: inputs carry no
    // key handlers of their own, so filtering can never double-fire.
    event.preventDefault();
    onApply({ kind: draftKind, parentId: draftParentId, query: draftQuery });
  };

  const handleClear = (): void => {
    setDraftQuery("");
    setDraftKind("");
    setDraftParentId("");
    onApply({ kind: "", parentId: "", query: "" });
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-[minmax(0,1fr)_12rem_minmax(0,17rem)_auto] md:items-end">
        <div className="min-w-0 sm:col-span-2 md:col-span-1">
          <label htmlFor="places-query" className="sr-only">
            {copy.adminSearchPlaces}
          </label>
          <input
            id="places-query"
            type="search"
            value={draftQuery}
            placeholder={copy.adminSearchPlacesPlaceholder}
            onChange={(event) => {
              setDraftQuery(event.target.value);
            }}
            className="min-h-11 w-full min-w-0 rounded-lg border border-border-soft bg-white px-3 py-2 text-sm text-ink outline-none focus-visible:border-brand-blue focus-visible:ring-2 focus-visible:ring-brand-blue/40"
          />
        </div>
        <div className="min-w-0">
          <AdminSelectField
            id="places-kind"
            label={copy.adminKind}
            value={draftKind}
            onValueChange={setDraftKind}
            triggerClassName="w-full"
            options={[
              { label: copy.adminAllKinds, value: "" },
              ...PLACE_KINDS.map((entry) => ({ label: entry, value: entry })),
            ]}
          />
        </div>
        <div className="min-w-0">
          <PlaceSelector
            id="places-parent"
            label={copy.adminParentFilter}
            copy={copy}
            lang={lang}
            variant="parentFilter"
            placeholder={copy.adminSearchPlacesPlaceholder}
            value={draftParentId}
            onChange={setDraftParentId}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2 md:col-span-1">
          <AdminGhostButton type="submit">{copy.adminSearchPlaces}</AdminGhostButton>
          <AdminGhostButton type="button" onClick={handleClear}>
            {copy.adminImportsClearFilters}
          </AdminGhostButton>
        </div>
      </div>
    </form>
  );
}

function AdminPlaces() {
  const { lang } = rootRoute.useSearch();
  const search = Route.useSearch();
  const copy = messagesFor(lang);
  const data = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });

  const applyFilters = (filters: { kind: string; parentId: string; query: string }): void => {
    void navigate({
      search: (previous) => ({
        ...previous,
        query: filters.query,
        kind: filters.kind,
        parentId: filters.parentId,
        page: 1,
      }),
    });
  };

  const hasMore = (data.page + 1) * data.pageSize < data.total;

  return (
    <div className="flex flex-col gap-4">
      <AdminPageHeading
        title={copy.adminPlaces}
        description={copy.adminPlacesDescription}
        action={
          <Link
            to="/admin/places/$placeId"
            params={{ placeId: "new" }}
            search={{
              lang,
              fromQuery: search.query,
              fromKind: search.kind,
              fromParent: search.parentId,
              fromPage: search.page,
            }}
            className="inline-flex min-h-11 items-center rounded-lg bg-food-orange-dark px-4 py-2 text-sm font-bold text-white hover:bg-food-orange-strong"
          >
            {copy.adminNewPlace}
          </Link>
        }
      />

      <fieldset className="rounded-2xl border border-border-soft bg-white p-4">
        <legend className="px-1 text-sm font-bold">{copy.adminSearchPlaces}</legend>
        <PlacesFilterForm
          key={`${search.query}
${search.kind}
${search.parentId}`}
          copy={copy}
          lang={lang}
          initialQuery={search.query}
          initialKind={search.kind}
          initialParentId={search.parentId}
          onApply={applyFilters}
        />
      </fieldset>

      {data.items.length === 0 ? (
        <AdminEmptyState message={copy.adminNoResults} />
      ) : (
        <PlaceTable
          baseSearch={{
            kind: search.kind,
            lang,
            page: search.page,
            parentId: search.parentId,
            query: search.query,
          }}
          copy={copy}
          lang={lang}
          places={data.items}
        />
      )}
      <PlacePager hasMore={hasMore} lang={lang} page={search.page} />
    </div>
  );
}

function PlacePager({
  hasMore,
  lang,
  page,
}: {
  readonly hasMore: boolean;
  readonly lang: Locale;
  readonly page: number;
}): ReactNode {
  const copy = messagesFor(lang);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {page > 1 ? (
        <Link
          from={Route.fullPath}
          search={(previous) => ({ ...previous, page: page - 1 })}
          className="inline-flex min-h-11 items-center rounded-lg border border-border-soft bg-white px-4 py-2 text-sm font-semibold hover:bg-cream"
        >
          {copy.adminImportPrevious}
        </Link>
      ) : null}
      {hasMore ? (
        <Link
          from={Route.fullPath}
          search={(previous) => ({ ...previous, page: page + 1 })}
          className="inline-flex min-h-11 items-center rounded-lg border border-border-soft bg-white px-4 py-2 text-sm font-semibold hover:bg-cream"
        >
          {copy.adminImportNext}
        </Link>
      ) : null}
    </div>
  );
}
