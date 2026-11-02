import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod";

import { AdminSelect } from "@/components/admin/select";
import {
  AdminField,
  AdminGhostButton,
  AdminPageHeading,
  AdminPrimaryButton,
  AdminSection,
} from "@/components/admin/ui";
import { ContributionReview } from "@/modules/restaurant-discovery/components/contribution-review";
import { DiscoveryError } from "@/modules/restaurant-discovery/components/discovery-error";
import {
  RestaurantDashboard,
  type DashboardTab,
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
import type { RestaurantPhotoManagerClient } from "@/modules/restaurant-discovery/components/restaurant-photo-manager";
import {
  RestaurantReviewModeration,
  type CustomerReviewModerationClient,
  type ModerationDecisionResult,
} from "@/modules/restaurant-discovery/components/restaurant-review-moderation";
import {
  deletePhoto,
  listPhotoReviewQueue,
  listVenuePhotos,
  previewPhoto,
  publishPhoto,
  reorderPhotos,
  stageVenuePhoto,
  submitPhotoForReview,
  updatePhotoMetadata,
  withdrawPhoto,
} from "@/modules/restaurant-discovery/restaurant-photos.functions";
import {
  listCustomerReviewQueueFn,
  moderateRestaurantCustomerReviewFn,
} from "@/modules/restaurant-discovery/restaurant-reviews.functions";
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

/**
 * Blob URLs minted by previewPhoto, keyed by photo id. The manager drops
 * URLs on query invalidation without revoking them, so the adapter revokes
 * the previous URL for a photo before minting a new one. Entries are
 * removed on delete to keep the map bounded.
 */
const previewUrlsByPhoto = new Map<string, string>();

/**
 * Staff photo adapter: every call hits the real `restaurant:manage` /
 * `restaurant:review`-gated photo endpoints. The edited venue supplies the
 * display name (admin rows carry no venue name); description stays null
 * until stored; block reasons start empty and accumulate on failed publish.
 */
const restaurantPhotoManagerClient: RestaurantPhotoManagerClient = {
  listVenuePhotos: async (input) => {
    const rows = await listVenuePhotos({ data: { venueId: input.venueId } });

    return rows.map((row) => ({
      id: row.id,
      venueId: row.venueId,
      venueName: null,
      status: row.status,
      sortOrder: row.sortOrder,
      isPrimary: row.isPrimary,
      altText: row.altText,
      attribution: row.attribution,
      description: null,
      license: row.license,
      focalX: row.focalX,
      focalY: row.focalY,
      sourceUrl: row.sourceUrl,
      deliveryUrl: row.deliveryUrl,
      previewUrl: row.previewUrl,
      processing: row.processing,
      blockReasons: [],
    }));
  },
  listPhotoReviewQueue: async (input) => {
    const rows = await listPhotoReviewQueue({
      data: { limit: input.limit, offset: input.offset },
    });

    return rows.map((row) => ({
      id: row.id,
      venueId: row.venueId,
      venueName: null,
      status: row.status,
      sortOrder: row.sortOrder,
      isPrimary: row.isPrimary,
      altText: row.altText,
      attribution: row.attribution,
      description: null,
      license: row.license,
      focalX: row.focalX,
      focalY: row.focalY,
      sourceUrl: row.sourceUrl,
      deliveryUrl: row.deliveryUrl,
      previewUrl: row.previewUrl,
      processing: row.processing,
      blockReasons: [],
    }));
  },
  stageVenuePhoto: async (input) => {
    const form = new FormData();

    form.set("venueId", input.venueId);
    form.set("file", input.file);

    const optionalText: ReadonlyArray<readonly [string, string | null]> = [
      ["altText", input.altText],
      ["attribution", input.attribution],
      ["license", input.license === "" ? null : input.license],
      ["sourceUrl", input.sourceUrl],
      ["focalX", input.focalX === null ? null : String(input.focalX)],
      ["focalY", input.focalY === null ? null : String(input.focalY)],
    ];

    for (const [key, value] of optionalText) {
      if (value !== null) form.set(key, value);
    }

    form.set("makePrimary", input.makePrimary ? "true" : "false");

    const row = await stageVenuePhoto({ data: form });

    return {
      id: row.id,
      venueId: row.venueId,
      venueName: null,
      status: row.status,
      sortOrder: row.sortOrder,
      isPrimary: row.isPrimary,
      altText: row.altText,
      attribution: row.attribution,
      description: null,
      license: row.license,
      focalX: row.focalX,
      focalY: row.focalY,
      sourceUrl: row.sourceUrl,
      deliveryUrl: row.deliveryUrl,
      previewUrl: row.previewUrl,
      processing: row.processing,
      blockReasons: [],
    };
  },
  updatePhotoMetadata: async (input) => {
    if (
      input.license !== "own-work" &&
      input.license !== "cc0" &&
      input.license !== "cc-by" &&
      input.license !== "cc-by-sa" &&
      input.license !== "licensed" &&
      input.license !== "unknown"
    ) {
      throw new Error("Unsupported license. Choose a supported license.");
    }

    const row = await updatePhotoMetadata({
      data: {
        photoId: input.photoId,
        altText: input.altText,
        attribution: input.attribution,
        license: input.license,
        focalX: input.focalX,
        focalY: input.focalY,
        sourceUrl: input.sourceUrl,
      },
    });

    return {
      id: row.id,
      venueId: row.venueId,
      venueName: null,
      status: row.status,
      sortOrder: row.sortOrder,
      isPrimary: row.isPrimary,
      altText: row.altText,
      attribution: row.attribution,
      description: null,
      license: row.license,
      focalX: row.focalX,
      focalY: row.focalY,
      sourceUrl: row.sourceUrl,
      deliveryUrl: row.deliveryUrl,
      previewUrl: row.previewUrl,
      processing: row.processing,
      blockReasons: [],
    };
  },
  reorderPhotos: async (input) => {
    const rows = await reorderPhotos({
      data: { venueId: input.venueId, orderedIds: [...input.orderedIds] },
    });

    return rows.map((row) => ({
      id: row.id,
      venueId: row.venueId,
      venueName: null,
      status: row.status,
      sortOrder: row.sortOrder,
      isPrimary: row.isPrimary,
      altText: row.altText,
      attribution: row.attribution,
      description: null,
      license: row.license,
      focalX: row.focalX,
      focalY: row.focalY,
      sourceUrl: row.sourceUrl,
      deliveryUrl: row.deliveryUrl,
      previewUrl: row.previewUrl,
      processing: row.processing,
      blockReasons: [],
    }));
  },
  submitPhotoForReview: async (input) => {
    const row = await submitPhotoForReview({ data: { photoId: input.photoId } });

    return {
      id: row.id,
      venueId: row.venueId,
      venueName: null,
      status: row.status,
      sortOrder: row.sortOrder,
      isPrimary: row.isPrimary,
      altText: row.altText,
      attribution: row.attribution,
      description: null,
      license: row.license,
      focalX: row.focalX,
      focalY: row.focalY,
      sourceUrl: row.sourceUrl,
      deliveryUrl: row.deliveryUrl,
      previewUrl: row.previewUrl,
      processing: row.processing,
      blockReasons: [],
    };
  },
  publishPhoto: async (input) => {
    const row = await publishPhoto({ data: { photoId: input.photoId } });

    return {
      id: row.id,
      venueId: row.venueId,
      venueName: null,
      status: row.status,
      sortOrder: row.sortOrder,
      isPrimary: row.isPrimary,
      altText: row.altText,
      attribution: row.attribution,
      description: null,
      license: row.license,
      focalX: row.focalX,
      focalY: row.focalY,
      sourceUrl: row.sourceUrl,
      deliveryUrl: row.deliveryUrl,
      previewUrl: row.previewUrl,
      processing: row.processing,
      blockReasons: [],
    };
  },
  withdrawPhoto: async (input) => {
    const row = await withdrawPhoto({ data: { photoId: input.photoId } });

    return {
      id: row.id,
      venueId: row.venueId,
      venueName: null,
      status: row.status,
      sortOrder: row.sortOrder,
      isPrimary: row.isPrimary,
      altText: row.altText,
      attribution: row.attribution,
      description: null,
      license: row.license,
      focalX: row.focalX,
      focalY: row.focalY,
      sourceUrl: row.sourceUrl,
      deliveryUrl: row.deliveryUrl,
      previewUrl: row.previewUrl,
      processing: row.processing,
      blockReasons: [],
    };
  },
  deletePhoto: async (input) => {
    const removed = await deletePhoto({ data: { photoId: input.photoId } });
    const previous = previewUrlsByPhoto.get(input.photoId);

    if (previous !== undefined) {
      URL.revokeObjectURL(previous);
      previewUrlsByPhoto.delete(input.photoId);
    }

    return { id: removed.id, venueId: removed.venueId };
  },
  previewPhoto: async (input) => {
    const response = await previewPhoto({ data: { photoId: input.photoId } });
    const blob = await response.blob();
    const previous = previewUrlsByPhoto.get(input.photoId);

    if (previous !== undefined) URL.revokeObjectURL(previous);

    const url = URL.createObjectURL(blob);

    previewUrlsByPhoto.set(input.photoId, url);

    return url;
  },
};

function describeFailure(cause: unknown): string {
  if (cause instanceof Error && cause.message !== "") return cause.message;

  return "The action failed. Retry.";
}

/**
 * Staff adapter: decisions and queue reads both call the real
 * `restaurant:review`-gated endpoints. The queue shows pending-first
 * traveler reviews across venues; members without the grant never reach
 * data (server enforcement + `canReview` gate on the component).
 */
const customerReviewModerationClient: CustomerReviewModerationClient = {
  loadQueue: async (query) => {
    const page = await listCustomerReviewQueueFn({
      data: {
        venue: query.venue,
        status: query.status,
        limit: query.limit,
        offset: query.offset,
      },
    });

    return {
      items: page.items.map((entry) => ({
        id: entry.id,
        venueId: entry.venue_id,
        venueName: entry.venue_name,
        rating: entry.rating,
        body: entry.body,
        status: entry.status,
        submittedAt: entry.submitted_at,
      })),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      pendingCount: page.pending_count,
    };
  },
  decide: async (input): Promise<ModerationDecisionResult> => {
    const outcome: unknown = await moderateRestaurantCustomerReviewFn({
      data: { reviewId: input.reviewId, status: input.status },
    });

    const repeated = z.object({ _tag: z.literal("Repeated") }).safeParse(outcome).success;

    return {
      reviewId: input.reviewId,
      status: input.status,
      repeated,
    };
  },
};

function scrollToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DashboardTab>("overview");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [editing, setEditing] = useState<EditorVenue | null>(null);
  const [editorError, setEditorError] = useState("");
  const [businessQuery, setBusinessQuery] = useState("");
  const [businesses, setBusinesses] = useState<ReadonlyArray<EditorBusiness>>([]);
  const [sources, setSources] = useState<ReadonlyArray<EditorSource>>([]);
  const [menuVenueId, setMenuVenueId] = useState("");
  const [lastImport, setLastImport] = useState("");
  const [offeringKind, setOfferingKind] = useState("item");
  const [offeringId, setOfferingId] = useState("");
  const [offeringVisibility, setOfferingVisibility] = useState("archived");

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

  // Detail selection is state-only (no URL mutation) so browser back and
  // deep-link behavior stay exactly as before. The manage grant was verified
  // server-side by the loader; every mutation re-verified per operation.
  const selectedVenue = venues.find((venue) => venue.id === selectedId) ?? null;

  const handleSelectVenue = (venue: DashboardVenue | null) => {
    setSelectedId(venue?.id ?? null);

    if (venue !== null) setActiveTab("overview");
  };

  // Menu and Reviews tabs scroll to their existing workflow sections.
  // Overview, Photos, and Sources render inline with buttons that open the
  // existing editor — no new components, no navigation change.
  const handleTabChange = (tab: DashboardTab) => {
    setActiveTab(tab);

    if (selectedVenue === null) return;

    if (tab === "menu") {
      setMenuVenueId(selectedVenue.id);
      scrollToSection("menu-management");
    }

    if (tab === "reviews") scrollToSection("customer-reviews");
  };

  const handleManagePhotos = (venue: DashboardVenue) => {
    openEdit(venue);
  };

  const handleArchive = (venue: DashboardVenue) => {
    if (venue.status === "archived") {
      setMessage("Branch is already archived.");

      return;
    }

    void run(
      async () => venuesStatusFn({ data: { ids: [venue.id], status: "archived" } }),
      `Archived ${venue.name}. Historical observations are retained.`,
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
    <div className="flex flex-col gap-4" lang="en">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1 text-sm text-muted">
          <li>Admin</li>
          <li aria-hidden="true">/</li>
          {selectedVenue === null ? (
            <li aria-current="page" className="font-semibold text-ink">
              Restaurants
            </li>
          ) : (
            <>
              <li className="font-semibold text-ink">Restaurants</li>
              <li aria-hidden="true">/</li>
              <li aria-current="page" className="font-semibold text-ink">
                {selectedVenue.name}
              </li>
            </>
          )}
        </ol>
      </nav>
      <AdminPageHeading
        title="Restaurants"
        description="Record real branches and source observations. Imported prices and serving matches remain pending until reviewed."
      />

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
        onManagePhotos={handleManagePhotos}
        onArchive={handleArchive}
        canEdit
        canArchive
        selectedId={selectedId}
        activeTab={activeTab}
        onSelectVenue={handleSelectVenue}
        onTabChange={handleTabChange}
        renderTabPanel={(venue, tab) => {
          if (tab === "overview") {
            const cuisineNames = venue.cuisineIds.map((id) => cuisinesById.get(id) ?? `#${id}`);

            return (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="font-semibold">Branch</dt>
                  <dd>{venue.name}</dd>
                </div>
                <div>
                  <dt className="font-semibold">Business</dt>
                  <dd>{venue.businessName}</dd>
                </div>
                <div>
                  <dt className="font-semibold">Address</dt>
                  <dd>
                    {venue.address} · {venue.area} · {venue.countryCode}
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold">Cuisines</dt>
                  <dd>{cuisineNames.length === 0 ? "—" : cuisineNames.join(", ")}</dd>
                </div>
                <div>
                  <dt className="font-semibold">Sources</dt>
                  <dd>
                    {venue.sourceCount} {venue.sourceCount === 1 ? "source" : "sources"} ·{" "}
                    {venue.pendingCount + venue.pendingEvidence} pending
                  </dd>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <AdminGhostButton type="button" onClick={() => openEdit(venue)}>
                    Edit details
                  </AdminGhostButton>
                </div>
              </dl>
            );
          }

          if (tab === "menu") {
            return (
              <div className="flex flex-col gap-2 text-sm">
                <p>
                  Official menu entry and structured imports stay in this workflow below. Prices and
                  serving matches remain pending until reviewed.
                </p>
                <div>
                  <AdminGhostButton
                    type="button"
                    onClick={() => {
                      setMenuVenueId(venue.id);
                      scrollToSection("menu-management");
                    }}
                  >
                    Open menu management
                  </AdminGhostButton>
                </div>
              </div>
            );
          }

          if (tab === "photos") {
            return (
              <div className="flex flex-col gap-2 text-sm">
                <p>Venue photos are managed in the existing branch editor.</p>
                <div>
                  <AdminGhostButton type="button" onClick={() => openEdit(venue)}>
                    Open photo editor
                  </AdminGhostButton>
                </div>
              </div>
            );
          }

          if (tab === "reviews") {
            return (
              <div className="flex flex-col gap-2 text-sm">
                <p>
                  Traveler-authored reviews are moderated in the customer reviews section below.
                  Decisions only publish, reject, or remove whole reviews.
                </p>
                <div>
                  <AdminGhostButton
                    type="button"
                    onClick={() => scrollToSection("customer-reviews")}
                  >
                    Open customer reviews
                  </AdminGhostButton>
                </div>
              </div>
            );
          }

          return (
            <div className="flex flex-col gap-2 text-sm">
              <p>
                Source observations and attribution live in the existing branch editor. Imports are
                added in menu management below.
              </p>
              <div>
                <AdminGhostButton type="button" onClick={() => openEdit(venue)}>
                  Open sources in editor
                </AdminGhostButton>
              </div>
            </div>
          );
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
        photoClient={restaurantPhotoManagerClient}
        canManagePhotos
      />

      <div id="menu-management">
        <AdminSection title="Official menu entry / structured import">
          <p className="text-sm text-muted">
            Supply source URL or private object reference, a stable snapshot deduplication key,
            actual observation date and review horizon. Add exact decimal strings to variant price
            fields. Reuse menuId, itemId and variantId to append a new price observation to an
            existing offering. No OCR or public file upload is performed here.
          </p>
          <form className="mt-3 grid gap-3" onSubmit={importSource}>
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor="menu-payload" className="text-sm font-semibold">
                Menu JSON (required fields start blank)
              </label>
              <textarea
                key={menuVenueId}
                id="menu-payload"
                name="payload"
                rows={18}
                defaultValue={template}
                spellCheck={false}
                required
                className="min-h-11 rounded-lg border border-border-soft bg-white px-3 py-2 font-mono text-sm text-ink"
              />
            </div>
            <div>
              <AdminPrimaryButton type="submit" disabled={busy || menuVenueId === ""}>
                Import pending observations
              </AdminPrimaryButton>
            </div>
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
        </AdminSection>
      </div>
      {lastImport !== "" && (
        <details open>
          <summary>Imported record IDs (retain for later observations)</summary>
          <pre className="overflow-x-auto bg-white p-4 text-xs">{lastImport}</pre>
        </details>
      )}
      <AdminSection title="Menu visibility">
        <form
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
          <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <AdminField id="archive-menu" name="menuId" label="Menu ID to archive" required />
            <AdminPrimaryButton type="submit" disabled={busy}>
              Archive menu
            </AdminPrimaryButton>
          </div>
        </form>
      </AdminSection>
      <ContributionReview canReview={canReview} />
      <AdminSection title="Observation review and history">
        <form
          onSubmit={(event) => {
            event.preventDefault();

            const parsed = offeringStatusSchema.safeParse({
              kind: offeringKind,
              id: offeringId,
              status: offeringVisibility,
            });

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
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-[12rem_minmax(0,1fr)_12rem_auto] md:items-end">
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor="offering-kind" className="text-sm font-semibold">
                Offering type
              </label>
              <AdminSelect
                id="offering-kind"
                value={offeringKind}
                onValueChange={setOfferingKind}
                options={[
                  { label: "Menu item", value: "item" },
                  { label: "Variant", value: "variant" },
                ]}
              />
            </div>
            <AdminField
              id="offering-id"
              name="id"
              label="Item / variant ID"
              value={offeringId}
              onChange={(event) => setOfferingId(event.target.value)}
              required
            />
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor="offering-status" className="text-sm font-semibold">
                Visibility
              </label>
              <AdminSelect
                id="offering-status"
                value={offeringVisibility}
                onValueChange={setOfferingVisibility}
                options={[
                  { label: "Archived", value: "archived" },
                  { label: "Published", value: "published" },
                ]}
              />
            </div>
            <AdminPrimaryButton type="submit" disabled={busy}>
              Update offering
            </AdminPrimaryButton>
          </div>
        </form>
        <p className="my-3 text-sm text-muted">
          Review source, branch, portion, channel, tax treatment and observation date. Conflicting
          records stay in history; an approval never deletes an earlier price. Showing the latest
          200 observations.
        </p>
        <ul className="grid gap-3">
          {queue.map((entry) => (
            <li
              key={`${entry.kind}:${entry.id}`}
              className="rounded-2xl border border-border-soft bg-white p-4"
            >
              <h3 className="font-semibold">
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
                <div className="mt-3 flex flex-wrap gap-2">
                  <AdminPrimaryButton
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
                  </AdminPrimaryButton>
                  <AdminGhostButton
                    type="button"
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
                  </AdminGhostButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      </AdminSection>
      <div id="customer-reviews" className="scroll-mt-4">
        <AdminSection title="Customer reviews">
          <p className="mb-3 text-sm text-muted">
            Traveler-authored reviews. Separate from menu, price, serving, and scan queues:
            decisions here only publish, reject, or remove whole reviews. Review text is never
            edited.
          </p>
          <RestaurantReviewModeration
            canReview={canReview}
            client={customerReviewModerationClient}
          />
        </AdminSection>
      </div>
    </div>
  );
}
