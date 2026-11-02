import { Archive, BookOpen, Ellipsis, Image as ImageIcon, Pencil } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AdminSelect } from "@/components/admin/select";
import {
  AdminCard,
  AdminConfirmDialog,
  AdminEmptyState,
  AdminGhostButton,
  AdminPrimaryButton,
  AdminSecondaryButton,
  AdminTable,
  AdminToolbar,
} from "@/components/admin/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

export type DashboardTab = "overview" | "menu" | "photos" | "reviews" | "sources";

const DASHBOARD_TAB_LABELS: ReadonlyMap<string, string> = new Map([
  ["overview", "Overview"],
  ["menu", "Menu"],
  ["photos", "Photos"],
  ["reviews", "Reviews"],
  ["sources", "Sources"],
]);

export const DASHBOARD_TABS: ReadonlyArray<DashboardTab> = [
  "overview",
  "menu",
  "photos",
  "reviews",
  "sources",
];

export function dashboardTabLabel(tab: DashboardTab): string {
  return DASHBOARD_TAB_LABELS.get(tab) ?? tab;
}

export function isDashboardTab(value: string): value is DashboardTab {
  return DASHBOARD_TAB_LABELS.has(value);
}

const STATUS_CLASS: ReadonlyMap<string, string> = new Map([
  ["draft", "border-amber-200 bg-amber-50 text-amber-800"],
  ["published", "border-green-200 bg-green-50 text-green-800"],
  ["archived", "border-border-soft bg-cream text-muted"],
]);

const PAGE_SIZE = 20;

/**
 * Compact icon control for one restaurant row action. Every instance is a
 * native button with an accessible name plus a visible tooltip, a 44px
 * minimum target, and a focus ring — icon-only buttons never rely on color
 * or position alone (see fixing-accessibility).
 */
