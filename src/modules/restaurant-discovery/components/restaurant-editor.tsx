import * as maplibre from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from "react";
import MapLibreMap, { Marker, NavigationControl } from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";
import { z } from "zod";

import {
  AdminDialog,
  AdminField,
  AdminGhostButton,
  AdminPrimaryButton,
  AdminSecondaryButton,
} from "@/components/admin/ui";
import { applyWarmBasemap } from "@/modules/restaurant-discovery/components/restaurant-map";
import {
  RestaurantPhotoManager,
  type RestaurantPhotoManagerClient,
} from "@/modules/restaurant-discovery/components/restaurant-photo-manager";
import {
  prefersReducedMotion,
  requestUserPosition,
} from "@/modules/restaurant-discovery/location-storage";
import { CITY_PRESETS, DEFAULT_MAP_CENTER } from "@/modules/restaurant-discovery/map-bounds";
import { venueWriteSchema } from "@/modules/restaurant-discovery/restaurant.schema";
import { resolveMapStyleUrl } from "@/shared/map-style-url";

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

/**
 * Domain schemas are the single source of truth for coordinate validity.
 * The text fields below hold raw strings; every validity decision (inline
 * errors, save-disabled, submit gating) comes from these schemas — never
 * from hand-rolled range checks. `Number()` is only the strict string→
 * number conversion: malformed input such as `12abc` becomes NaN and the
 * schema rejects it. Empty strings are treated as missing, never as zero.
 */
const latitudeSchema = venueWriteSchema.shape.latitude;
const longitudeSchema = venueWriteSchema.shape.longitude;
const coordinatePairSchema = venueWriteSchema.pick({ latitude: true, longitude: true });

function parseCoordinateText(raw: string): number | null {
  const trimmed = raw.trim();

  if (trimmed === "") return null;

  return Number(trimmed);
}

interface CommittedCoordinates {
  readonly longitude: number;
  readonly latitude: number;
}

interface CameraFrame {
  readonly key: number;
  readonly longitude: number;
  readonly latitude: number;
}

/** Normalized free-text area → curated city preset. Explicit aliases only;
 *  an unmatched area never produces a mismatch warning. */
const CITY_AREA_LOOKUP: ReadonlyMap<string, string> = new Map([
  ["hcmc", "hcmc"],
  ["ho chi minh city", "hcmc"],
  ["ho chi minh", "hcmc"],
  ["saigon", "hcmc"],
  ["thanh pho ho chi minh", "hcmc"],
  ["hanoi", "hanoi"],
  ["ha noi", "hanoi"],
  ["bangalore", "bangalore"],
  ["bengaluru", "bangalore"],
]);

function areaWarningFor(area: string, coordinates: CommittedCoordinates): string | null {
  const cityId = CITY_AREA_LOOKUP.get(area.trim().toLowerCase());

  if (cityId === undefined) return null;

  const preset = CITY_PRESETS.find((entry) => entry.id === cityId);

  if (preset === undefined) return null;

  const inside =
    coordinates.longitude >= preset.west &&
    coordinates.longitude <= preset.east &&
    coordinates.latitude >= preset.south &&
    coordinates.latitude <= preset.north;

  if (inside) return null;

  return "These coordinates appear outside the selected area. Please verify the pin.";
}

