import { useCallback, useState } from "react";
import Map, { Marker, NavigationControl } from "react-map-gl/maplibre";
import { z } from "zod";

import {
  AdminDialog,
  AdminField,
  AdminGhostButton,
  AdminPrimaryButton,
  AdminSecondaryButton,
} from "@/components/admin/ui";
import { requestUserPosition } from "@/modules/restaurant-discovery/location-storage";
import { DEFAULT_MAP_CENTER } from "@/modules/restaurant-discovery/map-bounds";
import { venueWriteSchema } from "@/modules/restaurant-discovery/restaurant.schema";

export interface EditorVenue {
  readonly id: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly name: string;
  readonly address: string;
  readonly area: string;
  readonly countryCode: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly status: "draft" | "published" | "archived";
  readonly cuisineIds: ReadonlyArray<string>;
}

export interface EditorBusiness {
  readonly id: string;
  readonly name: string;
  readonly venueCount: number;
}

export interface EditorCuisine {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string | undefined;
}

export interface EditorSource {
  readonly id: string;
  readonly category: string;
  readonly sourceUrl: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly eligible: boolean;
  readonly priceCount: number;
  readonly pendingPrices: number;
  readonly pendingEvidence: number;
}

export type VenueWriteInput = z.infer<typeof venueWriteSchema>;

function statusLabel(status: EditorVenue["status"]): string {
  if (status === "published") return "Published";

  if (status === "archived") return "Archived";

  return "Draft";
}

