import { createFileRoute, getRouteApi, redirect } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";

import { DishDescriptionsEditor } from "@/components/admin/dish/dish-descriptions-editor";
import { DishIdentityEditor } from "@/components/admin/dish/dish-identity-editor";
import { DishIngredientsEditor } from "@/components/admin/dish/dish-ingredients-editor";
import { DishNamesEditor } from "@/components/admin/dish/dish-names-editor";
import { DishPlacesEditor } from "@/components/admin/dish/dish-places-editor";
import { DishTaxonomyEditor } from "@/components/admin/dish/dish-taxonomy-editor";
import { DishIngredients, DishPlaces, DishTaxonomy } from "@/components/admin/dish/DishDetailsGrid";
import { DishHeader } from "@/components/admin/dish/DishHeader";
import { DishDescriptions, DishIdentity, DishNames } from "@/components/admin/dish/DishIdentity";
import { DishNotes, type DishNoteItem } from "@/components/admin/dish/DishNotes";
import { DishProvenance } from "@/components/admin/dish/DishProvenance";
import { DishStatusEditor } from "@/components/admin/dish/DishStatusEditor";
import { DishPhotosPanel } from "@/components/admin/dish/photo-panel";
import {
  RevisionTimeline,
  type RevisionTimelineItem,
  type RevisionTimelinePage,
} from "@/components/admin/dish/RevisionTimeline";
import { dishDetailReturnSchema, resolveDishesBackSearch } from "@/components/admin/page-header";
import { AdminRouteError } from "@/components/admin/ui";
import {
  adminDishDetailFn,
  adminDishRevisionHistoryFn,
  adminPublicationCheckFn,
  adminUpdateDishStatusFn,
} from "@/modules/food-discovery/admin.functions";
import type { DishPlace, DishProfile } from "@/modules/food-discovery/server/domain/dish";
import { authorizeFn } from "@/modules/user/admin.functions";
import { getSessionFn } from "@/modules/user/session.functions";
import { formatAdminDate } from "@/shared/format";
import { localeSearchSchema, messagesFor, type Locale, type Messages } from "@/shared/i18n";

const rootRoute = getRouteApi("__root__");

export const Route = createFileRoute("/admin/dishes/$dishId")({
  // Optional return destination for the breadcrumb back-link: the dishes
  // list passes its active filter + cursor so back-navigation restores the
  // caller's context. Deep links omit them and fall back to the canonical
  // parent (review/0).
  validateSearch: localeSearchSchema.extend(dishDetailReturnSchema.shape),
  loaderDeps: ({ search }) => ({ locale: search.lang }),
  beforeLoad: async ({ search }) => {
    const session = await getSessionFn();

    if (session.user === null) {
      throw redirect({
        to: "/sign-in",
        search: { returnTo: "/admin/dishes", lang: search.lang },
      });
    }

    const { allowed } = await authorizeFn({
      data: { checks: [{ resource: "food", actions: ["read"] }] },
    });

    if (!allowed) {
      throw redirect({ to: "/", search: { lang: search.lang } });
    }

    return {};
  },
  loader: async ({ params, deps }): Promise<DishDetailData> =>
    adminDishDetailLoader({ dishId: params.dishId, locale: deps.locale }),
  component: AdminDishDetail,
  errorComponent: AdminRouteError,
});

const dishNoteSchema = z.object({
  id: z.string(),
  author: z.string(),
  authorDisplayName: z.string().nullable(),
  importJobId: z.string().nullable(),
  appliedByDisplayName: z.string().nullable(),
  noteKind: z.string(),
  note: z.string(),
  createdAt: z.union([z.string(), z.date()]),
});

const dishNameSchema = z.object({
  languageTag: z.string(),
  name: z.string(),
});

const dishIngredientSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  role: z.string(),
});

const dishPlaceSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  association: z.string(),
  isDisputed: z.boolean(),
  // Link note from the detail projection; missing reads as empty and the
  // editor treats it accordingly.
  note: z.string().nullable().optional(),
});

const dishTaxonomySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string().nullable().optional(),
});

const dishCategorySchema = z.object({
  id: z.string(),
  kind: z.string(),
  slug: z.string(),
  name: z.string().nullable().optional(),
});

