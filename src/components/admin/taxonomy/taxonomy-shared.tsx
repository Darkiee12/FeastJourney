import type { ReactNode } from "react";

import type { BulkRowDisplay, BulkRowStatus } from "@/components/admin/taxonomy/taxonomy-contracts";
import { AdminEmptyState } from "@/components/admin/ui";

const ROW_STATUS_CLASS: ReadonlyMap<BulkRowStatus, string> = new Map([
  ["created", "border-green-200 bg-green-50 text-green-800"],
  ["skipped", "border-amber-200 bg-amber-50 text-amber-800"],
  ["invalid", "border-red-200 bg-red-50 text-red-800"],
]);

const ROW_STATUS_FALLBACK = "border-border-soft bg-cream text-muted";

export function BulkRowBadge({ status }: { readonly status: BulkRowStatus }): ReactNode {
  const tone = ROW_STATUS_CLASS.get(status) ?? ROW_STATUS_FALLBACK;

  return (
    <span
      className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold ${tone}`}
    >
      {status}
    </span>
  );
}

/**
 * Per-row bulk outcome list. One row per submitted line: created rows show
 * the label alone, skipped/invalid rows append the server reason. Text (not
 * color alone) carries the status for screen readers.
 */
export function BulkResultList({
  createdCount,
  emptyMessage,
  rows,
}: {
  readonly createdCount: number;
  readonly emptyMessage: string;
  readonly rows: ReadonlyArray<BulkRowDisplay>;
}): ReactNode {
  if (rows.length === 0) {
    return <AdminEmptyState message={emptyMessage} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <output className="text-sm font-semibold text-ink">
        {createdCount} created · {rows.filter((row) => row.status === "skipped").length} skipped ·{" "}
        {rows.filter((row) => row.status === "invalid").length} invalid
      </output>
      <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border-soft bg-white px-3 py-2 text-sm"
          >
            <BulkRowBadge status={row.status} />
            <span className="min-w-0 flex-1 break-words font-medium text-ink">{row.label}</span>
            {row.reason === null ? null : (
              <span className="w-full text-xs text-muted">{row.reason}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Search input shared by both taxonomy tabs: labeled, full-width on mobile,
 * fixed width on desktop. The parent debounces before querying.
 */
export function TaxonomySearchField({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactNode {
  return (
    <div className="flex w-full flex-col gap-1 sm:max-w-xs">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <input
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="min-h-11 rounded-lg border border-border-soft bg-white px-3 py-2 text-sm text-ink"
      />
    </div>
  );
}