function CoordinatePicker({
  marker,
  latitudeText,
  longitudeText,
  latitudeError,
  longitudeError,
  areaWarning,
  disabled,
  frame,
  onLatitudeText,
  onLongitudeText,
  onPairPaste,
  onMapPick,
}: {
  readonly marker: CommittedCoordinates;
  readonly latitudeText: string;
  readonly longitudeText: string;
  readonly latitudeError: string | null;
  readonly longitudeError: string | null;
  readonly areaWarning: string | null;
  readonly disabled: boolean;
  /** Camera request from typed input: consumed once per key. Map picks and
   *  geolocation move the camera directly; they never set this. */
  readonly frame: CameraFrame | null;
  readonly onLatitudeText: (raw: string) => void;
  readonly onLongitudeText: (raw: string) => void;
  /** Pasted "lat, lng" pair split across both fields. Validation still
   *  runs through the domain schema in the parent. */
  readonly onPairPaste: (pasted: string) => void;
  /** Committed location from map click, marker drag, or geolocation. The
   *  parent updates the marker, the text fields, and save state. */
  readonly onMapPick: (longitude: number, latitude: number) => void;
}) {
  const mapRef = useRef<MapRef | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState("");
  const [reducedMotion] = useState(() => prefersReducedMotion());

  let styleUrl: string | null = null;
  let styleError: string | null = null;

  try {
    styleUrl = resolveMapStyleUrl(import.meta.env.VITE_MAP_STYLE_URL);
  } catch (error) {
    styleError = error instanceof Error ? error.message : "Invalid map style URL.";
  }

  const moveCamera = useCallback(
    (longitude: number, latitude: number) => {
      const map = mapRef.current?.getMap();

      if (map === undefined || map === null) return;

      const zoom = Math.max(map.getZoom(), 14);

      if (reducedMotion) {
        map.jumpTo({ center: [longitude, latitude], zoom });
      } else {
        map.easeTo({ center: [longitude, latitude], zoom, duration: 300 });
      }
    },
    [reducedMotion],
  );

  useEffect(() => {
    if (frame === null) return;

    moveCamera(frame.longitude, frame.latitude);
  }, [frame, moveCamera]);

  // The dialog can mount the map while its container is still settling;
  // force a resize once tiles start loading and once more right after so
  // the canvas never stays a blank white rectangle.
  useEffect(() => {
    if (!ready || failed) return;

    const map = mapRef.current?.getMap();

    if (map === undefined || map === null) return;

    map.resize();
    const timer = setTimeout(() => {
      map.resize();
    }, 150);

    return () => {
      clearTimeout(timer);
    };
  }, [ready, retryKey, failed]);

  const useMyLocation = () => {
    if (disabled) return;

    setLocating(true);
    setGeoError("");
    requestUserPosition()
      .then((position) => {
        onMapPick(position.longitude, position.latitude);
        moveCamera(position.longitude, position.latitude);
      })
      .catch(() => {
        setGeoError("Could not read your location. Drag the pin or type coordinates instead.");
      })
      .finally(() => {
        setLocating(false);
      });
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");

    if (!text.includes(",") && !text.includes(";")) return;

    event.preventDefault();
    onPairPaste(text);
  };

  return (
    <>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">Coordinates</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <AdminField
            id="venue-latitude"
            label="Latitude"
            value={latitudeText}
            placeholder="10.7769"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            required
            disabled={disabled}
            error={latitudeError}
            onChange={(event) => onLatitudeText(event.target.value)}
            onPaste={handlePaste}
          />
          <AdminField
            id="venue-longitude"
            label="Longitude"
            value={longitudeText}
            placeholder="106.7009"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            required
            disabled={disabled}
            error={longitudeError}
            onChange={(event) => onLongitudeText(event.target.value)}
            onPaste={handlePaste}
          />
        </div>
        <p className="text-sm text-muted">
          Decimal degrees, e.g. 10.7769, 106.7009. You can also paste a “lat, lng” pair into either
          field, or pick the pin on the map.
        </p>
        {areaWarning !== null && (
          <p role="status" className="text-sm font-semibold text-amber-800">
            {areaWarning}
          </p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">Map location</legend>
        {styleError !== null || styleUrl === null ? (
          <div role="alert" className="rounded-xl border border-border-soft bg-white px-3 py-2">
            <p className="text-sm font-semibold text-red-800">{styleError ?? "Map unavailable."}</p>
            <p className="mt-1 text-sm text-muted">
              Type the coordinates above — valid manual coordinates can still be saved.
            </p>
          </div>
        ) : failed ? (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-xl border border-border-soft bg-white px-3 py-2"
          >
            <p className="text-sm font-semibold text-red-800">
              The map could not load its tiles. The coordinates above are unaffected.
            </p>
            <div>
              <AdminGhostButton
                type="button"
                onClick={() => {
                  setFailed(false);
                  setReady(false);
                  setRetryKey((key) => key + 1);
                }}
              >
                Retry map
              </AdminGhostButton>
            </div>
          </div>
        ) : (
          <div
            className="relative h-64 w-full overflow-hidden rounded-xl border border-border-soft"
            aria-label="Branch location picker"
          >
            <MapLibreMap
              key={retryKey}
              ref={mapRef}
              mapLib={maplibre}
              workerUrl={workerUrl}
              mapStyle={styleUrl}
              initialViewState={{
                longitude: marker.longitude,
                latitude: marker.latitude,
                zoom: 14,
              }}
              style={{ width: "100%", height: "100%" }}
              attributionControl={{ compact: true }}
              onLoad={() => {
                const map = mapRef.current?.getMap();

                if (map !== undefined && map !== null) {
                  applyWarmBasemap(map);
                  map.resize();
                }

                setReady(true);
              }}
              onError={() => setFailed(true)}
              onClick={(event) => {
                if (!disabled) onMapPick(event.lngLat.lng, event.lngLat.lat);
              }}
            >
              <NavigationControl position="top-right" />
              <Marker
                longitude={marker.longitude}
                latitude={marker.latitude}
                draggable={!disabled}
                onDragEnd={(event) => {
                  onMapPick(event.lngLat.lng, event.lngLat.lat);
                }}
              />
            </MapLibreMap>
            {!ready && (
              <p
                role="status"
                className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm text-muted"
              >
                Loading map…
              </p>
            )}
          </div>
        )}
        <div>
          <AdminGhostButton type="button" disabled={disabled || locating} onClick={useMyLocation}>
            {locating ? "Locating…" : "Use my location"}
          </AdminGhostButton>
        </div>
        {geoError !== "" && (
          <p role="alert" className="text-sm font-semibold text-red-800">
            {geoError}
          </p>
        )}
      </fieldset>
    </>
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
  photoClient,
  canManagePhotos,
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
  /**
   * Photo service client (wired by the route to
   * `restaurant-photos.functions.ts`). Absent until the route passes it —
   * the Photos section stays hidden so the venue form never shows a dead
   * control.
   */
  readonly photoClient?: RestaurantPhotoManagerClient | undefined;
  /** Venue photo upload/edit grant. Server still enforces `restaurant:manage`. */
  readonly canManagePhotos?: boolean | undefined;
}) {
  const editing = venue !== null;

  /**
   * Initialization precedence (§5). The route remounts this editor with a
   * fresh `key` for every branch, so these initializers run once per
   * opened branch and never carry coordinates over from another branch:
   * 1. Editing → the branch's persisted, schema-validated coordinates.
   * 2. New branch → the documented neutral fallback (Vietnam country
   *    preset); no flow currently supplies explicit coordinates and the
   *    free-text area cannot reliably select a city preset, so no silent
   *    geolocation or address-derived relocation happens here.
   * Corrupt persisted coordinates keep their raw text visible and block
   * saving with an explicit error instead of silently relocating the pin.
   */
  const persistedValid =
    venue === null
      ? null
      : coordinatePairSchema.safeParse({ latitude: venue.latitude, longitude: venue.longitude });

  const [businessMode, setBusinessMode] = useState<"existing" | "new">(
    editing ? "existing" : "new",
  );

  const [businessId, setBusinessId] = useState(venue?.businessId ?? "");
  const [businessName, setBusinessName] = useState(venue?.businessName ?? "");
  const [name, setName] = useState(venue?.name ?? "");
  const [address, setAddress] = useState(venue?.address ?? "");
  const [area, setArea] = useState(venue?.area ?? "");
  const [countryCode, setCountryCode] = useState(venue?.countryCode ?? "VN");
  const [committed, setCommitted] = useState<CommittedCoordinates>(() =>
    persistedValid !== null && persistedValid.success
      ? { longitude: persistedValid.data.longitude, latitude: persistedValid.data.latitude }
      : { longitude: DEFAULT_MAP_CENTER.longitude, latitude: DEFAULT_MAP_CENTER.latitude },
  );
  const [latitudeText, setLatitudeText] = useState(() =>
    venue === null ? String(DEFAULT_MAP_CENTER.latitude) : String(venue.latitude),
  );
  const [longitudeText, setLongitudeText] = useState(() =>
    venue === null ? String(DEFAULT_MAP_CENTER.longitude) : String(venue.longitude),
  );
  const [frame, setFrame] = useState<CameraFrame | null>(null);
  const [status, setStatus] = useState<EditorVenue["status"]>(venue?.status ?? "draft");
  const [cuisineIds, setCuisineIds] = useState<ReadonlyArray<string>>(venue?.cuisineIds ?? []);
  const [formError, setFormError] = useState(() =>
    venue !== null && !(persistedValid !== null && persistedValid.success)
      ? "The saved coordinates for this branch look invalid. Enter a valid latitude and longitude, then save."
      : "",
  );

  const frameKey = useRef(0);
  const cameraTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (cameraTimer.current !== null) clearTimeout(cameraTimer.current);
    },
    [],
  );

  const parsedLatitude = parseCoordinateText(latitudeText);
  const parsedLongitude = parseCoordinateText(longitudeText);
  const coordsValid = coordinatePairSchema.safeParse({
    latitude: parsedLatitude,
    longitude: parsedLongitude,
  }).success;

  const latitudeError =
    latitudeText.trim() === ""
      ? "Latitude is required."
      : latitudeSchema.safeParse(parsedLatitude).success
        ? null
        : "Enter a latitude between -90 and 90.";
  const longitudeError =
    longitudeText.trim() === ""
      ? "Longitude is required."
      : longitudeSchema.safeParse(parsedLongitude).success
        ? null
        : "Enter a longitude between -180 and 180.";

  const areaWarning = areaWarningFor(area, committed);

  const scheduleFrame = (longitude: number, latitude: number) => {
    if (cameraTimer.current !== null) clearTimeout(cameraTimer.current);

    // Debounced so typing a valid intermediate prefix never thrashes the
    // camera; map picks and geolocation move it immediately instead.
    cameraTimer.current = setTimeout(() => {
      frameKey.current += 1;
      setFrame({ key: frameKey.current, longitude, latitude });
    }, 500);
  };

  const commitPair = (longitude: number, latitude: number) => {
    setCommitted({ longitude, latitude });
    setLatitudeText(String(latitude));
    setLongitudeText(String(longitude));
  };

  /** Map click / marker drag: the map is already showing the picked point,
   *  so only the committed pair and fields update — no camera request. */
  const handleMapPick = (longitude: number, latitude: number) => {
    if (cameraTimer.current !== null) {
      clearTimeout(cameraTimer.current);
      cameraTimer.current = null;
    }

    commitPair(longitude, latitude);
  };

  /** Typed input: raw text is kept verbatim (a lone "-" or "10." never
   *  resets), the marker follows only complete schema-valid pairs, and the
   *  last valid pin stays put while the text is incomplete. */
  const handleLatitudeText = (raw: string) => {
    setLatitudeText(raw);

    const parsed = coordinatePairSchema.safeParse({
      latitude: parseCoordinateText(raw),
      longitude: parsedLongitude,
    });

    if (parsed.success) {
      setCommitted({ longitude: parsed.data.longitude, latitude: parsed.data.latitude });
      scheduleFrame(parsed.data.longitude, parsed.data.latitude);
    }
  };

  const handleLongitudeText = (raw: string) => {
    setLongitudeText(raw);

    const parsed = coordinatePairSchema.safeParse({
      latitude: parsedLatitude,
      longitude: parseCoordinateText(raw),
    });

    if (parsed.success) {
      setCommitted({ longitude: parsed.data.longitude, latitude: parsed.data.latitude });
      scheduleFrame(parsed.data.longitude, parsed.data.latitude);
    }
  };

  const handlePairPaste = (pasted: string) => {
    const parts = pasted
      .split(/[,;]/)
      .map((part) => part.trim())
      .filter((part) => part !== "");

    if (parts.length !== 2) return;

    const first = parts[0] ?? "";
    const second = parts[1] ?? "";

    setLatitudeText(first);
    setLongitudeText(second);

    const parsed = coordinatePairSchema.safeParse({
      latitude: Number(first),
      longitude: Number(second),
    });

    if (parsed.success) {
      setCommitted({ longitude: parsed.data.longitude, latitude: parsed.data.latitude });
      scheduleFrame(parsed.data.longitude, parsed.data.latitude);
    }
  };

  const toggleCuisine = (id: string) => {
    if (cuisineIds.includes(id)) {
      setCuisineIds(cuisineIds.filter((entry) => entry !== id));
    } else if (cuisineIds.length < 20) {
      setCuisineIds([...cuisineIds, id]);
    }
  };

  const save = (nextStatus: EditorVenue["status"]) => {
    const trimmedBusiness = businessName.trim();

    if (parsedLatitude === null || parsedLongitude === null) {
      setFormError(latitudeError ?? longitudeError ?? "Enter a valid latitude and longitude.");

      return;
    }

    // Submit gating runs through the domain schema: raw text converts
    // strictly (empty → null, "12abc" → NaN) and the schema decides.
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
      longitude: parsedLongitude,
      latitude: parsedLatitude,
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
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold">Location details</legend>
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
        </fieldset>

        <CoordinatePicker
          marker={committed}
          latitudeText={latitudeText}
          longitudeText={longitudeText}
          latitudeError={latitudeError}
          longitudeError={longitudeError}
          areaWarning={areaWarning}
          disabled={busy}
          frame={frame}
          onLatitudeText={handleLatitudeText}
          onLongitudeText={handleLongitudeText}
          onPairPaste={handlePairPaste}
          onMapPick={handleMapPick}
        />

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
          <section
            id="restaurant-editor-sources"
            aria-label="Source and attribution summary"
            className="flex scroll-mt-4 flex-col gap-2"
          >
            {" "}
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

        {editing && photoClient !== undefined && (
          <section
            id="restaurant-editor-photos"
            aria-label="Venue photos"
            className="flex scroll-mt-4 flex-col gap-2"
          >
            {" "}
            <h3 className="text-sm font-semibold">Photos</h3>
            <RestaurantPhotoManager
              venueId={venue.id}
              venueName={venue.name}
              canManage={canManagePhotos ?? false}
              canReview={canPublish}
              client={photoClient}
            />
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
            disabled={busy || !coordsValid}
            onClick={() => save("draft")}
            aria-busy={busy}
            title={coordsValid ? undefined : "Enter valid coordinates before saving"}
          >
            {editing ? "Save as draft" : "Save draft"}
          </AdminSecondaryButton>
          <AdminPrimaryButton
            type="button"
            disabled={busy || !coordsValid}
            onClick={() => save(status)}
            aria-busy={busy}
            title={coordsValid ? statusLabel(status) : "Enter valid coordinates before saving"}
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
