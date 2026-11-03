import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Star, Trash2, X } from "lucide-react";
import { useState } from "react";

import { AdminSelectField } from "@/components/admin/select";
import { AdminEmptyState, AdminGhostButton, AdminPrimaryButton } from "@/components/admin/ui";

/**
 * Customer Reviews moderation queue. Visually and logically separate from the
 * menu/price/serving/scan queues: it moderates traveler-authored review text,
 * never price facts or dish evidence.
 *
 * Authorization lives server-side (`restaurant:review` on
 * moderateRestaurantCustomerReview). `canReview` only hides the queue from
 * members without the grant — it is a navigation hint, never a boundary.
 *
 * Audit safety: the queue renders author content read-only. No control here
 * edits the author or the body; decisions only move `status`.
 */

export type ModerationStatusFilter = "pending" | "published" | "rejected" | "removed" | "all";

export type ModerationDecision = "published" | "rejected" | "removed";

export type ModerationEntryStatus = "pending" | "published" | "rejected" | "removed";

export interface ModerationReviewEntry {
  readonly id: string;
  readonly venueId: string;
  readonly venueName: string;
  readonly rating: number;
  readonly body: string;
  readonly status: ModerationEntryStatus;
  readonly submittedAt: string;
}

export interface ModerationQueueQuery {
  readonly venue: string;
  readonly status: ModerationStatusFilter;
  readonly limit: number;
  readonly offset: number;
}

export interface ModerationQueuePage {
  readonly items: ReadonlyArray<ModerationReviewEntry>;
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly pendingCount: number;
}

export interface ModerationDecisionInput {
  readonly reviewId: string;
  readonly status: ModerationDecision;
}

export interface ModerationDecisionResult {
  readonly reviewId: string;
  readonly status: ModerationDecision;
  readonly repeated: boolean;
}

/**
 * Staff-scoped queue contract — backed by `listCustomerReviewQueue`
 * (`restaurant:review`-gated, cross-venue, pending-first). The public list
 * fn is published-only/single-venue and cannot back this queue; the adapter
 * in `admin.restaurants.tsx` wires the staff endpoint.
 */
export interface CustomerReviewModerationClient {
  readonly loadQueue: (
    query: ModerationQueueQuery,
    signal?: AbortSignal,
  ) => Promise<ModerationQueuePage>;
  readonly decide: (input: ModerationDecisionInput) => Promise<ModerationDecisionResult>;
}

/** Decision payload carries the review ID only — never author, body, or rating. */
export function toDecisionInput(
  reviewId: string,
  status: ModerationDecision,
): ModerationDecisionInput {
  return { reviewId, status };
}

/**
 * Duplicate-decision guard: a control is disabled while a mutation is pending
 * or when the entry already holds the target status.
 */
export function decisionDisabled(
  entryStatus: ModerationEntryStatus,
  decision: ModerationDecision,
  pending: boolean,
): boolean {
  if (pending) return true;

  return entryStatus === decision;
}

export function describeDecision(result: ModerationDecisionResult): string {
  if (result.repeated) return "That decision was already recorded.";

  if (result.status === "removed")
    return "Review removed. The row stays for audit and never appears publicly again.";

  return `Review ${result.status}.`;
}

const STATUS_OPTIONS: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
  { label: "Pending", value: "pending" },
  { label: "Published", value: "published" },
  { label: "Rejected", value: "rejected" },
  { label: "Removed", value: "removed" },
  { label: "All decisions", value: "all" },
];

function ModerationEntryRow({
  entry,
  pending,
  confirmingRemove,
  onDecide,
  onArmRemove,
  onDisarmRemove,
}: {
  readonly entry: ModerationReviewEntry;
  readonly pending: boolean;
  readonly confirmingRemove: boolean;
  readonly onDecide: (input: ModerationDecisionInput) => void;
  readonly onArmRemove: () => void;
  readonly onDisarmRemove: () => void;
}) {
  return (
    <li className="crm-entry">
      <div className="crm-entry-head">
        <h3 className="crm-entry-title">
          {entry.venueName} · {entry.rating} of 5
        </h3>
        <p className="crm-entry-meta">
          <Star aria-hidden="true" className="crm-icon" />
          <span aria-label={`Rated ${entry.rating} out of 5`}>{entry.rating}/5</span>
          <span aria-hidden="true">·</span>
          <span>{entry.status}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={entry.submittedAt}>submitted {entry.submittedAt.slice(0, 10)}</time>
        </p>
      </div>
      <blockquote className="crm-body">{entry.body}</blockquote>
      <div className="crm-actions">
        <AdminPrimaryButton
          type="button"
          disabled={decisionDisabled(entry.status, "published", pending)}
          onClick={() => onDecide(toDecisionInput(entry.id, "published"))}
        >
          <Check aria-hidden="true" className="crm-icon" />
          Publish
        </AdminPrimaryButton>
        <AdminGhostButton
          type="button"
          disabled={decisionDisabled(entry.status, "rejected", pending)}
          onClick={() => onDecide(toDecisionInput(entry.id, "rejected"))}
        >
          <X aria-hidden="true" className="crm-icon" />
          Reject
        </AdminGhostButton>
        {confirmingRemove ? (
          <>
            <span className="crm-confirm" role="alert">
              Remove this review? The text stays for audit only.
            </span>
            <AdminGhostButton
              type="button"
              disabled={pending}
              aria-busy={pending}
              onClick={() => onDecide(toDecisionInput(entry.id, "removed"))}
            >
              <Trash2 aria-hidden="true" className="crm-icon" />
              Confirm remove
            </AdminGhostButton>
            <AdminGhostButton type="button" disabled={pending} onClick={onDisarmRemove}>
              Keep review
            </AdminGhostButton>
          </>
        ) : (
          <AdminGhostButton
            type="button"
            disabled={decisionDisabled(entry.status, "removed", pending)}
            onClick={onArmRemove}
          >
            <Trash2 aria-hidden="true" className="crm-icon" />
            Remove
          </AdminGhostButton>
        )}
      </div>
    </li>
  );
}

