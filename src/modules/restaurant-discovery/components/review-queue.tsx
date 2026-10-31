import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

/**
 * Observation review queue: pending-first, searchable, server-paginated.
 * Rows, totals and decisions arrive through the injected client so this
 * component never imports server-only operations or transport modules it
 * does not own; the coordinator wires the client to the review operations.
 * Authorization is enforced inside the Effect operations, never by hiding
 * these buttons.
 */

export type ReviewKindFilter = "all" | "price" | "serving";

export type ReviewStatusFilter = "all" | "pending" | "approved" | "rejected";

export interface ReviewQueueQuery {
  readonly venue: string;
  readonly kind: ReviewKindFilter;
  readonly status: ReviewStatusFilter;
  readonly from: string | null;
  readonly to: string | null;
  readonly limit: number;
  readonly offset: number;
}

export interface ReviewQueueEntry {
  readonly id: string;
  readonly kind: string;
  readonly venue: string;
  readonly item: string;
  readonly variant: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly detail: string | null;
  readonly review_status: string;
  readonly observed_at: string;
  readonly review_after: string;
  readonly sales_channel: string | null;
  readonly tax_treatment: string | null;
  readonly source_category: string;
  readonly restaurant_verified: boolean;
  readonly source_url: string | null;
  readonly receipt_quantity: string | null;
  readonly receipt_unit: string | null;
  readonly receipt_total: string | null;
  readonly receipt_discount: string | null;
  readonly receipt_fees: string | null;
  readonly receipt_semantics: string | null;
  readonly reviewed_by: string | null;
  readonly reviewed_at: string | null;
}

export interface ReviewQueuePage {
  readonly items: ReadonlyArray<ReviewQueueEntry>;
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface ObservationDecisionInput {
  readonly kind: "price" | "serving";
  readonly id: string;
  readonly status: "approved" | "rejected";
}

export interface ObservationDecisionResult {
  readonly id: string;
  readonly status: string;
  readonly repeated: boolean;
}

export interface ReviewQueueClient {
  readonly loadPage: (query: ReviewQueueQuery, signal?: AbortSignal) => Promise<ReviewQueuePage>;
  readonly decide: (input: ObservationDecisionInput) => Promise<ObservationDecisionResult>;
}

const PAGE_SIZES = [10, 25, 50] as const;

const toISODate = (value: string): string => new Date(`${value}T00:00:00Z`).toISOString();

function suggestionBlocked(entry: ReviewQueueEntry): boolean {
  return entry.kind === "serving" && (entry.detail ?? "").startsWith("suggestion");
}

function ReviewEntry({
  entry,
  busy,
  onDecide,
}: {
  readonly entry: ReviewQueueEntry;
  readonly busy: boolean;
  readonly onDecide: (input: ObservationDecisionInput) => void;
}) {
  const decided = entry.review_status !== "pending";
  const kind: "price" | "serving" = entry.kind === "serving" ? "serving" : "price";

  return (
    <li className="discovery-card">
      <h3>
        {entry.venue} · {entry.item}
        {entry.variant !== null && ` · ${entry.variant}`}
      </h3>
      <p>
        {entry.kind} · {entry.detail} ·{" "}
        {entry.amount !== null ? `${entry.amount} ${entry.currency ?? ""}` : "no price"} ·{" "}
        {entry.review_status}
      </p>
      <p className="text-sm">
        {entry.source_category} · restaurant verified: {String(entry.restaurant_verified)} ·
        observed {entry.observed_at.slice(0, 10)} · review again by{" "}
        {entry.review_after.slice(0, 10)}
      </p>
      {entry.sales_channel !== null && (
        <p className="text-sm">
          {entry.sales_channel} · tax {entry.tax_treatment}
          {entry.receipt_quantity !== null &&
            ` · receipt quantity ${entry.receipt_quantity}, explicit paid unit ${entry.receipt_unit}, line total ${entry.receipt_total}, discount ${entry.receipt_discount}, taxes/fees ${entry.receipt_fees}, ${entry.receipt_semantics}`}
        </p>
      )}
      {entry.source_category === "receipt" && (
        <p className="text-sm">
          Receipt originals stay private; only structured totals are shown. Approval never publishes
          a photograph.
        </p>
      )}
      {entry.source_url !== null && (
        <a href={entry.source_url} target="_blank" rel="noreferrer">
          Inspect source
        </a>
      )}
      {decided && (
        <p className="text-sm">
          Previously decided: {entry.review_status} by {entry.reviewed_by} at{" "}
          {entry.reviewed_at?.slice(0, 10)}
        </p>
      )}
      <div className="discovery-card-actions">
        <button
          type="button"
          disabled={busy || decided || suggestionBlocked(entry)}
          title={
            suggestionBlocked(entry)
              ? "Suggested dish matches cannot be approved; exact or variant evidence is required."
              : undefined
          }
          onClick={() => onDecide({ kind, id: entry.id, status: "approved" })}
        >
          Approve
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || decided}
          onClick={() => onDecide({ kind, id: entry.id, status: "rejected" })}
        >
          Reject
        </button>
      </div>
    </li>
  );
}

