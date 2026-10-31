import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod";

import { ContributionReview } from "@/modules/restaurant-discovery/components/contribution-review";
import { DiscoveryError } from "@/modules/restaurant-discovery/components/discovery-error";
import {
  RestaurantDashboard,
  type DashboardVenue,
  type VenueStatusFilter,
} from "@/modules/restaurant-discovery/components/restaurant-dashboard";
import {
  RestaurantEditor,
  type EditorBusiness,
  type EditorSource,
  type EditorVenue,
  type VenueWriteInput,
} from "@/modules/restaurant-discovery/components/restaurant-editor";
import {
  importMenuFn,
  restaurantAdminFn,
  restaurantFacetsFn,
  reviewRestaurantFn,
  setMenuStatusFn,
  setOfferingStatusFn,
  writeVenueFn,
} from "@/modules/restaurant-discovery/restaurant.functions";
import {
  menuImportSchema,
  menuStatusSchema,
  offeringStatusSchema,
} from "@/modules/restaurant-discovery/restaurant.schema";

export const Route = createFileRoute("/admin/restaurants")({
  loader: async () => {
    const [admin, cuisines] = await Promise.all([restaurantAdminFn(), restaurantFacetsFn()]);

    const initialPage = await venueListFn({
      data: { q: "", status: "", business: "", limit: PAGE_SIZE, offset: 0 },
    });

    return { ...admin, cuisines, initialPage };
  },
  errorComponent: DiscoveryError,
  component: RestaurantAdmin,
});