const dishSourceSchema = z.object({
  recordId: z.string(),
  provider: z.string(),
  externalId: z.string(),
  canonicalUrl: z.string().nullable(),
  license: z.string().nullable(),
  attribution: z.string().nullable(),
});

const dishProfileSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string().nullable().optional(),
  englishName: z.string().nullable().optional(),
  status: z.string(),
  description: z.string().nullable(),
  descriptionLanguage: z.string().nullable(),
  nativeNames: z.array(dishNameSchema),
  ingredients: z.array(dishIngredientSchema),
  places: z.array(dishPlaceSchema),
  cuisines: z.array(dishTaxonomySchema),
  categories: z.array(dishCategorySchema),
  sources: z.array(dishSourceSchema),
  lastUpdate: z.number(),
  parent: z.object({ id: z.string(), slug: z.string() }).nullable(),
});

const dishDetailSchema = z.object({
  dish: dishProfileSchema,
  notes: z.array(dishNoteSchema),
});

interface DishDetailData {
  readonly dish: Omit<DishProfile, "places"> & {
    readonly places: ReadonlyArray<DishPlaceWithNote>;
  };
  readonly notes: ReadonlyArray<DishNoteItem>;
}

/** Dish-place link with the editor-visible link note from the detail projection. */
export interface DishPlaceWithNote extends DishPlace {
  readonly note: string | null;
}

const adminDishDetailLoader = async (input: {
  readonly dishId: string;
  readonly locale: Locale;
}): Promise<DishDetailData> => {
  const parsed = dishDetailSchema.parse(
    await adminDishDetailFn({ data: { dishId: input.dishId, locale: input.locale } }),
  );

  const dish: DishDetailData["dish"] = {
    id: parsed.dish.id,
    slug: parsed.dish.slug,
    name: parsed.dish.name ?? undefined,
    englishName: parsed.dish.englishName ?? undefined,
    nativeNames: parsed.dish.nativeNames,
    description: parsed.dish.description,
    descriptionLanguage: parsed.dish.descriptionLanguage,
    status: parsed.dish.status,
    parent: parsed.dish.parent,
    ingredients: parsed.dish.ingredients.map((entry) => ({
      id: entry.id,
      name: entry.name ?? undefined,
      role: entry.role,
    })),
    places: parsed.dish.places.map((entry) => ({
      id: entry.id,
      name: entry.name ?? undefined,
      association: entry.association,
      isDisputed: entry.isDisputed,
      note: entry.note ?? null,
      kind: "",
      iso3166: null,
      displayLatitude: null,
      displayLongitude: null,
    })),
    cuisines: parsed.dish.cuisines.map((entry) => ({
      id: entry.id,
      slug: entry.slug,
      name: entry.name ?? undefined,
    })),
    categories: parsed.dish.categories.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      slug: entry.slug,
      name: entry.name ?? undefined,
    })),
    sources: parsed.dish.sources,
    lastUpdate: parsed.dish.lastUpdate,
  };

  return { dish, notes: parsed.notes };
};

const revisionItemSchema = z.object({
  id: z.string(),
  actor: z.string(),
  actorDisplayName: z.string().nullable(),
  importJobId: z.string().nullable(),
  appliedByDisplayName: z.string().nullable(),
  operation: z.string(),
  summary: z.string(),
  createdAt: z.union([z.string(), z.date()]),
});

const revisionPageSchema = z.object({
  revisions: z.array(revisionItemSchema),
  nextCursor: z.string().nullable(),
});

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

const dishSummary = (dish: DishProfile, lang: Locale): string => {
  // Status lives in the header badge and the status editor — the summary
  // carries only the one-line counts so the three never repeat each other.
  const parts = [
    lang === "vi"
      ? `${dish.ingredients.length} nguyên liệu`
      : `${dish.ingredients.length} ingredients`,
    lang === "vi" ? `${dish.places.length} địa điểm` : `${dish.places.length} places`,
  ];

  return parts.join(" · ");
};

