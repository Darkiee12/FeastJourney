import type { ReactNode } from "react";

import { CollapsiblePanel } from "@/components/admin/dish/CollapsiblePanel";
import { associationLabel, roleLabel } from "@/components/admin/dish/presentation";
import type { DishProfile } from "@/modules/food-discovery/server/domain/dish";
import type { Locale, Messages } from "@/shared/i18n";

const pick = (lang: Locale, en: string, vi: string): string => (lang === "vi" ? vi : en);

export function DishIngredients({
  action,
  dish,
  lang,
  copy,
}: {
  readonly action?: ReactNode;
  readonly dish: DishProfile;
  readonly lang: Locale;
  readonly copy: Messages;
}): ReactNode {
  return (
    <CollapsiblePanel
      title={copy.adminIngredients}
      defaultOpen
      action={action}
      badge={
        <span className="rounded-full bg-cream px-2 py-0.5 text-xs font-bold text-food-orange-dark">
          {dish.ingredients.length}
        </span>
      }
    >
      {dish.ingredients.length === 0 ? (
        <p className="text-sm text-muted">
          {pick(lang, "No ingredients recorded.", "Chưa ghi nhận nguyên liệu.")}
        </p>
      ) : (
        <ul className="flex min-w-0 flex-wrap gap-2">
          {dish.ingredients.map((entry) => (
            <li
              key={entry.id}
              className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border-soft bg-cream px-3 py-1 text-sm"
            >
              <span className="min-w-0 truncate font-semibold">{entry.name ?? entry.id}</span>
              <span className="shrink-0 text-xs text-muted">{roleLabel(entry.role, lang)}</span>
            </li>
          ))}
        </ul>
      )}
    </CollapsiblePanel>
  );
}

export function DishPlaces({
  action,
  dish,
  lang,
  copy,
}: {
  readonly action?: ReactNode;
  readonly dish: DishProfile;
  readonly lang: Locale;
  readonly copy: Messages;
}): ReactNode {
  return (
    <CollapsiblePanel
      title={copy.adminPlaces}
      defaultOpen
      action={action}
      badge={
        <span className="rounded-full bg-cream px-2 py-0.5 text-xs font-bold text-food-orange-dark">
          {dish.places.length}
        </span>
      }
    >
      {dish.places.length === 0 ? (
        <p className="text-sm text-muted">
          {pick(lang, "No places recorded.", "Chưa ghi nhận địa điểm.")}
        </p>
      ) : (
        <ul className="flex min-w-0 flex-wrap gap-2">
          {dish.places.map((entry) => (
            <li
              key={entry.id}
              className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border-soft bg-cream px-3 py-1 text-sm"
            >
              <span className="min-w-0 truncate font-semibold">{entry.name ?? entry.id}</span>
              <span className="shrink-0 text-xs text-muted">
                {associationLabel(entry.association, lang)}
              </span>
              {entry.isDisputed ? (
                <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">
                  {pick(lang, "Origin disputed", "Tranh chấp xuất xứ")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </CollapsiblePanel>
  );
}

export function DishTaxonomy({
  action,
  dish,
  lang,
  copy,
}: {
  readonly action?: ReactNode;
  readonly dish: DishProfile;
  readonly lang: Locale;
  readonly copy: Messages;
}): ReactNode {
  const total = dish.cuisines.length + dish.categories.length;

  return (
    <CollapsiblePanel
      title={`${copy.adminCuisines} · ${copy.adminCategories}`}
      defaultOpen
      action={action}
      badge={
        <span className="rounded-full bg-cream px-2 py-0.5 text-xs font-bold text-food-orange-dark">
          {total}
        </span>
      }
    >
      {total === 0 ? (
        <p className="text-sm text-muted">
          {pick(
            lang,
            "No cuisine or category links recorded.",
            "Chưa ghi nhận liên kết ẩm thực hay danh mục.",
          )}
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-2 text-sm">
          {dish.cuisines.length > 0 ? (
            <ul className="flex min-w-0 flex-wrap gap-2">
              {dish.cuisines.map((entry) => (
                <li
                  key={entry.id}
                  className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border-soft bg-cream px-3 py-1"
                >
                  <span className="shrink-0 text-xs text-muted">{copy.adminCuisines}</span>
                  <span className="min-w-0 truncate font-semibold">{entry.name ?? entry.slug}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {dish.categories.length > 0 ? (
            <ul className="flex min-w-0 flex-wrap gap-2">
              {dish.categories.map((entry) => (
                <li
                  key={entry.id}
                  className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border-soft bg-cream px-3 py-1"
                >
                  <span className="shrink-0 text-xs text-muted">{copy.adminCategories}</span>
                  <span className="min-w-0 truncate font-semibold">{entry.name ?? entry.slug}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </CollapsiblePanel>
  );
}
