import {
  Link,
  createFileRoute,
  getRouteApi,
  redirect,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { z } from "zod";

import { AdminPageHeader } from "@/components/admin/page-header";
import {
  parseCreatedPlaceId,
  PLACE_KINDS,
  readMutationFailure,
  placeFnAvailable,
  type PlaceDetail,
} from "@/components/admin/places/place-contracts";
import {
  PlaceMetadataEditor,
  PlaceNamesEditor,
  PlaceParentEditor,
} from "@/components/admin/places/PlaceEditor";
import { PlaceSelector } from "@/components/admin/places/PlaceSelector";
import { AdminSelectField } from "@/components/admin/select";
import { AdminCard, AdminField, AdminRouteError, AdminSection } from "@/components/admin/ui";
import { adminCreatePlaceFn, adminPlaceDetailFn } from "@/modules/food-discovery/place.functions";
import { placeKindSchema, type PlaceKind } from "@/modules/food-discovery/place.schema";
import { authorizeFn } from "@/modules/user/admin.functions";
import { getSessionFn } from "@/modules/user/session.functions";
import { localeSearchSchema, messagesFor, type Locale, type Messages } from "@/shared/i18n";

const rootRoute = getRouteApi("__root__");

const placeDetailSearch = localeSearchSchema.extend({
  fromQuery: z.string().default(""),
  fromKind: z.string().default(""),
  fromParent: z.string().default(""),
  fromPage: z.coerce.number().int().min(1).default(1),
});

export const Route = createFileRoute("/admin/places/$placeId")({
  validateSearch: placeDetailSearch,
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
  loader: async ({ params }): Promise<PlaceLoaderData> => {
    if (params.placeId === "new") {
      return { mode: "create" };
    }

    const detail = placeDetailSchema.parse(
      await adminPlaceDetailFn({ data: { placeId: params.placeId } }),
    );

    const preferred =
      detail.names.find((entry) => entry.isPreferred)?.name ?? detail.names[0]?.name ?? null;

    const place: PlaceDetail = {
      id: detail.place.id,
      displayName: preferred,
      kind: detail.place.kind,
      iso3166: detail.place.iso3166,
      displayLatitude: detail.place.displayLatitude,
      displayLongitude: detail.place.displayLongitude,
      displayNote: detail.place.displayNote,
      names: detail.names,
      parents: detail.parents,
      ancestors: detail.ancestors,
      children: detail.children,
      dishCounts: detail.dishCounts,
    };

    return { mode: "view", place };
  },
  component: AdminPlaceDetail,
  errorComponent: AdminRouteError,
});

const placeViewSchema = z.object({
  id: z.string(),
  kind: placeKindSchema,
  iso3166: z.string().nullable(),
  displayLatitude: z.number().nullable(),
  displayLongitude: z.number().nullable(),
  displayNote: z.string().nullable(),
});

const placeNameSchema = z.object({
  id: z.string(),
  languageTag: z.string(),
  name: z.string(),
  isPreferred: z.boolean(),
});

const placeHierarchySchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  kind: z.string(),
  iso3166: z.string().nullable(),
});

const placeDetailSchema = z.object({
  place: placeViewSchema,
  names: z.array(placeNameSchema),
  parents: z.array(placeHierarchySchema),
  ancestors: z.array(placeHierarchySchema),
  children: z.array(placeHierarchySchema),
  dishCounts: z.object({
    origin: z.number(),
    associated: z.number(),
    popular: z.number(),
    total: z.number(),
  }),
});

type PlaceLoaderData =
  | { readonly mode: "create" }
  | { readonly mode: "view"; readonly place: PlaceDetail };

