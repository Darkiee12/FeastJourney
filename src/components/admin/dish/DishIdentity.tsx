import type { ReactNode } from "react";

import { CollapsiblePanel } from "@/components/admin/dish/CollapsiblePanel";
import type { DishProfile } from "@/modules/food-discovery/server/domain/dish";
import type { Locale, Messages } from "@/shared/i18n";

const pick = (lang: Locale, en: string, vi: string): string => (lang === "vi" ? vi : en);

export interface DishNameRow {
  readonly id?: string;
  readonly languageTag: string;
  readonly name: string;
  readonly nameKind?: string;
  readonly isPreferred?: boolean;
}

export interface DishDescriptionRow {
  readonly id?: string;
  readonly languageTag: string;
  readonly description: string;
  readonly summary?: string | null;
}

export function DishIdentity({
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
    <CollapsiblePanel title={pick(lang, "Identity", "Định danh")} defaultOpen action={action}>
      <dl className="flex min-w-0 flex-col gap-1.5 text-sm">
        <div className="min-w-0">
          <dt className="font-semibold">{copy.adminSlug}</dt>
          <dd className="min-w-0 font-mono break-words">{dish.slug}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-semibold">{copy.adminParentDish}</dt>
          <dd className="min-w-0 break-words">
            {dish.parent === null ? (
              <span className="text-muted">{copy.adminNoParent}</span>
            ) : (
              <span className="font-mono">{dish.parent.slug}</span>
            )}
          </dd>
        </div>
      </dl>
    </CollapsiblePanel>
  );
}

export function DishNames({
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
  const englishName = dish.englishName ?? null;
  const canonicalName = dish.name ?? englishName ?? dish.slug;

  return (
    <CollapsiblePanel
      title={copy.adminNames}
      defaultOpen
      action={action}
      badge={
        <span className="rounded-full bg-cream px-2 py-0.5 text-xs font-bold text-food-orange-dark">
          {dish.nativeNames.length}
        </span>
      }
    >
      <dl className="flex min-w-0 flex-col gap-1.5 text-sm">
        <div className="min-w-0">
          <dt className="font-semibold">{pick(lang, "Display name", "Tên hiển thị")}</dt>
          <dd className="min-w-0 break-words">{canonicalName}</dd>
        </div>
        {englishName !== null ? (
          <div className="min-w-0">
            <dt className="font-semibold">{pick(lang, "English name", "Tên tiếng Anh")}</dt>
            <dd className="min-w-0 break-words">{englishName}</dd>
          </div>
        ) : (
          <p className="text-muted">
            {pick(lang, "No English name recorded.", "Chưa có tên tiếng Anh.")}
          </p>
        )}
      </dl>
      {dish.nativeNames.length === 0 ? (
        <p className="mt-1.5 text-sm text-muted">
          {pick(
            lang,
            "No additional native names recorded.",
            "Chưa ghi nhận tên bản địa nào khác.",
          )}
        </p>
      ) : (
        <ul className="mt-1.5 flex min-w-0 flex-col gap-1 text-sm">
          {dish.nativeNames.map((entry) => {
            const preferred = "isPreferred" in entry && entry.isPreferred === true;

            return (
              <li key={`${entry.languageTag}:${entry.name}`} className="min-w-0 break-words">
                <span className="mr-2 inline-block rounded-full bg-cream px-2 py-0.5 text-xs font-bold text-food-orange-dark">
                  {entry.languageTag}
                </span>
                {entry.name}
                {preferred ? (
                  <span className="ml-2 text-xs font-bold text-food-orange-dark">
                    · {copy.adminPreferred}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </CollapsiblePanel>
  );
}

export function DishDescriptions({
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
    <CollapsiblePanel title={copy.adminDescriptions} defaultOpen action={action}>
      {dish.description !== null ? (
        <p className="min-w-0 text-sm break-words">
          {dish.description}
          {dish.descriptionLanguage !== null ? (
            <span className="ml-2 inline-block rounded-full bg-cream px-2 py-0.5 text-xs font-bold text-food-orange-dark">
              {dish.descriptionLanguage}
            </span>
          ) : null}
        </p>
      ) : (
        <p className="text-sm text-muted">
          {pick(lang, "No description recorded.", "Chưa có mô tả.")}
        </p>
      )}
    </CollapsiblePanel>
  );
}