function CoordinatePicker({
  longitude,
  latitude,
  onPick,
}: {
  readonly longitude: number;
  readonly latitude: number;
  readonly onPick: (longitude: number, latitude: number) => void;
}) {
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState("");

  const useMyLocation = useCallback(() => {
    setLocating(true);
    setGeoError("");
    requestUserPosition()
      .then((position) => {
        onPick(position.longitude, position.latitude);
      })
      .catch(() => {
        setGeoError("Could not read your location. Drag the pin instead.");
      })
      .finally(() => {
        setLocating(false);
      });
  }, [onPick]);

  const style = z.url().safeParse(import.meta.env.VITE_MAP_STYLE_URL);

  if (!style.success) {
    return (
      <p className="text-sm text-muted" aria-live="polite">
        Map tiles are not configured here. Enter the branch address, then refine the pin with your
        device location.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        className="h-64 overflow-hidden rounded-xl border border-border-soft"
        aria-label="Branch location picker"
      >
        <Map
          mapLib={import("maplibre-gl")}
          mapStyle={style.data}
          initialViewState={{ longitude, latitude, zoom: 14 }}
          attributionControl={{ compact: true }}
          onClick={(event) => {
            onPick(event.lngLat.lng, event.lngLat.lat);
          }}
        >
          <NavigationControl position="top-right" />
          <Marker
            longitude={longitude}
            latitude={latitude}
            draggable
            onDragEnd={(event) => {
              onPick(event.lngLat.lng, event.lngLat.lat);
            }}
          />
        </Map>
      </div>
      <p className="text-sm text-muted" aria-live="polite">
        Pin: {latitude.toFixed(5)}, {longitude.toFixed(5)}. Click the map or drag the pin; no typed
        coordinates needed.
      </p>
      <div>
        <AdminGhostButton type="button" disabled={locating} onClick={useMyLocation}>
          {locating ? "Locating…" : "Use my location"}
        </AdminGhostButton>
      </div>
      {geoError !== "" && (
        <p role="alert" className="text-sm font-semibold text-red-800">
          {geoError}
        </p>
      )}
    </div>
  );
}

export function RestaurantEditor({
  open,
  venue,
  businesses,
  businessQuery,
  cuisines,
  sources,
  busy,
  error,
  canPublish,
  onSearchBusinesses,
  onSubmit,
  onClose,
}: {
  readonly open: boolean;
  readonly venue: EditorVenue | null;
  readonly businesses: ReadonlyArray<EditorBusiness>;
  readonly businessQuery: string;
  readonly cuisines: ReadonlyArray<EditorCuisine>;
  readonly sources: ReadonlyArray<EditorSource>;
  readonly busy: boolean;
  readonly error: string;
  readonly canPublish: boolean;
  readonly onSearchBusinesses: (query: string) => void;
  readonly onSubmit: (input: VenueWriteInput) => void;
  readonly onClose: () => void;
}) {
  const editing = venue !== null;

  const [businessMode, setBusinessMode] = useState<"existing" | "new">(
    editing ? "existing" : "new",
  );

  const [businessId, setBusinessId] = useState(venue?.businessId ?? "");
  const [businessName, setBusinessName] = useState(venue?.businessName ?? "");
  const [name, setName] = useState(venue?.name ?? "");
  const [address, setAddress] = useState(venue?.address ?? "");
  const [area, setArea] = useState(venue?.area ?? "");
  const [countryCode, setCountryCode] = useState(venue?.countryCode ?? "VN");
  const [longitude, setLongitude] = useState(venue?.longitude ?? DEFAULT_MAP_CENTER.longitude);
  const [latitude, setLatitude] = useState(venue?.latitude ?? DEFAULT_MAP_CENTER.latitude);
  const [status, setStatus] = useState<EditorVenue["status"]>(venue?.status ?? "draft");
  const [cuisineIds, setCuisineIds] = useState<ReadonlyArray<string>>(venue?.cuisineIds ?? []);
  const [formError, setFormError] = useState("");

  const toggleCuisine = (id: string) => {
    if (cuisineIds.includes(id)) {
      setCuisineIds(cuisineIds.filter((entry) => entry !== id));
    } else if (cuisineIds.length < 20) {
      setCuisineIds([...cuisineIds, id]);
    }
  };

  const save = (nextStatus: EditorVenue["status"]) => {
    const trimmedBusiness = businessName.trim();

    const parsed = venueWriteSchema.safeParse({
      venueId: venue?.id,
      businessId: editing || businessMode === "existing" ? businessId || undefined : undefined,
      businessName:
        trimmedBusiness === "" && businessMode === "existing"
          ? (venue?.businessName ?? "")
          : businessName,
      name,
      address,
      area,
      countryCode: countryCode.toUpperCase(),
      longitude,
      latitude,
      status: nextStatus,
      cuisineIds,
    });

    if (!parsed.success) {
      setFormError(parsed.error.issues.map((issue) => issue.message).join(". "));

      return;
    }

    if (parsed.data.businessId === undefined && businessMode === "existing" && !editing) {
      setFormError("Choose an existing business or switch to a new business name.");

      return;
    }

    onSubmit(parsed.data);
  };

  const shownError = formError !== "" ? formError : error;
  const dialogTitle = venue !== null ? `Edit branch · ${venue.name}` : "Add a branch";

  return (
    <AdminDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={dialogTitle}
      description={
        editing
          ? "Branch edits stay on this business. Renaming the business renames it for every branch in the same save."
          : "Create a new branch under an existing business, or start a new business."
      }
      closeLabel="Cancel venue edit"
    >
      <div className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold">Business (shared across branches)</legend>
          {editing ? (
            <AdminField
              id="venue-business-name"
              label="Business name (renames every branch of this business)"
              value={businessName}
              maxLength={300}
              required
              disabled={busy}
              onChange={(event) => setBusinessName(event.target.value)}
            />
          ) : (
            <>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="business-mode"
                    checked={businessMode === "existing"}
                    onChange={() => setBusinessMode("existing")}
                  />
                  Existing business
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="business-mode"
                    checked={businessMode === "new"}
                    onChange={() => setBusinessMode("new")}
                  />
                  New business
                </label>
              </div>
              {businessMode === "existing" ? (
                <div className="flex flex-col gap-2">
                  <AdminField
                    id="venue-business-search"
                    label="Search businesses"
                    value={businessQuery}
                    placeholder="Start typing a business name…"
                    disabled={busy}
                    onChange={(event) => onSearchBusinesses(event.target.value)}
                  />
                  <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                    {businesses.map((business) => (
                      <li key={business.id}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setBusinessId(business.id);
                            setBusinessName(business.name);
                          }}
                          aria-pressed={businessId === business.id}
                          className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                            businessId === business.id
                              ? "border-brand-blue bg-brand-blue/10 font-semibold"
                              : "border-border-soft bg-white"
                          }`}
                        >
                          {business.name} · {business.venueCount}{" "}
                          {business.venueCount === 1 ? "branch" : "branches"}
                        </button>
                      </li>
                    ))}
                    {businesses.length === 0 && (
                      <li className="text-sm text-muted">No matching business found.</li>
                    )}
                  </ul>
                </div>
              ) : (
                <AdminField
                  id="venue-business-name"
                  label="New business name"
                  value={businessName}
                  maxLength={300}
                  required
                  disabled={busy}
                  onChange={(event) => setBusinessName(event.target.value)}
                />
              )}
            </>
          )}
        </fieldset>

        <AdminField
          id="venue-branch-name"
          label="Branch display name"
          value={name}
          maxLength={300}
          required
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <AdminField
          id="venue-address"
          label="Street address"
          value={address}
          maxLength={1000}
          required
          disabled={busy}
          onChange={(event) => setAddress(event.target.value)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <AdminField
            id="venue-area"
            label="City / area"
            value={area}
            maxLength={200}
            required
            disabled={busy}
            onChange={(event) => setArea(event.target.value)}
          />
          <AdminField
            id="venue-country"
            label="Country ISO code"
            value={countryCode}
            maxLength={2}
            required
            pattern="[A-Z]{2}"
            disabled={busy}
            onChange={(event) => setCountryCode(event.target.value.toUpperCase())}
          />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold">Map location</legend>
          <CoordinatePicker
            longitude={longitude}
            latitude={latitude}
            onPick={(nextLongitude, nextLatitude) => {
              setLongitude(nextLongitude);
              setLatitude(nextLatitude);
            }}
          />
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold">
            Cuisines (filters only, never serving evidence)
          </legend>
          {cuisines.length === 0 ? (
            <p className="text-sm text-muted">No curated cuisines available.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {cuisines.map((cuisine) => {
                const checked = cuisineIds.includes(cuisine.id);

                return (
                  <li key={cuisine.id}>
                    <label
                      className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-3 py-1 text-sm ${
                        checked
                          ? "border-brand-blue bg-brand-blue/10 font-semibold"
                          : "border-border-soft bg-white"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        disabled={busy}
                        onChange={() => toggleCuisine(cuisine.id)}
                      />
                      {cuisine.displayName ?? cuisine.slug}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        {editing && (
          <section aria-label="Source and attribution summary" className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Sources & attribution</h3>
            {sources.length === 0 ? (
              <p className="text-sm text-muted">
                No recorded sources for this branch yet. Imports are added in menu management below.
              </p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {sources.map((source) => (
                  <li key={source.id} className="rounded-lg border border-border-soft px-3 py-2">
                    {source.category} · observed {source.observedAt.slice(0, 10)} ·{" "}
                    {source.eligible ? "eligible" : "invalidated"} · {source.priceCount} prices ·{" "}
                    {source.pendingPrices + source.pendingEvidence} pending
                    {source.sourceUrl !== null && (
                      <>
                        {" · "}
                        <a
                          href={source.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          Review source
                        </a>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <div className="flex flex-col gap-2">
          <label htmlFor="venue-status" className="text-sm font-semibold">
            Visibility
          </label>
          <select
            id="venue-status"
            value={status}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value;

              if (next === "draft" || next === "published" || next === "archived") {
                setStatus(next);
              }
            }}
            className="min-h-11 rounded-lg border border-border-soft bg-white px-3 text-sm"
          >
            <option value="draft">Draft</option>
            <option value="published">Published{canPublish ? "" : " (needs review grant)"}</option>
            <option value="archived">Archived</option>
          </select>
        </div>

        {shownError !== "" && (
          <p role="alert" className="text-sm font-semibold text-red-800">
            {shownError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <AdminGhostButton type="button" disabled={busy} onClick={onClose}>
            Cancel
          </AdminGhostButton>
          <AdminSecondaryButton
            type="button"
            disabled={busy}
            onClick={() => save("draft")}
            aria-busy={busy}
          >
            {editing ? "Save as draft" : "Save draft"}
          </AdminSecondaryButton>
          <AdminPrimaryButton
            type="button"
            disabled={busy}
            onClick={() => save(status)}
            aria-busy={busy}
            title={statusLabel(status)}
          >
            {editing
              ? `Save (${statusLabel(status).toLowerCase()})`
              : `Save ${statusLabel(status).toLowerCase()}`}
          </AdminPrimaryButton>
        </div>
      </div>
    </AdminDialog>
  );
}