function AdminPlaceDetail() {
  const { lang } = rootRoute.useSearch();
  const search = Route.useSearch();
  const copy = messagesFor(lang);
  const data = Route.useLoaderData();
  const router = useRouter();

  const backSearch = {
    lang,
    query: search.fromQuery,
    kind: search.fromKind,
    parentId: search.fromParent,
    page: search.fromPage,
  };

  const refresh = (): void => {
    void router.invalidate();
  };

  if (data.mode === "create") {
    return (
      <div className="flex flex-col gap-4">
        <PlaceBreadcrumbs
          copy={copy}
          lang={lang}
          backSearch={backSearch}
          current={copy.adminNewPlace}
        />
        <PlaceCreateForm copy={copy} lang={lang} />
      </div>
    );
  }

  const place = data.place;

  const title =
    place.displayName ?? (lang === "vi" ? `Địa điểm #${place.id}` : `Place #${place.id}`);

  return (
    <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-4">
      <PlaceBreadcrumbs copy={copy} lang={lang} backSearch={backSearch} current={title} />
      <AdminPageHeader
        lang={lang}
        title={title}
        description={`place:${place.id} · ${place.kind}`}
      />

      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <AdminSection
          title={copy.adminNames}
          action={<PlaceNamesEditor copy={copy} lang={lang} onSaved={refresh} place={place} />}
        >
          <PlaceNamesRead copy={copy} place={place} />
        </AdminSection>
        <AdminSection
          title={copy.adminKind}
          action={<PlaceMetadataEditor copy={copy} onSaved={refresh} place={place} />}
        >
          <dl className="flex min-w-0 flex-col gap-2 text-sm">
            <div className="min-w-0">
              <dt className="font-semibold">{copy.adminKind}</dt>
              <dd className="min-w-0 break-words">{place.kind}</dd>
            </div>
            <div className="min-w-0">
              <dt className="font-semibold">{copy.adminIso}</dt>
              <dd>{place.iso3166 ?? "—"}</dd>
            </div>
            <div className="min-w-0">
              <dt className="font-semibold">{copy.adminLatitude}</dt>
              <dd>{place.displayLatitude === null ? "—" : place.displayLatitude}</dd>
            </div>
            <div className="min-w-0">
              <dt className="font-semibold">{copy.adminLongitude}</dt>
              <dd>{place.displayLongitude === null ? "—" : place.displayLongitude}</dd>
            </div>
            <div className="min-w-0">
              <dt className="font-semibold">{copy.adminDisplayNote}</dt>
              <dd className="min-w-0 break-words">{place.displayNote ?? "—"}</dd>
            </div>
          </dl>
        </AdminSection>
      </div>

      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <AdminSection
          title={copy.adminHierarchy}
          action={<PlaceParentEditor copy={copy} lang={lang} onSaved={refresh} place={place} />}
        >
          <PlaceHierarchyRead copy={copy} lang={lang} place={place} />
        </AdminSection>
        <AdminSection title={copy.adminLinkedDishes}>
          <p className="text-sm">
            {copy.adminAssocOrigin}: {place.dishCounts.origin} · {copy.adminAssocAssociated}:{" "}
            {place.dishCounts.associated} · {copy.adminAssocPopular}: {place.dishCounts.popular}
          </p>
          <p className="mt-1 text-sm text-muted">
            {copy.adminTotalDishes}: {place.dishCounts.total}
          </p>
        </AdminSection>
      </div>

      <AdminSection title={copy.adminChildren}>
        {place.children.length === 0 ? (
          <p className="text-sm text-muted">{copy.adminNoResults}</p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-1 text-sm">
            {place.children.map((entry) => (
              <li key={entry.id} className="min-w-0 break-words">
                <Link
                  to="/admin/places/$placeId"
                  params={{ placeId: entry.id }}
                  search={{ lang }}
                  className="inline-flex min-h-11 items-center font-medium text-brand-blue underline"
                >
                  {entry.displayName ?? entry.id}
                </Link>
                <span className="ml-2 text-xs text-muted">{entry.kind}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted">
          {lang === "vi" ? `Id hiện tại: place:${place.id}` : `Current id: place:${place.id}`}
        </p>
      </AdminSection>
    </div>
  );
}

function PlaceBreadcrumbs({
  backSearch,
  copy,
  current,
  lang,
}: {
  readonly backSearch: {
    readonly kind: string;
    readonly lang: Locale;
    readonly page: number;
    readonly parentId: string;
    readonly query: string;
  };
  readonly copy: { readonly adminPlaces: string; readonly adminWorkspace: string };
  readonly current: string;
  readonly lang: Locale;
}): ReactNode {
  // Local breadcrumb: `AdminBreadcrumbs` in page-header.tsx is a shared
  // file outside this workstream's ownership and its `to` union has no
  // `/admin/places` entry yet — the coordinator adds it there.
  return (
    <nav aria-label={lang === "vi" ? "Đường dẫn" : "Breadcrumb"} className="min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0 text-sm">
        <li className="flex min-w-0 items-center gap-1">
          <Link
            to="/admin"
            search={{ lang }}
            className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-1 py-1 font-semibold text-brand-blue underline"
          >
            {copy.adminWorkspace}
          </Link>
          <span aria-hidden="true" className="text-muted">
            ›
          </span>
        </li>
        <li className="flex min-w-0 items-center gap-1">
          <Link
            to="/admin/places"
            search={backSearch}
            className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-1 py-1 font-semibold text-brand-blue underline"
          >
            {copy.adminPlaces}
          </Link>
          <span aria-hidden="true" className="text-muted">
            ›
          </span>
        </li>
        <li
          aria-current="page"
          title={current}
          className="min-w-0 max-w-full truncate px-1 py-1 font-semibold"
        >
          {current}
        </li>
      </ol>
    </nav>
  );
}

function PlaceNamesRead({
  copy,
  place,
}: {
  readonly copy: { readonly adminPreferred: string };
  readonly place: PlaceDetail;
}): ReactNode {
  if (place.names.length === 0) {
    return <p className="text-sm text-muted">—</p>;
  }

  return (
    <ul className="flex min-w-0 flex-col gap-1 text-sm">
      {place.names.map((entry) => (
        <li key={entry.id} className="min-w-0 break-words">
          <span className="mr-2 inline-block rounded-full bg-cream px-2 py-0.5 text-xs font-bold text-food-orange-dark">
            {entry.languageTag}
          </span>
          {entry.name}
          {entry.isPreferred ? (
            <span className="ml-2 text-xs font-bold text-food-orange-dark">
              · {copy.adminPreferred}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function PlaceHierarchyRead({
  copy,
  lang,
  place,
}: {
  readonly copy: { readonly adminNoParent: string };
  readonly lang: Locale;
  readonly place: PlaceDetail;
}): ReactNode {
  // Ancestors arrive nearest-first (direct parent, grandparent, root);
  // the hierarchy reads root-first.
  const ordered = place.ancestors.toReversed();

  if (ordered.length === 0) {
    return <p className="text-sm text-muted">{copy.adminNoParent}</p>;
  }

  return (
    <ol className="flex min-w-0 flex-col gap-1 text-sm">
      {ordered.map((entry) => (
        <li key={entry.id} className="min-w-0 break-words">
          <Link
            to="/admin/places/$placeId"
            params={{ placeId: entry.id }}
            search={{ lang }}
            className="inline-flex min-h-11 items-center font-medium text-brand-blue underline"
          >
            {entry.displayName ?? entry.id}
          </Link>
          <span className="ml-2 text-xs text-muted">{entry.kind}</span>
        </li>
      ))}
    </ol>
  );
}

function PlaceCreateForm({
  copy,
  lang,
}: {
  readonly copy: Messages;
  readonly lang: Locale;
}): ReactNode {
  const navigate = useNavigate({ from: Route.fullPath });
  const createAvailable = placeFnAvailable("adminCreatePlaceFn");
  const [kind, setKind] = useState<PlaceKind>("locality");
  const [iso, setIso] = useState("");
  const [name, setName] = useState("");
  const [parentRef, setParentRef] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = name.trim() !== "" && name.length <= 300 && iso.trim().length <= 10;

  const handleCreate = (): void => {
    if (!valid || pending) {
      return;
    }

    const trimmedParent = parentRef.trim();

    const parentIds =
      trimmedParent === "" ? undefined : trimmedParent.replace(/^place:/, "").trim();

    if (parentIds !== undefined && !/^[0-9]+$/.test(parentIds)) {
      setError(copy.adminSaveFailed);

      return;
    }

    setPending(true);
    setError(null);

    const baseInput = {
      kind,
      iso3166: iso.trim() === "" ? null : iso.trim(),
      displayLatitude: null,
      displayLongitude: null,
      displayNote: note.trim() === "" ? null : note.trim(),
      names: [{ languageTag: lang, name: name.trim(), isPreferred: true }],
    };

    const input = parentIds === undefined ? baseInput : { ...baseInput, parentIds: [parentIds] };

    void adminCreatePlaceFn({ data: input }).then(
      (outcome) => {
        setPending(false);

        const failure = readMutationFailure(outcome, copy.adminSaveFailed);

        if (failure !== null) {
          setError(failure);

          return;
        }

        const createdId = parseCreatedPlaceId(outcome);

        if (createdId === null) {
          setError(copy.adminSaveFailed);

          return;
        }

        void navigate({
          to: "/admin/places/$placeId",
          params: { placeId: createdId },
          search: { lang },
        });
      },
      () => {
        setPending(false);
        setError(copy.adminSaveFailed);
      },
    );
  };

  if (!createAvailable) {
    return null;
  }

  return (
    <AdminCard>
      <h1 className="font-display text-2xl tracking-wide">{copy.adminNewPlace}</h1>
      <div className="mt-3 flex min-w-0 flex-col gap-3">
        {error !== null ? (
          <p role="alert" className="text-sm font-semibold text-red-800">
            {error}
          </p>
        ) : null}
        <AdminSelectField
          id="new-place-kind"
          label={copy.adminKind}
          value={kind}
          onValueChange={(value) => {
            const next = PLACE_KINDS.find((entry) => entry === value);

            if (next !== undefined) {
              setKind(next);
            }
          }}
          options={PLACE_KINDS.map((entry) => ({ label: entry, value: entry }))}
        />
        <AdminField
          id="new-place-iso"
          label={copy.adminIso}
          value={iso}
          onChange={(event) => {
            setIso(event.target.value);
          }}
          error={iso.trim().length > 10 ? copy.adminSaveFailed : null}
        />
        <AdminField
          id="new-place-name"
          label={copy.adminPlaces}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          error={name.trim() === "" ? copy.adminFieldRequired : null}
        />
        <PlaceSelector
          id="new-place-parent"
          label={copy.adminParentFilter}
          copy={copy}
          lang={lang}
          value={parentRef}
          onChange={setParentRef}
        />
        <AdminField
          id="new-place-note"
          label={copy.adminDisplayNote}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          error={note.length > 2000 ? copy.adminSaveFailed : null}
        />
        <div className="flex flex-wrap gap-2">
          <Link
            to="/admin/places"
            search={{ lang, query: "", kind: "", parentId: "", page: 1 }}
            className="inline-flex min-h-11 items-center rounded-lg border border-border-soft bg-white px-4 py-2 text-sm font-semibold hover:bg-cream"
          >
            {copy.commonCancel}
          </Link>
          <button
            type="button"
            disabled={pending || !valid}
            aria-busy={pending}
            onClick={handleCreate}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg bg-food-orange-dark px-4 py-2 text-sm font-bold text-white hover:bg-food-orange-strong disabled:opacity-50"
          >
            {pending ? copy.settingsSaving : copy.authSave}
          </button>
        </div>
      </div>
    </AdminCard>
  );
}