export function ReviewQueue({
  canReview,
  client,
}: {
  readonly canReview: boolean;
  readonly client: ReviewQueueClient;
}) {
  const queryClient = useQueryClient();
  const [venue, setVenue] = useState("");
  const [kind, setKind] = useState<ReviewKindFilter>("all");
  const [status, setStatus] = useState<ReviewStatusFilter>("pending");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState<number>(25);

  const [applied, setApplied] = useState<ReviewQueueQuery>({
    venue: "",
    kind: "all",
    status: "pending",
    from: null,
    to: null,
    limit: 25,
    offset: 0,
  });

  const [filterError, setFilterError] = useState("");

  const [notice, setNotice] = useState("");

  const page = useQuery({
    queryKey: ["restaurant-review-queue", applied],
    queryFn: ({ signal }) => client.loadPage(applied, signal),
    enabled: canReview,
    retry: false,
  });

  const decision = useMutation({
    mutationFn: (input: ObservationDecisionInput) => client.decide(input),
    onSuccess: (result) => {
      if (result.repeated) setNotice("That decision was already recorded.");
      else setNotice(`Observation ${result.status}.`);

      void queryClient.invalidateQueries({ queryKey: ["restaurant-review-queue"] });
    },
    onError: (error) => {
      setNotice(error instanceof Error ? error.message : "The decision failed. Retry.");
    },
  });

  if (!canReview) return null;

  const applyFilters = (): void => {
    if (from !== "" && to !== "" && from > to) {
      setFilterError("The observed-from date must not be after the observed-to date.");

      return;
    }

    setFilterError("");
    setNotice("");
    setApplied({
      venue: venue.trim(),
      kind,
      status,
      from: from === "" ? null : toISODate(from),
      to: to === "" ? null : toISODate(to),
      limit,
      offset: 0,
    });
  };

  const total = page.data?.total ?? 0;
  const shown = page.data?.items.length ?? 0;
  const first = total === 0 ? 0 : applied.offset + 1;
  const last = applied.offset + shown;

  const goTo = (offset: number): void => {
    setApplied((previous) => ({ ...previous, offset }));
  };

  return (
    <section aria-label="Observation review queue">
      <h2>Observation review queue</h2>
      <p className="my-3 text-sm text-muted">
        Pending observations first. Filter by branch, evidence type, review status and observation
        date; pages load from the server so the queue never depends on an unbounded latest-N dump.
        Reviewed facts stay in history; conflicting records are retained and an approval never
        deletes an earlier price.
      </p>
      <form
        className="restaurant-filters"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
      >
        <div>
          <label htmlFor="review-queue-venue">Branch, area or address</label>
          <input
            id="review-queue-venue"
            value={venue}
            maxLength={200}
            onChange={(event) => setVenue(event.target.value)}
            placeholder="Search branches"
          />
        </div>
        <div>
          <label htmlFor="review-queue-kind">Evidence type</label>
          <select
            id="review-queue-kind"
            value={kind}
            onChange={(event) => {
              const value = event.target.value;

              if (value === "price" || value === "serving" || value === "all") setKind(value);
            }}
          >
            <option value="all">Price and serving</option>
            <option value="price">Price only</option>
            <option value="serving">Serving only</option>
          </select>
        </div>
        <div>
          <label htmlFor="review-queue-status">Review status</label>
          <select
            id="review-queue-status"
            value={status}
            onChange={(event) => {
              const value = event.target.value;

              if (
                value === "pending" ||
                value === "approved" ||
                value === "rejected" ||
                value === "all"
              )
                setStatus(value);
            }}
          >
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="all">All decisions</option>
          </select>
        </div>
        <div>
          <label htmlFor="review-queue-from">Observed from</label>
          <input
            id="review-queue-from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="review-queue-to">Observed to</label>
          <input
            id="review-queue-to"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="review-queue-limit">Page size</label>
          <select
            id="review-queue-limit"
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} per page
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={page.isFetching}>
          Search queue
        </button>
      </form>
      {filterError !== "" && (
        <p className="discovery-message" role="alert">
          {filterError}
        </p>
      )}
      {page.isPending && <p aria-live="polite">Loading review queue…</p>}
      {page.isError && (
        <p className="discovery-message" role="alert">
          {page.error.message}
        </p>
      )}
      {page.data !== undefined && (
        <>
          <p aria-live="polite" className="my-3 text-sm text-muted">
            Showing {first}–{last} of {total} observations.
          </p>
          {total === 0 && <p>No observations match these filters.</p>}
          <ul className="grid gap-3">
            {page.data.items.map((entry) => (
              <ReviewEntry
                key={`${entry.kind}:${entry.id}`}
                entry={entry}
                busy={decision.isPending || page.isFetching}
                onDecide={(input) => decision.mutate(input)}
              />
            ))}
          </ul>
          <div className="discovery-card-actions">
            <button
              type="button"
              className="secondary"
              disabled={applied.offset === 0 || page.isFetching}
              onClick={() => goTo(Math.max(0, applied.offset - applied.limit))}
            >
              Previous page
            </button>
            <button
              type="button"
              className="secondary"
              disabled={applied.offset + shown >= total || page.isFetching}
              onClick={() => goTo(applied.offset + applied.limit)}
            >
              Next page
            </button>
          </div>
        </>
      )}
      {notice !== "" && (
        <p className="discovery-message" aria-live="polite">
          {notice}
        </p>
      )}
      {decision.isError && (
        <p className="discovery-message" role="alert">
          {decision.error.message}
        </p>
      )}
    </section>
  );
}
