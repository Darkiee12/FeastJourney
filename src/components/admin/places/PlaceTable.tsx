import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { PlaceListItem } from "@/components/admin/places/place-contracts";
import { AdminEmptyState, AdminTable } from "@/components/admin/ui";
import type { Locale, Messages } from "@/shared/i18n";

/**
 * Places registry table: display name (never a raw id alone — nameless
 * rows fall back to an explicit `Place #id` label), kind, ISO code, and
 * the curator display note. Row links preserve the caller's list search
 * so detail back-links restore filter context.
 */
export function PlaceTable({
  baseSearch,
  copy,
  lang,
  places,
}: {
  readonly baseSearch: {
    readonly kind: string;
    readonly lang: Locale;
    readonly page: number;
    readonly parentId: string;
    readonly query: string;
  };
  readonly copy: Messages;
  readonly lang: Locale;
  readonly places: ReadonlyArray<PlaceListItem>;
}): ReactNode {
  if (places.length === 0) {
    return <AdminEmptyState message={copy.adminNoResults} />;
  }

  return (
    <AdminTable minWidthClass="min-w-[36rem]">
      <thead>
        <tr className="border-b border-border-soft bg-cream">
          <th scope="col" className="px-3 py-2 font-semibold">
            {copy.adminPlaces}
          </th>
          <th scope="col" className="px-3 py-2 font-semibold">
            {copy.adminKind}
          </th>
          <th scope="col" className="px-3 py-2 font-semibold">
            {copy.adminIso}
          </th>
          <th scope="col" className="px-3 py-2 font-semibold">
            {copy.adminDisplayNote}
          </th>
        </tr>
      </thead>
      <tbody>
        {places.map((place) => (
          <tr key={place.id} className="border-b border-border-soft last:border-0">
            <td className="px-3 py-2">
              <Link
                to="/admin/places/$placeId"
                params={{ placeId: place.id }}
                search={{
                  lang: baseSearch.lang,
                  fromQuery: baseSearch.query,
                  fromKind: baseSearch.kind,
                  fromParent: baseSearch.parentId,
                  fromPage: baseSearch.page,
                }}
                className="inline-flex min-h-11 items-center font-medium text-brand-blue underline"
              >
                {place.displayName ??
                  (lang === "vi" ? `Địa điểm #${place.id}` : `Place #${place.id}`)}
              </Link>
              {place.displayName === null ? null : (
                <span className="block font-mono text-xs text-muted">place:{place.id}</span>
              )}
            </td>
            <td className="px-3 py-2">{place.kind}</td>
            <td className="px-3 py-2">{place.iso3166 ?? "—"}</td>
            <td className="max-w-64 px-3 py-2">
              <span className="block truncate">{place.displayNote ?? "—"}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </AdminTable>
  );
}
