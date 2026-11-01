import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { z } from "zod";

import type { Locale } from "@/shared/i18n";

/**
 * Shared Feast Lab page header: one breadcrumb trail plus one heading block.
 * Detail pages (dish, import job, new import) render this; top-level admin
 * pages (Dashboard/Dishes/Imports/Reviews/Members/Roles) keep plain headings
 * with no mechanical breadcrumbs.
 */

export const dishReturnStatusSchema = z.enum(["draft", "review", "published", "archived"]);

export type DishReturnStatus = z.infer<typeof dishReturnStatusSchema>;

/**
 * Optional return destination carried on dish-detail search. The dishes list
 * passes its active filter + cursor so the breadcrumb back-link restores the
 * caller's context; deep links omit them and fall back to the canonical
 * parent. Static `to` targets only — never a free-form URL, so there is no
 * open-redirect surface.
 */
export const dishDetailReturnSchema = z.object({
  fromStatus: dishReturnStatusSchema.optional(),
  // Coerced: TanStack parses `?fromCursor=42` as number 42, same as the
  // dishes list cursor the caller echoes back.
  fromCursor: z.coerce.string().max(500).optional(),
});

export type DishDetailReturn = z.infer<typeof dishDetailReturnSchema>;

const CANONICAL_DISHES_STATUS: DishReturnStatus = "review";
const CANONICAL_DISHES_CURSOR = "0";

/** Validated back-link target for the dishes breadcrumb ancestor. */
export interface DishesBackSearch {
  readonly cursor: string;
  readonly lang: Locale;
  readonly status: DishReturnStatus;
}

export function resolveDishesBackSearch(input: {
  readonly lang: Locale;
  readonly fromStatus?: DishReturnStatus;
  readonly fromCursor?: string;
}): DishesBackSearch {
  const status = input.fromStatus ?? CANONICAL_DISHES_STATUS;

  const cursor =
    input.fromCursor === undefined || input.fromCursor === ""
      ? CANONICAL_DISHES_CURSOR
      : input.fromCursor;

  return { lang: input.lang, status, cursor };
}

export type AdminBreadcrumbItem =
  | {
      readonly label: string;
      readonly to: "/admin/dishes";
      readonly search: {
        readonly lang: Locale;
        readonly status: DishReturnStatus;
        readonly cursor: string;
      };
    }
  | {
      readonly label: string;
      readonly to: "/admin" | "/admin/imports" | "/admin/imports/new" | "/admin/places";
      readonly search: { readonly lang: Locale };
    }
  | { readonly label: string; readonly to?: undefined };

export function AdminBreadcrumbs({
  items,
  lang,
}: {
  readonly items: ReadonlyArray<AdminBreadcrumbItem>;
  readonly lang: Locale;
}): ReactNode {
  return (
    <nav aria-label={lang === "vi" ? "Đường dẫn" : "Breadcrumb"} className="min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0 text-sm">
        {items.map((item, index) => {
          const last = index === items.length - 1;

          // The current page is always plain text with aria-current, even if
          // a caller passed a `to` — the trail never links to itself.
          if (item.to === undefined || last) {
            return (
              <li
                key={item.label}
                aria-current={last ? "page" : undefined}
                title={item.label}
                className="min-w-0 max-w-full truncate px-1 py-1 font-semibold"
              >
                {item.label}
              </li>
            );
          }

          // The dishes ancestor carries a validated return destination
          // (status filter + cursor + lang); its search shape differs from
          // the lang-only ancestors, so it renders on a narrowed branch and
          // every Link below stays strictly typed with no casts.
          if (item.to === "/admin/dishes") {
            return (
              <li key={item.label} className="flex min-w-0 items-center gap-1">
                <Link
                  to="/admin/dishes"
                  search={item.search}
                  className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-1 py-1 font-semibold text-brand-blue underline"
                >
                  {item.label}
                </Link>
                <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted" />
              </li>
            );
          }

          return (
            <li key={item.label} className="flex min-w-0 items-center gap-1">
              <Link
                to={item.to}
                search={item.search}
                className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-1 py-1 font-semibold text-brand-blue underline"
              >
                {item.label}
              </Link>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted" />
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function AdminPageHeader({
  action,
  badge,
  breadcrumbs,
  description,
  lang,
  title,
}: {
  readonly action?: ReactNode;
  readonly badge?: ReactNode;
  readonly breadcrumbs?: ReadonlyArray<AdminBreadcrumbItem>;
  readonly description?: string;
  readonly lang: Locale;
  readonly title: string;
}): ReactNode {
  return (
    <div className="min-w-0">
      {breadcrumbs === undefined ? null : <AdminBreadcrumbs items={breadcrumbs} lang={lang} />}
      <div
        className={
          breadcrumbs === undefined
            ? "flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"
            : "mt-2 flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"
        }
      >
        <div className="min-w-0 flex-1">
          <h1 className="font-display min-w-0 text-4xl tracking-wide break-words">{title}</h1>
          {description === undefined ? null : (
            <p className="mt-2 max-w-[70ch] text-sm text-muted break-words">{description}</p>
          )}
        </div>
        {badge === undefined && action === undefined ? null : (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {badge}
            {action}
          </div>
        )}
      </div>
    </div>
  );
}