export function RestaurantReviewModeration({
  canReview,
  client,
  initialPage,
}: {
  readonly canReview: boolean;
  readonly client: CustomerReviewModerationClient;
  readonly initialPage?: ModerationQueuePage;
}) {
  const queryClient = useQueryClient();
  const [venue, setVenue] = useState("");
  const [status, setStatus] = useState<ModerationStatusFilter>("pending");

  const [applied, setApplied] = useState<ModerationQueueQuery>({
    venue: "",
    status: "pending",
    limit: 20,
    offset: 0,
  });

  const [notice, setNotice] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const page = useQuery({
    queryKey: ["admin", "customer-reviews", applied],
    queryFn: ({ signal }) => client.loadQueue(applied, signal),
    enabled: canReview,
    initialData: initialPage,
    retry: false,
  });

  const decision = useMutation({
    mutationFn: (input: ModerationDecisionInput) => client.decide(input),
    onSuccess: (result) => {
      setNotice(describeDecision(result));
      setConfirmingId(null);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "The decision failed. Retry.";

      if (message.includes("Another moderator") || message.includes("changed while")) {
        setNotice(`${message} The queue was refreshed; review the latest status before retrying.`);
      } else {
        setNotice(message);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "customer-reviews"] });
      void queryClient.invalidateQueries({ queryKey: ["customer-reviews"] });
    },
  });

  if (!canReview) return null;

  const total = page.data?.total ?? 0;
  const pendingCount = page.data?.pendingCount ?? 0;
  const shown = page.data?.items.length ?? 0;
  const first = total === 0 ? 0 : applied.offset + 1;
  const last = applied.offset + shown;

  const applyFilters = (): void => {
    setNotice("");
    setConfirmingId(null);
    setApplied({ venue: venue.trim(), status, limit: 20, offset: 0 });
  };

  return (
    <div className="crm-queue" lang="en">
      <p className="crm-lede">
        Traveler reviews awaiting moderation. Publish, reject, or remove whole reviews only — the
        author and the text are never edited here. {pendingCount} pending.
      </p>
      <form
        className="crm-filters"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
      >
        <div className="crm-field">
          <label htmlFor="crm-venue">Restaurant</label>
          <input
            id="crm-venue"
            value={venue}
            maxLength={200}
            onChange={(event) => setVenue(event.target.value)}
            placeholder="Branch, area, or address"
          />
        </div>
        <AdminSelectField
          id="crm-status"
          label="Review status"
          value={status}
          onValueChange={(value) => {
            if (
              value === "pending" ||
              value === "published" ||
              value === "rejected" ||
              value === "removed" ||
              value === "all"
            )
              setStatus(value);
          }}
          options={STATUS_OPTIONS.map((option) => ({
            label: option.label,
            value: option.value,
          }))}
        />
        <div className="crm-filter-action">
          <AdminGhostButton type="submit" disabled={page.isFetching}>
            Search reviews
          </AdminGhostButton>
        </div>
      </form>
      {page.isPending && <p aria-live="polite">Loading customer reviews…</p>}
      {page.isError && (
        <p className="text-sm font-semibold text-red-800" role="alert">
          {page.error.message}
        </p>
      )}
      {page.data !== undefined && (
        <>
          <p aria-live="polite" className="crm-count">
            Showing {first}–{last} of {total} reviews ({pendingCount} pending).
          </p>
          {total === 0 ? (
            <AdminEmptyState message="No customer reviews match these filters." />
          ) : (
            <ul className="crm-list">
              {page.data.items.map((entry) => (
                <ModerationEntryRow
                  key={entry.id}
                  entry={entry}
                  pending={decision.isPending || page.isFetching}
                  confirmingRemove={confirmingId === entry.id}
                  onDecide={(input) => decision.mutate(input)}
                  onArmRemove={() => setConfirmingId(entry.id)}
                  onDisarmRemove={() => setConfirmingId(null)}
                />
              ))}
            </ul>
          )}
          <div className="crm-pager">
            <AdminGhostButton
              type="button"
              disabled={applied.offset === 0 || page.isFetching}
              onClick={() => setApplied((previous) => ({ ...previous, offset: 0 }))}
            >
              First page
            </AdminGhostButton>
            <AdminGhostButton
              type="button"
              disabled={applied.offset + shown >= total || page.isFetching}
              onClick={() =>
                setApplied((previous) => ({
                  ...previous,
                  offset: previous.offset + previous.limit,
                }))
              }
            >
              Next page
            </AdminGhostButton>
          </div>
        </>
      )}
      {notice !== "" && (
        <p className="crm-notice" aria-live="polite">
          {notice}
        </p>
      )}
      {decision.isError && (
        <p className="text-sm font-semibold text-red-800" role="alert">
          {decision.error.message}
        </p>
      )}
    </div>
  );
}