const venueListInput = z.object({
  q: z.string().max(200).default(""),
  status: z.enum(["", "draft", "published", "archived"]).default(""),
  business: z.string().max(100).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const businessListInput = z.object({
  q: z.string().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const venueSourcesInput = z.object({
  venueId: z.uuid(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const venuesStatusInput = z.object({
  ids: z.array(z.uuid()).min(1).max(100),
  status: z.enum(["draft", "published", "archived"]),
});

const adminContext = async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server");
  const { requireAuthenticatedActor } = await import("@/server/auth/session");
  const { Actor } = await import("@/server/auth/actor");
  const { withActor } = await import("@/server/auth/current-actor");
  const { runClientOperation } = await import("@/server/http/run-client-operation");
  const session = await runClientOperation(requireAuthenticatedActor(getRequestHeaders()), "admin");

  return { actor: Actor.Member({ userId: session.userId }), withActor, runClientOperation };
};

const venueListFn = createServerFn({ method: "GET" })
  .validator(venueListInput)
  .handler(async ({ data }) => {
    const { listAdminVenues } =
      await import("@/modules/restaurant-discovery/server/operations/admin");

    const { actor, withActor, runClientOperation } = await adminContext();

    return runClientOperation(withActor(actor, listAdminVenues(data)), null);
  });

const businessListFn = createServerFn({ method: "GET" })
  .validator(businessListInput)
  .handler(async ({ data }) => {
    const { listAdminBusinesses } =
      await import("@/modules/restaurant-discovery/server/operations/admin");

    const { actor, withActor, runClientOperation } = await adminContext();

    return runClientOperation(withActor(actor, listAdminBusinesses(data)), null);
  });

const venueSourcesFn = createServerFn({ method: "GET" })
  .validator(venueSourcesInput)
  .handler(async ({ data }) => {
    const { getVenueSources } =
      await import("@/modules/restaurant-discovery/server/operations/admin");

    const { actor, withActor, runClientOperation } = await adminContext();

    return runClientOperation(withActor(actor, getVenueSources(data)), null);
  });

const venuesStatusFn = createServerFn({ method: "POST" })
  .validator(venuesStatusInput)
  .handler(async ({ data }) => {
    const { setVenuesStatus } =
      await import("@/modules/restaurant-discovery/server/operations/admin");

    const { actor, withActor, runClientOperation } = await adminContext();

    return runClientOperation(withActor(actor, setVenuesStatus(data)), null);
  });

const PAGE_SIZE = 20;

type VenuePageRow = Awaited<ReturnType<typeof venueListFn>>["venues"][number];

function toDashboardVenue(row: VenuePageRow): DashboardVenue {
  return {
    id: row.id,
    businessId: row.business_id,
    businessName: row.business_name,
    name: row.name,
    address: row.address,
    area: row.area,
    countryCode: row.country_code,
    status: row.status,
    longitude: row.longitude,
    latitude: row.latitude,
    cuisineIds: row.cuisine_ids.filter((id): id is string => id !== null),
    sourceCount: row.source_count,
    pendingCount: row.pending_count,
    pendingEvidence: row.pending_evidence,
  };
}

function toEditorVenue(venue: DashboardVenue): EditorVenue {
  const status =
    venue.status === "published" || venue.status === "archived" ? venue.status : "draft";

  return {
    id: venue.id,
    businessId: venue.businessId,
    businessName: venue.businessName,
    name: venue.name,
    address: venue.address,
    area: venue.area,
    countryCode: venue.countryCode,
    longitude: venue.longitude,
    latitude: venue.latitude,
    status,
    cuisineIds: venue.cuisineIds,
  };
}

function describeFailure(cause: unknown): string {
  if (cause instanceof Error && cause.message !== "") return cause.message;

  return "The action failed. Retry.";
}

function RestaurantAdmin() {
  const { queue, canReview, cuisines, initialPage } = Route.useLoaderData();
  const router = useRouter();

  const cuisinesById = new Map(
    cuisines.map((row) => [row.id, row.displayName ?? row.slug] as const),
  );

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<VenueStatusFilter>("");
  const [offset, setOffset] = useState(0);

  const [venues, setVenues] = useState<ReadonlyArray<DashboardVenue>>(() =>
    initialPage.venues.map(toDashboardVenue),
  );

  const [total, setTotal] = useState(initialPage.total);
  const [pageBusy, setPageBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [selection, setSelection] = useState<ReadonlyArray<string>>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [editing, setEditing] = useState<EditorVenue | null>(null);
  const [editorError, setEditorError] = useState("");
  const [businessQuery, setBusinessQuery] = useState("");
  const [businesses, setBusinesses] = useState<ReadonlyArray<EditorBusiness>>([]);
  const [sources, setSources] = useState<ReadonlyArray<EditorSource>>([]);
  const [menuVenueId, setMenuVenueId] = useState("");
  const [lastImport, setLastImport] = useState("");

  const queryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (queryTimer.current !== null) clearTimeout(queryTimer.current);
    },
    [],
  );

  const loadPage = useCallback(
    async (nextQuery: string, nextStatus: VenueStatusFilter, nextOffset: number) => {
      setPageBusy(true);

      try {
        const result = await venueListFn({
          data: {
            q: nextQuery,
            status: nextStatus,
            business: "",
            limit: PAGE_SIZE,
            offset: nextOffset,
          },
        });

        setVenues(result.venues.map(toDashboardVenue));
        setTotal(result.total);
      } catch (error) {
        setMessage(describeFailure(error));
      } finally {
        setPageBusy(false);
      }
    },
    [],
  );

  const refresh = useCallback(() => {
    void loadPage(query, status, offset);
    void router.invalidate();
  }, [query, status, offset, loadPage, router]);

  const handleQuery = (next: string) => {
    setQuery(next);

    if (queryTimer.current !== null) clearTimeout(queryTimer.current);

    queryTimer.current = setTimeout(() => {
      setOffset(0);
      void loadPage(next, status, 0);
    }, 250);
  };

  const run = async <A,>(action: () => Promise<A>, success: string): Promise<void> => {
    setBusy(true);
    setMessage("");

    try {
      await action();
      setMessage(success);
      refresh();
    } catch (error) {
      setMessage(describeFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setSources([]);
    setEditorError("");
    setBusinessQuery("");
    setBusinesses([]);
    setEditorKey((key) => key + 1);
    setEditorOpen(true);
  };

  const openEdit = (venue: DashboardVenue) => {
    setEditing(toEditorVenue(venue));
    setSources([]);
    setEditorError("");
    setEditorKey((key) => key + 1);
    setEditorOpen(true);

    venueSourcesFn({ data: { venueId: venue.id, limit: 10 } })
      .then((rows) => {
        setSources(
          rows.map((row) => ({
            id: row.id,
            category: row.category,
            sourceUrl: row.source_url,
            observedAt: row.observed_at,
            validUntil: row.valid_until,
            eligible: row.eligible,
            priceCount: row.price_count,
            pendingPrices: row.pending_prices,
            pendingEvidence: row.pending_evidence,
          })),
        );
      })
      .catch(() => {
        setSources([]);
      });
  };

  const searchBusinesses = (next: string) => {
    setBusinessQuery(next);

    businessListFn({ data: { q: next, limit: 10, offset: 0 } })
      .then((result) => {
        setBusinesses(
          result.businesses.map((row) => ({
            id: row.id,
            name: row.name,
            venueCount: row.venue_count,
          })),
        );
      })
      .catch(() => {
        setBusinesses([]);
      });
  };

  const submitVenue = (input: VenueWriteInput) => {
    setBusy(true);
    setEditorError("");

    writeVenueFn({ data: input })
      .then(() => {
        setEditorOpen(false);
        setMessage("Venue saved. Menu and serving claims still require separate review.");
        refresh();
      })
      .catch((cause: unknown) => {
        setEditorError(describeFailure(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const bulkStatus = (nextStatus: "draft" | "published" | "archived") => {
    void run(
      async () => {
        const result = await venuesStatusFn({ data: { ids: [...selection], status: nextStatus } });
        setSelection([]);

        return result;
      },
      `${nextStatus === "published" ? "Published" : "Archived"} ${selection.length} branches.`,
    );
  };

  const template = JSON.stringify(
    {
      venueId: menuVenueId,
      menuName: "",
      source: {
        category: "official_menu",
        url: "",
        deduplicationKey: "",
        restaurantVerified: false,
        observedAt: "",
        validUntil: "",
      },
      items: [{ name: "", variants: [{ name: "As listed" }] }],
    },
    null,
    2,
  );

  const importSource = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const raw = z.string().safeParse(new FormData(event.currentTarget).get("payload"));

    if (!raw.success) {
      setMessage("Enter a JSON menu payload.");

      return;
    }

    let parsed;

    try {
      parsed = menuImportSchema.safeParse(JSON.parse(raw.data));
    } catch {
      setMessage("Enter valid JSON in the documented menu format.");

      return;
    }

    if (!parsed.success) {
      setMessage(parsed.error.issues.map((issue) => issue.message).join(". "));

      return;
    }

    void run(async () => {
      const result = await importMenuFn({ data: parsed.data });
      setLastImport(JSON.stringify(result, null, 2));
      setMenuVenueId(parsed.data.venueId);

      return result;
    }, "Source imported transactionally. Prices and dish matches are pending review below.");
  };

  return (
    <section className="discovery-page" lang="en">
      <header>
        <p className="discovery-eyebrow">Editorial workspace</p>
        <h1>Restaurants & menus</h1>
        <p>
          Record real branches and source observations. Imported prices and serving matches remain
          pending until reviewed.
        </p>
      </header>

      <RestaurantDashboard
        venues={venues}
        total={total}
        query={query}
        status={status}
        offset={offset}
        busy={busy || pageBusy}
        actionMessage={message}
        selection={selection}
        cuisinesById={cuisinesById}
        onQuery={handleQuery}
        onStatus={(next) => {
          setStatus(next);
          setOffset(0);
          void loadPage(query, next, 0);
        }}
        onOffset={(next) => {
          setOffset(next);
          void loadPage(query, status, next);
        }}
        onToggleSelect={(id) => {
          if (selection.includes(id)) {
            setSelection(selection.filter((entry) => entry !== id));
          } else {
            setSelection([...selection, id]);
          }
        }}
        onToggleSelectPage={() => {
          const pageIds = venues.map((venue) => venue.id);
          const allSelected = pageIds.every((id) => selection.includes(id));

          if (allSelected) {
            setSelection(selection.filter((id) => !pageIds.includes(id)));
          } else {
            setSelection([...new Set([...selection, ...pageIds])]);
          }
        }}
        onCreate={openCreate}
        onEdit={openEdit}
        onManageMenus={(venue) => {
          setMenuVenueId(venue.id);
          document.getElementById("menu-management")?.scrollIntoView({ behavior: "smooth" });
        }}
        onBulkArchive={() => bulkStatus("archived")}
        onBulkPublish={() => bulkStatus("published")}
      />

      <RestaurantEditor
        key={editorKey}
        open={editorOpen}
        venue={editing}
        businesses={businesses}
        businessQuery={businessQuery}
        cuisines={cuisines}
        sources={sources}
        busy={busy}
        error={editorError}
        canPublish={canReview}
        onSearchBusinesses={searchBusinesses}
        onSubmit={submitVenue}
        onClose={() => setEditorOpen(false)}
      />

      <section id="menu-management">
        <h2>Official menu entry / structured import</h2>
        <p className="my-3 text-sm text-muted">
          Supply source URL or private object reference, a stable snapshot deduplication key, actual
          observation date and review horizon. Add exact decimal strings to variant price fields.
          Reuse menuId, itemId and variantId to append a new price observation to an existing
          offering. No OCR or public file upload is performed here.
        </p>
        <form className="grid gap-3" onSubmit={importSource}>
          <label htmlFor="menu-payload">Menu JSON (required fields start blank)</label>
          <textarea
            key={menuVenueId}
            id="menu-payload"
            name="payload"
            rows={18}
            defaultValue={template}
            spellCheck={false}
            required
            className="font-mono text-sm"
          />
          <button type="submit" disabled={busy || menuVenueId === ""}>
            Import pending observations
          </button>
        </form>
        {menuVenueId !== "" && (
          <details className="mt-4">
            <summary className="cursor-pointer font-semibold">Price field reference</summary>
            <pre className="overflow-x-auto rounded-lg bg-white p-4 text-xs">
              {JSON.stringify(
                {
                  name: "As listed",
                  comparisonKey: "regular-bowl",
                  price: {
                    amount: "",
                    currency: "",
                    kind: "listed",
                    channel: "dine_in",
                    taxTreatment: "unknown",
                    sourceLineKey: "",
                  },
                },
                null,
                2,
              )}
            </pre>
            <p className="text-sm">
              For serving evidence, add the canonical dishId and matchKind (exact, variant or
              suggestion) to an item. Suggestions cannot be approved.
            </p>
          </details>
        )}
      </section>
      {lastImport !== "" && (
        <details open>
          <summary>Imported record IDs (retain for later observations)</summary>
          <pre className="overflow-x-auto bg-white p-4 text-xs">{lastImport}</pre>
        </details>
      )}
      <section>
        <h2>Menu visibility</h2>
        <form
          className="discovery-search-bar"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);

            const parsed = menuStatusSchema.safeParse({
              menuId: form.get("menuId"),
              status: "archived",
            });

            if (parsed.success)
              void run(
                () => setMenuStatusFn({ data: parsed.data }),
                "Menu archived. Historical observations are retained.",
              );
            else setMessage("Enter a valid menu ID.");
          }}
        >
          <label htmlFor="archive-menu">Menu ID to archive</label>
          <input id="archive-menu" name="menuId" required />
          <button type="submit" disabled={busy}>
            Archive menu
          </button>
        </form>
      </section>
      <ContributionReview canReview={canReview} />
      <section>
        <h2>Observation review and history</h2>
        <form
          className="restaurant-filters"
          onSubmit={(event) => {
            event.preventDefault();

            const parsed = offeringStatusSchema.safeParse(
              Object.fromEntries(new FormData(event.currentTarget)),
            );

            if (!parsed.success) {
              setMessage("Choose an offering type and valid item/variant ID.");

              return;
            }

            void run(
              () => setOfferingStatusFn({ data: parsed.data }),
              "Offering visibility updated; its price history is retained.",
            );
          }}
        >
          <div>
            <label htmlFor="offering-kind">Offering type</label>
            <select id="offering-kind" name="kind">
              <option value="item">Menu item</option>
              <option value="variant">Variant</option>
            </select>
          </div>
          <div>
            <label htmlFor="offering-id">Item / variant ID</label>
            <input id="offering-id" name="id" required />
          </div>
          <div>
            <label htmlFor="offering-status">Visibility</label>
            <select id="offering-status" name="status">
              <option value="archived">Archived</option>
              <option value="published">Published</option>
            </select>
          </div>
          <button type="submit" disabled={busy}>
            Update offering
          </button>
        </form>
        <p className="my-3 text-sm text-muted">
          Review source, branch, portion, channel, tax treatment and observation date. Conflicting
          records stay in history; an approval never deletes an earlier price. Showing the latest
          200 observations.
        </p>
        <ul className="grid gap-3">
          {queue.map((entry) => (
            <li key={`${entry.kind}:${entry.id}`} className="discovery-card">
              <h3>
                {entry.venue} · {entry.item}
                {entry.variant !== null && ` · ${entry.variant}`}
              </h3>
              <p>
                {entry.kind} · {entry.detail} · {entry.amount} {entry.currency} ·{" "}
                {entry.review_status}
              </p>
              <p className="text-sm">
                {entry.source_category} · restaurant verified: {String(entry.restaurant_verified)} ·
                observed {entry.observed_at.slice(0, 10)} · review after{" "}
                {entry.review_after.slice(0, 10)}
              </p>
              <p className="text-sm">
                {entry.sales_channel} · tax {entry.tax_treatment}
                {entry.quantity !== null &&
                  ` · receipt quantity ${entry.quantity}, explicit paid unit ${entry.explicit_unit_price}, line total ${entry.line_total}, discount ${entry.discount}, taxes/fees ${entry.taxes_fees}, ${entry.total_semantics}`}
              </p>
              {entry.source_url !== null && (
                <a href={entry.source_url} target="_blank" rel="noreferrer">
                  Review source
                </a>
              )}
              {canReview && (
                <div className="discovery-card-actions">
                  <button
                    type="button"
                    disabled={busy || entry.detail.startsWith("suggestion")}
                    onClick={() =>
                      void run(
                        () =>
                          reviewRestaurantFn({
                            data: {
                              id: entry.id,
                              kind: entry.kind === "price" ? "price" : "serving",
                              status: "approved",
                            },
                          }),
                        "Observation approved.",
                      )
                    }
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () =>
                          reviewRestaurantFn({
                            data: {
                              id: entry.id,
                              kind: entry.kind === "price" ? "price" : "serving",
                              status: "rejected",
                            },
                          }),
                        "Observation rejected.",
                      )
                    }
                  >
                    Reject
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