function AdminDishDetail() {
  const { lang } = rootRoute.useSearch();
  const { fromCursor, fromStatus } = Route.useSearch();
  const copy = messagesFor(lang);
  const detail = Route.useLoaderData();
  const { dish, notes } = detail;
  const title = dish.englishName ?? dish.name ?? dish.slug;
  const backSearch = resolveDishesBackSearch({ lang, fromStatus, fromCursor });

  const fetchPage = useCallback(
    async (input: {
      readonly dishId: string;
      readonly limit: number;
      readonly cursor: string | null;
    }): Promise<RevisionTimelinePage> => {
      const page = revisionPageSchema.parse(
        await adminDishRevisionHistoryFn({
          data: { dishId: input.dishId, limit: input.limit, cursor: input.cursor },
        }),
      );

      const revisions: ReadonlyArray<RevisionTimelineItem> = page.revisions.map((entry) => ({
        id: entry.id,
        actor: entry.actor,
        actorDisplayName: entry.actorDisplayName,
        importJobId: entry.importJobId,
        appliedByDisplayName: entry.appliedByDisplayName,
        operation: entry.operation,
        summary: entry.summary,
        createdAt: entry.createdAt,
      }));

      return { revisions, nextCursor: page.nextCursor };
    },
    [],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-3">
      <DishHeader
        lang={lang}
        labLabel={copy.adminWorkspace}
        dishesLabel={copy.adminDishesHeading}
        backSearch={backSearch}
        title={title}
        summary={dishSummary(dish, lang)}
        statusBadge={
          <p className="rounded-full bg-cream px-3 py-1 text-sm font-bold text-food-orange-dark">
            {copy.adminStatus}: {statusLabel(dish.status, copy)}
          </p>
        }
      />

      <DishStatusEditor
        key={dish.id}
        dishId={dish.id}
        initialStatus={dish.status}
        lang={lang}
        copy={copy}
        publicationCheck={(id) => adminPublicationCheckFn({ data: { dishId: id } })}
        saveStatus={(id, status) => adminUpdateDishStatusFn({ data: { dishId: id, status } })}
      />

      <DishPhotosPanel dishId={dish.id} lang={lang} />

      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <DishIdentity
          dish={dish}
          lang={lang}
          copy={copy}
          action={
            <DishIdentityEditor
              copy={copy}
              dishId={dish.id}
              lang={lang}
              parentSlug={dish.parent?.slug ?? null}
              slug={dish.slug}
            />
          }
        />
        <DishIngredients
          dish={dish}
          lang={lang}
          copy={copy}
          action={
            <DishIngredientsEditor
              copy={copy}
              dishId={dish.id}
              ingredients={dish.ingredients}
              lang={lang}
            />
          }
        />
      </div>

      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <DishNames
          dish={dish}
          lang={lang}
          copy={copy}
          action={
            <DishNamesEditor copy={copy} dishId={dish.id} lang={lang} names={dish.nativeNames} />
          }
        />
        <DishDescriptions
          dish={dish}
          lang={lang}
          copy={copy}
          action={
            <DishDescriptionsEditor
              copy={copy}
              description={dish.description}
              descriptionLanguage={dish.descriptionLanguage}
              dishId={dish.id}
              lang={lang}
            />
          }
        />
      </div>

      <div className="grid min-w-0 gap-3 md:grid-cols-2 lg:grid-cols-3">
        <DishPlaces
          dish={dish}
          lang={lang}
          copy={copy}
          action={
            <DishPlacesEditor copy={copy} dishId={dish.id} lang={lang} places={dish.places} />
          }
        />
        <DishTaxonomy
          dish={dish}
          lang={lang}
          copy={copy}
          action={
            <DishTaxonomyEditor
              categories={dish.categories}
              copy={copy}
              cuisines={dish.cuisines}
              dishId={dish.id}
              lang={lang}
            />
          }
        />
        <DishProvenance dish={dish} lang={lang} copy={copy} />
      </div>

      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <DishNotes notes={notes} lang={lang} copy={copy} />
        <RevisionTimeline dishId={dish.id} lang={lang} copy={copy} fetchPage={fetchPage} />
      </div>

      <p className="text-xs text-muted">
        {lang === "vi" ? "Cập nhật" : "Updated"}{" "}
        <time dateTime={new Date(dish.lastUpdate * 1000).toISOString()}>
          {formatAdminDate(new Date(dish.lastUpdate * 1000), lang)}
        </time>
      </p>
    </div>
  );
}