const rowIconButtonClass =
  "inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg border border-border-soft bg-white text-ink hover:bg-cream focus-visible:ring-2 focus-visible:ring-brand-blue/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";

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
  selectedId,
  activeTab,
  onSelectVenue,
  onTabChange,
  onManagePhotos,
  onArchive,
  canEdit,
  canArchive,
  renderTabPanel,
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
  /** Controlled detail selection. Null (default) hides the tab panel. */
  readonly selectedId?: string | null | undefined;
  /** Controlled detail tab. Defaults to overview. */
  readonly activeTab?: DashboardTab | undefined;
  /** Row/tap selection. Absent keeps the table read-only for selection. */
  readonly onSelectVenue?: ((venue: DashboardVenue | null) => void) | undefined;
  readonly onTabChange?: ((tab: DashboardTab) => void) | undefined;
  /** Opens the existing photo UI (editor). Defaults to onEdit. */
  readonly onManagePhotos?: ((venue: DashboardVenue) => void) | undefined;
  /** Single-venue archive via the existing status endpoint. No hard delete. */
  readonly onArchive?: ((venue: DashboardVenue) => void) | undefined;
  /** Manage grant hint for Edit/Menu/Photos. Server still enforces. */
  readonly canEdit?: boolean | undefined;
  /** Manage grant hint for Archive. Review is not required to archive. */
  readonly canArchive?: boolean | undefined;
  /** Tab body supplied by the route from existing components. */
  readonly renderTabPanel?: ((venue: DashboardVenue, tab: DashboardTab) => ReactNode) | undefined;
}) {
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const allPageSelected =
    venues.length > 0 && venues.every((venue) => selection.includes(venue.id));

  const editAllowed = canEdit ?? true;
  const archiveAllowed = canArchive ?? true;
  const tab = activeTab ?? "overview";
  const selectedVenue = venues.find((venue) => venue.id === selectedId) ?? null;
  const [archiveTarget, setArchiveTarget] = useState<DashboardVenue | null>(null);

  const handlePhotos = (venue: DashboardVenue): void => {
    if (onManagePhotos !== undefined) {
      onManagePhotos(venue);
    } else {
      onEdit(venue);
    }
  };

  const closeArchiveConfirm = (): void => {
    setArchiveTarget(null);
  };

  const confirmArchive = (): void => {
    if (archiveTarget !== null && onArchive !== undefined) {
      onArchive(archiveTarget);
    }

    setArchiveTarget(null);
  };

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
        <AdminSelect
          id="dashboard-status"
          value={status}
          disabled={busy}
          onValueChange={(next) => {
            if (next === "" || next === "draft" || next === "published" || next === "archived") {
              onStatus(next);
            }
          }}
          triggerClassName="w-44"
          options={[
            { label: "All states", value: "" },
            { label: "Drafts", value: "draft" },
            { label: "Published", value: "published" },
            { label: "Archived", value: "archived" },
          ]}
        />
        <AdminPrimaryButton type="button" disabled={busy} onClick={onCreate}>
          Add restaurant
        </AdminPrimaryButton>
      </AdminToolbar>

      {actionMessage !== "" && (
        <p className="text-sm font-semibold" aria-live="polite">
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
              ? "No restaurants yet. Add the first restaurant to start recording source-backed venues."
              : "No restaurants match this search."
          }
          action={
            total === 0 ? (
              <AdminPrimaryButton type="button" disabled={busy} onClick={onCreate}>
                Add restaurant
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
              <th scope="col" className="px-3 py-2">
                Branch
              </th>
              <th scope="col" className="px-3 py-2">
                Business
              </th>
              <th scope="col" className="px-3 py-2">
                Status
              </th>
              <th scope="col" className="px-3 py-2">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {venues.map((venue) => {
              const checked = selection.includes(venue.id);
              const isSelected = selectedVenue?.id === venue.id;
              const archiveDisabled = busy || !archiveAllowed || venue.status === "archived";
              const editDisabled = busy || !editAllowed;

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
                    <button
                      type="button"
                      disabled={busy || onSelectVenue === undefined}
                      onClick={() => onSelectVenue?.(venue)}
                      aria-pressed={isSelected}
                      title={`Open details for ${venue.name}`}
                      className="rounded-md text-left font-semibold underline decoration-brand-blue/40 underline-offset-2 hover:decoration-brand-blue focus-visible:ring-2 focus-visible:ring-brand-blue/40 focus-visible:outline-none disabled:no-underline disabled:opacity-60"
                    >
                      {venue.name}
                    </button>
                    <p className="text-xs text-muted">
                      {venue.area} · {venue.countryCode}
                    </p>
                    <p className="text-xs text-muted">{venue.address}</p>
                  </td>
                  <td className="px-3 py-2 text-sm">{venue.businessName}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={venue.status} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Edit ${venue.name}`}
                        title={`Edit ${venue.name}`}
                        disabled={editDisabled}
                        onClick={() => onEdit(venue)}
                        className={rowIconButtonClass}
                      >
                        <Pencil aria-hidden="true" className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Manage menu for ${venue.name}`}
                        title={`Manage menu for ${venue.name}`}
                        disabled={editDisabled}
                        onClick={() => onManageMenus(venue)}
                        className={rowIconButtonClass}
                      >
                        <BookOpen aria-hidden="true" className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Manage photos for ${venue.name}`}
                        title={`Manage photos for ${venue.name}`}
                        disabled={editDisabled}
                        onClick={() => handlePhotos(venue)}
                        className={rowIconButtonClass}
                      >
                        <ImageIcon aria-hidden="true" className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Archive ${venue.name}`}
                        title={`Archive ${venue.name}`}
                        disabled={archiveDisabled}
                        onClick={() => setArchiveTarget(venue)}
                        className={rowIconButtonClass}
                      >
                        <Archive aria-hidden="true" className="size-4" />
                      </button>
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`More actions for ${venue.name}`}
                            title={`More actions for ${venue.name}`}
                            disabled={busy}
                            className={`${rowIconButtonClass} border-transparent`}
                          >
                            <Ellipsis aria-hidden="true" className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem disabled={editDisabled} onSelect={() => onEdit(venue)}>
                            <Pencil aria-hidden="true" className="size-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={editDisabled}
                            onSelect={() => onManageMenus(venue)}
                          >
                            <BookOpen aria-hidden="true" className="size-4" />
                            Manage menu
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={editDisabled}
                            onSelect={() => handlePhotos(venue)}
                          >
                            <ImageIcon aria-hidden="true" className="size-4" />
                            Manage photos
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={archiveDisabled}
                            onSelect={() => setArchiveTarget(venue)}
                          >
                            <Archive aria-hidden="true" className="size-4" />
                            Archive
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </AdminTable>
      )}

      {selectedVenue !== null && (
        <section
          aria-label={`Details for ${selectedVenue.name}`}
          className="rounded-2xl border border-border-soft bg-white p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold">{selectedVenue.name}</h2>
            {onSelectVenue !== undefined && (
              <AdminGhostButton type="button" onClick={() => onSelectVenue(null)}>
                Close details
              </AdminGhostButton>
            )}
          </div>
          <div
            role="tablist"
            aria-label={`Sections for ${selectedVenue.name}`}
            className="mt-3 flex flex-wrap gap-1"
          >
            {DASHBOARD_TABS.map((entry) => {
              const selected = tab === entry;

              return (
                <button
                  key={entry}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => onTabChange?.(entry)}
                  className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold focus-visible:ring-2 focus-visible:ring-brand-blue/40 focus-visible:outline-none ${
                    selected
                      ? "border-food-orange bg-cream font-bold text-food-orange-dark"
                      : "border-border-soft bg-white text-ink hover:bg-cream"
                  }`}
                >
                  {dashboardTabLabel(entry)}
                </button>
              );
            })}
          </div>
          <div role="tabpanel" className="mt-3">
            {renderTabPanel !== undefined ? (
              renderTabPanel(selectedVenue, tab)
            ) : (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="font-semibold">Business</dt>
                  <dd>{selectedVenue.businessName}</dd>
                </div>
                <div>
                  <dt className="font-semibold">Address</dt>
                  <dd>
                    {selectedVenue.address} · {selectedVenue.area} · {selectedVenue.countryCode}
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold">Status</dt>
                  <dd>
                    <StatusBadge status={selectedVenue.status} />
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold">Cuisines</dt>
                  <dd>
                    {selectedVenue.cuisineIds.length === 0
                      ? "—"
                      : selectedVenue.cuisineIds
                          .map((id) => cuisinesById.get(id) ?? `#${id}`)
                          .join(", ")}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        </section>
      )}

      <AdminConfirmDialog
        open={archiveTarget !== null}
        title={archiveTarget === null ? "Archive restaurant" : `Archive ${archiveTarget.name}?`}
        description="The branch leaves the public list. Sources, prices and serving history are retained; nothing is deleted."
        confirmLabel="Archive branch"
        cancelLabel="Cancel"
        pending={busy}
        onConfirm={confirmArchive}
        onCancel={closeArchiveConfirm}
      />

      <nav
        aria-label="Restaurant pages"
        className="flex items-center justify-between gap-2 text-sm"
      >
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
