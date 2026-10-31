import {
  AdminCard,
  AdminEmptyState,
  AdminGhostButton,
  AdminPrimaryButton,
  AdminSecondaryButton,
  AdminTable,
  AdminToolbar,
  adminGhostButtonClass,
} from "@/components/admin/ui";

export interface DashboardVenue {
  readonly id: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly name: string;
  readonly address: string;
  readonly area: string;
  readonly countryCode: string;
  readonly status: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly cuisineIds: ReadonlyArray<string>;
  readonly sourceCount: number;
  readonly pendingCount: number;
  readonly pendingEvidence: number;
}

export type VenueStatusFilter = "" | "draft" | "published" | "archived";

const STATUS_CLASS: ReadonlyMap<string, string> = new Map([
  ["draft", "border-amber-200 bg-amber-50 text-amber-800"],
  ["published", "border-green-200 bg-green-50 text-green-800"],
  ["archived", "border-border-soft bg-cream text-muted"],
]);

const PAGE_SIZE = 20;

function StatusBadge({ status }: { readonly status: string }) {
  const tone = STATUS_CLASS.get(status) ?? "border-border-soft bg-cream text-muted";

  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {status}
    </span>
  );
}

export function RestaurantDashboard({
  venues,
  total,
  query,
  status,
  offset,
  busy,
  actionMessage,
  selection,
  cuisinesById,
  onQuery,
  onStatus,
  onOffset,
  onToggleSelect,
  onToggleSelectPage,
  onCreate,
  onEdit,
  onManageMenus,
  onBulkArchive,
  onBulkPublish,
}: {
  readonly venues: ReadonlyArray<DashboardVenue>;
  readonly total: number;
  readonly query: string;
  readonly status: VenueStatusFilter;
  readonly offset: number;
  readonly busy: boolean;
  readonly actionMessage: string;
  readonly selection: ReadonlyArray<string>;
  readonly cuisinesById: ReadonlyMap<string, string>;
  readonly onQuery: (query: string) => void;
  readonly onStatus: (status: VenueStatusFilter) => void;
  readonly onOffset: (offset: number) => void;
  readonly onToggleSelect: (id: string) => void;
  readonly onToggleSelectPage: () => void;
  readonly onCreate: () => void;
  readonly onEdit: (venue: DashboardVenue) => void;
  readonly onManageMenus: (venue: DashboardVenue) => void;
  readonly onBulkArchive: () => void;
  readonly onBulkPublish: () => void;
}) {
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const allPageSelected =
    venues.length > 0 && venues.every((venue) => selection.includes(venue.id));

  return (
    <div className="flex flex-col gap-4">
      <AdminToolbar>
        <label htmlFor="dashboard-search" className="sr-only">
          Search branches, businesses, areas
        </label>
        <input
          id="dashboard-search"
          type="search"
          value={query}
          disabled={busy}
          placeholder="Search branch, business, area…"
          onChange={(event) => onQuery(event.target.value)}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-border-soft bg-white px-3 py-2 text-sm"
        />
        <label htmlFor="dashboard-status" className="sr-only">
          Filter by publication state
        </label>
        <select
          id="dashboard-status"
          value={status}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value;

            if (next === "" || next === "draft" || next === "published" || next === "archived") {
              onStatus(next);
            }
          }}
          className="min-h-11 rounded-lg border border-border-soft bg-white px-3 text-sm"
        >
          <option value="">All states</option>
          <option value="draft">Drafts</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
        <AdminPrimaryButton type="button" disabled={busy} onClick={onCreate}>
          Add branch
        </AdminPrimaryButton>
      </AdminToolbar>

      {actionMessage !== "" && (
        <p className="discovery-message" aria-live="polite">
          {actionMessage}
        </p>
      )}

      {selection.length > 0 && (
        <AdminCard className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">{selection.length} selected</p>
          <AdminSecondaryButton type="button" disabled={busy} onClick={onBulkArchive}>
            Archive selected
          </AdminSecondaryButton>
          <AdminGhostButton type="button" disabled={busy} onClick={onBulkPublish}>
            Publish selected
          </AdminGhostButton>
        </AdminCard>
      )}

      {venues.length === 0 ? (
        <AdminEmptyState
          message={
            total === 0
              ? "No branches yet. Add the first branch to start recording source-backed venues."
              : "No branches match this search."
          }
          action={
            total === 0 ? (
              <AdminPrimaryButton type="button" disabled={busy} onClick={onCreate}>
                Add branch
              </AdminPrimaryButton>
            ) : undefined
          }
        />
      ) : (
        <AdminTable minWidthClass="min-w-[52rem]">
          <thead>
            <tr className="border-b border-border-soft text-left">
              <th className="px-3 py-2">
                <label htmlFor="dashboard-select-page" className="sr-only">
                  Select this page
                </label>
                <input
                  id="dashboard-select-page"
                  type="checkbox"
                  checked={allPageSelected}
                  disabled={busy}
                  onChange={onToggleSelectPage}
                />
              </th>
              <th className="px-3 py-2">Branch</th>
              <th className="px-3 py-2">Business</th>
              <th className="px-3 py-2">State</th>
              <th className="px-3 py-2">Cuisines</th>
              <th className="px-3 py-2">Sources</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {venues.map((venue) => {
              const checked = selection.includes(venue.id);
              const cuisineNames = venue.cuisineIds.map((id) => cuisinesById.get(id) ?? `#${id}`);
              const pending = venue.pendingCount + venue.pendingEvidence;

              return (
                <tr key={venue.id} className="border-b border-border-soft last:border-0">
                  <td className="px-3 py-2">
                    <label htmlFor={`dashboard-select-${venue.id}`} className="sr-only">
                      Select {venue.name}
                    </label>
                    <input
                      id={`dashboard-select-${venue.id}`}
                      type="checkbox"
                      checked={checked}
                      disabled={busy}
                      onChange={() => onToggleSelect(venue.id)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <p className="font-semibold">{venue.name}</p>
                    <p className="text-xs text-muted">
                      {venue.area} · {venue.countryCode}
                    </p>
                    <p className="text-xs text-muted">{venue.address}</p>
                  </td>
                  <td className="px-3 py-2 text-sm">{venue.businessName}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={venue.status} />
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {cuisineNames.length === 0 ? "—" : cuisineNames.join(", ")}
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {venue.sourceCount} {venue.sourceCount === 1 ? "source" : "sources"}
                    {pending > 0 && ` · ${pending} pending`}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onEdit(venue)}
                      className={`${adminGhostButtonClass} mr-1`}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onManageMenus(venue)}
                      className={adminGhostButtonClass}
                    >
                      Menus
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </AdminTable>
      )}

      <nav aria-label="Branch pages" className="flex items-center justify-between gap-2 text-sm">
        <p aria-live="polite">
          Page {page} of {pageCount} · {total} {total === 1 ? "branch" : "branches"}
        </p>
        <div className="flex gap-2">
          <AdminGhostButton
            type="button"
            disabled={busy || offset === 0}
            onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </AdminGhostButton>
          <AdminGhostButton
            type="button"
            disabled={busy || offset + PAGE_SIZE >= total}
            onClick={() => onOffset(offset + PAGE_SIZE)}
          >
            Next
          </AdminGhostButton>
        </div>
      </nav>
    </div>
  );
}
