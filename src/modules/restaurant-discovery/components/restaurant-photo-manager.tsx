import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Eye,
  EyeOff,
  ImagePlus,
  Send,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import { useState } from "react";

import { AdminSelectField } from "@/components/admin/select";
import { AdminGhostButton, AdminPrimaryButton } from "@/components/admin/ui";

/**
 * Venue photo manager for the branch editor (Feast Lab).
 *
 * Staff-only surface: drafts and review items never leave this screen —
 * guests see published photos only. Authorization lives server-side
 * (`restaurant:read` for venue + queue reads, `restaurant:manage` for
 * stage/edit/reorder/submit/withdraw, `restaurant:review` for publish and
 * for withdrawing or deleting published rows). `canManage`/`canReview`
 * only hide controls; they are navigation hints, never a boundary.
 *
 * Server contract (`restaurant-photos.functions.ts`): `listVenuePhotos({venueId})`,
 * `listPhotoReviewQueue({limit, offset})` (review-status window as a plain
 * array — the manager filters it to its venue), `stageVenuePhoto`
 * (multipart FormData upload), `updatePhotoMetadata({photoId, ...})`,
 * `reorderPhotos({venueId, orderedIds})`, `submitPhotoForReview({photoId})`,
 * `publishPhoto({photoId})`, `withdrawPhoto({photoId})`,
 * `deletePhoto({photoId})`, `previewPhoto({photoId, ...})`. This file never
 * imports that module directly — the client is injected so the manager
 * renders against the contract even while the functions land.
 */

export type RestaurantPhotoStatus = "draft" | "review" | "published";

/** Staff view of one venue photo. `isPrimary` is derived: index 0 wins. */
export interface ManagedRestaurantPhoto {
  readonly id: string;
  readonly venueId: string;
  readonly venueName: string | null;
  readonly status: RestaurantPhotoStatus;
  readonly sortOrder: number;
  readonly isPrimary: boolean;
  readonly altText: string | null;
  readonly attribution: string | null;
  /** Reviewer-facing description. Forwarded with metadata; ignored until stored. */
  readonly description: string | null;
  readonly license: string;
  readonly focalX: number | null;
  readonly focalY: number | null;
  readonly sourceUrl: string | null;
  /** Public delivery URL — set only for published + ready rows. */
  readonly deliveryUrl: string | null;
  /** Session-gated preview URL for drafts/review rows with stored bytes. */
  readonly previewUrl: string | null;
  readonly processing: string;
  /** Publish-block reasons from the last rejected publish (server or local). */
  readonly blockReasons: ReadonlyArray<string>;
}

export interface PhotoStageInput {
  readonly venueId: string;
  readonly file: File;
  readonly altText: string | null;
  readonly attribution: string | null;
  readonly description: string | null;
  readonly license: string;
  readonly sourceUrl: string | null;
  readonly focalX: number | null;
  readonly focalY: number | null;
  readonly makePrimary: boolean;
}

export interface PhotoMetadataInput {
  readonly photoId: string;
  readonly altText: string | null;
  readonly attribution: string | null;
  readonly description: string | null;
  readonly license: string;
  readonly sourceUrl: string | null;
  readonly focalX: number | null;
  readonly focalY: number | null;
}

/**
 * Review queue window. Mirrors the transport validator
 * (`restaurantPhotoReviewQueueSchema`): paging only. The endpoint serves
 * `review`-status rows across venues as a plain array; the manager filters
 * the window to its own venue client-side.
 */
export interface PhotoReviewQueueInput {
  readonly limit: number;
  readonly offset: number;
}

/**
 * Injected server boundary. Method names match
 * `restaurant-photos.functions.ts` exactly (the upload entry is
 * `stageVenuePhoto`, multipart FormData — the route adapter builds the
 * FormData from `PhotoStageInput`). Row payloads project the strict admin
 * schema: the adapter fills `venueName` for the edited venue (null
 * otherwise), `description` stays null until stored, and `blockReasons`
 * starts empty — publish failures append here.
 */
export interface RestaurantPhotoManagerClient {
  readonly listVenuePhotos: (input: {
    readonly venueId: string;
  }) => Promise<ReadonlyArray<ManagedRestaurantPhoto>>;
  readonly listPhotoReviewQueue: (
    input: PhotoReviewQueueInput,
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<ManagedRestaurantPhoto>>;
  readonly stageVenuePhoto: (input: PhotoStageInput) => Promise<ManagedRestaurantPhoto>;
  readonly updatePhotoMetadata: (input: PhotoMetadataInput) => Promise<ManagedRestaurantPhoto>;
  readonly reorderPhotos: (input: {
    readonly venueId: string;
    readonly orderedIds: ReadonlyArray<string>;
  }) => Promise<ReadonlyArray<ManagedRestaurantPhoto>>;
  readonly submitPhotoForReview: (input: {
    readonly photoId: string;
  }) => Promise<ManagedRestaurantPhoto>;
  readonly publishPhoto: (input: { readonly photoId: string }) => Promise<ManagedRestaurantPhoto>;
  readonly withdrawPhoto: (input: { readonly photoId: string }) => Promise<ManagedRestaurantPhoto>;
  readonly deletePhoto: (input: {
    readonly photoId: string;
  }) => Promise<{ readonly id: string; readonly venueId: string }>;
  readonly previewPhoto: (input: { readonly photoId: string }) => Promise<string>;
}

export type PhotoLifecycleAction = "submit" | "publish" | "withdraw" | "remove";

/** Venue photo list key. The venue rides in the key so venues never share a cache. */
export const restaurantPhotoListKey = (venueId: string): ReadonlyArray<string> => [
  "admin",
  "restaurant-photos",
  venueId,
];

/** Review queue key. Venue-scoped: the manager filters the fetched window to its venue. */
export const restaurantPhotoReviewKey = (venueId: string): ReadonlyArray<string> => [
  "admin",
  "restaurant-photos",
  "review-queue",
  venueId,
];

/** Decision payloads carry the photo ID only — never bytes, author, or venues. */
export interface PhotoIdInput {
  readonly photoId: string;
}

export function toPhotoIdInput(photoId: string): PhotoIdInput {
  return { photoId };
}

/**
 * Lifecycle guard: a control is disabled while a mutation is pending or
 * when the entry already holds (or cannot reach) the target state.
 * Published rows return to draft first — they never re-enter review.
 */
export function photoActionDisabled(
  status: RestaurantPhotoStatus,
  action: PhotoLifecycleAction,
  pending: boolean,
): boolean {
  if (pending) return true;

  if (action === "submit") return status !== "draft";

  if (action === "publish") return status === "published";

  if (action === "withdraw") return status === "draft";

  return false;
}

/** Client-side publish-block evidence. Mirrors the server publish gate. */
export function missingPhotoEvidence(photo: ManagedRestaurantPhoto): ReadonlyArray<string> {
  const reasons: Array<string> = [];

  if (photo.processing !== "ready") {
    reasons.push(`photo is ${photo.processing}; finalize processing before publishing`);
  }

  if (photo.license === "unknown" || photo.license.trim() === "") {
    reasons.push("license is required to publish; attach a supported license");
  }

  if (photo.attribution === null || photo.attribution.trim() === "") {
    reasons.push("attribution is required to publish");
  }

  if (photo.altText === null || photo.altText.trim() === "") {
    reasons.push("alt text is required to publish");
  }

  if (photo.status === "draft") {
    reasons.push("photo is draft; submit it for review before publishing");
  }

  return reasons;
}

export function describePhotoDecision(
  kind: "staged" | "saved" | "submitted" | "published" | "withdrawn" | "removed",
  repeated: boolean,
): string {
  if (repeated) return "That decision was already recorded.";

  if (kind === "staged") return "Photo uploaded. Metadata stays draft until submitted for review.";

  if (kind === "saved") return "Photo metadata saved.";

  if (kind === "submitted") return "Photo submitted for review.";

  if (kind === "published") return "Photo published. It now appears in public galleries.";

  if (kind === "withdrawn")
    return "Photo withdrawn to draft. Public delivery is revoked; bytes stay for re-review.";

  return "Photo deleted. Stored derivatives are removed; the row stays for audit only.";
}

const LICENSE_OPTIONS: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
  { label: "Own work", value: "own-work" },
  { label: "CC0", value: "cc0" },
  { label: "CC BY", value: "cc-by" },
  { label: "CC BY-SA", value: "cc-by-sa" },
  { label: "Licensed", value: "licensed" },
  { label: "Unknown (draft only)", value: "unknown" },
];

function formatFocal(value: number | null): string {
  return value === null ? "" : String(value);
}

function parseFocal(raw: string): number | null {
  const trimmed = raw.trim();

  if (trimmed === "") return null;

  const parsed = Number(trimmed);

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return null;

  return parsed;
}

function PhotoImage({
  photo,
  venueName,
  eager,
}: {
  readonly photo: ManagedRestaurantPhoto;
  readonly venueName: string;
  readonly eager: boolean;
}) {
  const src = photo.deliveryUrl ?? photo.previewUrl;

  if (src === null) {
    return (
      <div className="rpm-img-fallback" aria-hidden="true" role="presentation">
        <span>{venueName.charAt(0).toUpperCase() || "•"}</span>
      </div>
    );
  }

  return (
    <img
      className="rpm-img"
      src={src}
      alt={photo.altText ?? `Unlabeled venue photo for ${venueName}`}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
    />
  );
}

function PhotoMetadataEditor({
  photo,
  pending,
  onSave,
}: {
  readonly photo: ManagedRestaurantPhoto;
  readonly pending: boolean;
  readonly onSave: (input: PhotoMetadataInput) => void;
}) {
  const prefix = `rpm-meta-${photo.id}`;
  const [altText, setAltText] = useState(photo.altText ?? "");
  const [attribution, setAttribution] = useState(photo.attribution ?? "");
  const [description, setDescription] = useState(photo.description ?? "");
  const [license, setLicense] = useState(photo.license);
  const [sourceUrl, setSourceUrl] = useState(photo.sourceUrl ?? "");
  const [focalX, setFocalX] = useState(formatFocal(photo.focalX));
  const [focalY, setFocalY] = useState(formatFocal(photo.focalY));
  const [formError, setFormError] = useState("");

  const save = (): void => {
    if (sourceUrl.trim() !== "" && !sourceUrl.trim().startsWith("https://")) {
      setFormError("Source URL must be an https URL.");

      return;
    }

    setFormError("");
    onSave({
      photoId: photo.id,
      altText: altText.trim() === "" ? null : altText.trim(),
      attribution: attribution.trim() === "" ? null : attribution.trim(),
      description: description.trim() === "" ? null : description.trim(),
      license,
      sourceUrl: sourceUrl.trim() === "" ? null : sourceUrl.trim(),
      focalX: parseFocal(focalX),
      focalY: parseFocal(focalY),
    });
  };

  return (
    <div className="rpm-editor">
      <div className="rpm-field">
        <label htmlFor={`${prefix}-alt`}>Alt text (required to publish)</label>
        <input
          id={`${prefix}-alt`}
          value={altText}
          maxLength={500}
          disabled={pending}
          onChange={(event) => setAltText(event.target.value)}
          placeholder="Storefront at lunch, Vietnamese sign visible"
        />
      </div>
      <div className="rpm-field">
        <label htmlFor={`${prefix}-attribution`}>Attribution (required to publish)</label>
        <input
          id={`${prefix}-attribution`}
          value={attribution}
          maxLength={500}
          disabled={pending}
          onChange={(event) => setAttribution(event.target.value)}
          placeholder="Photo by Linh Nguyen"
        />
      </div>
      <div className="rpm-field">
        <label htmlFor={`${prefix}-description`}>Description (reviewer note)</label>
        <textarea
          id={`${prefix}-description`}
          value={description}
          maxLength={2000}
          rows={2}
          disabled={pending}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What the photo shows and why it represents the venue"
        />
      </div>
      <AdminSelectField
        id={`${prefix}-license`}
        label="License"
        value={license}
        onValueChange={setLicense}
        options={LICENSE_OPTIONS.map((option) => ({
          label: option.label,
          value: option.value,
        }))}
        disabled={pending}
      />
      <div className="rpm-field">
        <label htmlFor={`${prefix}-source`}>Source URL (https evidence)</label>
        <input
          id={`${prefix}-source`}
          value={sourceUrl}
          inputMode="url"
          disabled={pending}
          onChange={(event) => setSourceUrl(event.target.value)}
          placeholder="https://…"
        />
      </div>
      <div className="rpm-focal-row">
        <div className="rpm-field">
          <label htmlFor={`${prefix}-focal-x`}>Focal X (0–1)</label>
          <input
            id={`${prefix}-focal-x`}
            value={focalX}
            inputMode="decimal"
            disabled={pending}
            onChange={(event) => setFocalX(event.target.value)}
            placeholder="0.5"
          />
        </div>
        <div className="rpm-field">
          <label htmlFor={`${prefix}-focal-y`}>Focal Y (0–1)</label>
          <input
            id={`${prefix}-focal-y`}
            value={focalY}
            inputMode="decimal"
            disabled={pending}
            onChange={(event) => setFocalY(event.target.value)}
            placeholder="0.5"
          />
        </div>
      </div>
      {formError !== "" && (
        <p role="alert" className="rpm-error">
          {formError}
        </p>
      )}
      <div>
        <AdminGhostButton type="button" disabled={pending} aria-busy={pending} onClick={save}>
          Save metadata
        </AdminGhostButton>
      </div>
    </div>
  );
}

function PhotoCard({
  photo,
  venueName,
  position,
  total,
  canManage,
  canReview,
  pending,
  confirmingRemove,
  blockReasons,
  onSave,
  onMove,
  onSubmit,
  onPublish,
  onWithdraw,
  onArmRemove,
  onDisarmRemove,
  onRemove,
}: {
  readonly photo: ManagedRestaurantPhoto;
  readonly venueName: string;
  readonly position: number;
  readonly total: number;
  readonly canManage: boolean;
  readonly canReview: boolean;
  readonly pending: boolean;
  readonly confirmingRemove: boolean;
  readonly blockReasons: ReadonlyArray<string>;
  readonly onSave: (input: PhotoMetadataInput) => void;
  readonly onMove: (photoId: string, direction: -1 | 1) => void;
  readonly onSubmit: (photoId: string) => void;
  readonly onPublish: (photoId: string) => void;
  readonly onWithdraw: (photoId: string) => void;
  readonly onArmRemove: () => void;
  readonly onDisarmRemove: () => void;
  readonly onRemove: (photoId: string) => void;
}) {
  const evidence = missingPhotoEvidence(photo);
  const combined = [...evidence, ...blockReasons];

  return (
    <li className="rpm-card">
      <div className="rpm-card-head">
        <PhotoImage photo={photo} venueName={venueName} eager={position === 0} />
        <div className="rpm-badges">
          <span className="rpm-badge">{photo.status}</span>
          {position === 0 && (
            <span className="rpm-badge rpm-badge-primary">
              <Star aria-hidden="true" className="rpm-icon" />
              Primary
            </span>
          )}
          {photo.processing !== "ready" && (
            <span className="rpm-badge rpm-badge-warn">{photo.processing}</span>
          )}
        </div>
      </div>
      <p className="rpm-meta">
        Position {position + 1} of {total} · first photo is the primary in public galleries
      </p>
      {photo.sourceUrl !== null && (
        <p className="rpm-source">
          Source evidence:{" "}
          <a href={photo.sourceUrl} target="_blank" rel="noreferrer">
            Review source
          </a>
        </p>
      )}
      {combined.length > 0 && (
        <ul className="rpm-blocks" aria-label={`Publish blockers for photo ${position + 1}`}>
          {combined.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {canManage && <PhotoMetadataEditor photo={photo} pending={pending} onSave={onSave} />}
      {canManage && (
        <div className="rpm-actions">
          <AdminGhostButton
            type="button"
            disabled={pending || position === 0}
            aria-label={`Move photo ${position + 1} earlier`}
            onClick={() => onMove(photo.id, -1)}
          >
            <ArrowUp aria-hidden="true" className="rpm-icon" />
            Move up
          </AdminGhostButton>
          <AdminGhostButton
            type="button"
            disabled={pending || position >= total - 1}
            aria-label={`Move photo ${position + 1} later`}
            onClick={() => onMove(photo.id, 1)}
          >
            <ArrowDown aria-hidden="true" className="rpm-icon" />
            Move down
          </AdminGhostButton>
          <AdminGhostButton
            type="button"
            disabled={photoActionDisabled(photo.status, "submit", pending)}
            onClick={() => onSubmit(photo.id)}
          >
            <Send aria-hidden="true" className="rpm-icon" />
            Submit for review
          </AdminGhostButton>
          {canReview && (
            <AdminPrimaryButton
              type="button"
              disabled={photoActionDisabled(photo.status, "publish", pending)}
              onClick={() => onPublish(photo.id)}
            >
              <Check aria-hidden="true" className="rpm-icon" />
              Publish
            </AdminPrimaryButton>
          )}
          <AdminGhostButton
            type="button"
            disabled={photoActionDisabled(photo.status, "withdraw", pending)}
            onClick={() => onWithdraw(photo.id)}
          >
            {photo.status === "published" ? (
              <EyeOff aria-hidden="true" className="rpm-icon" />
            ) : (
              <Eye aria-hidden="true" className="rpm-icon" />
            )}
            {photo.status === "published" ? "Withdraw to draft" : "Back to draft"}
          </AdminGhostButton>
          {confirmingRemove ? (
            <>
              <span className="rpm-confirm" role="alert">
                Delete this photo? Stored derivatives are removed.
              </span>
              <AdminGhostButton
                type="button"
                disabled={pending}
                aria-busy={pending}
                onClick={() => onRemove(photo.id)}
              >
                <Trash2 aria-hidden="true" className="rpm-icon" />
                Confirm delete
              </AdminGhostButton>
              <AdminGhostButton type="button" disabled={pending} onClick={onDisarmRemove}>
                Keep photo
              </AdminGhostButton>
            </>
          ) : (
            <AdminGhostButton type="button" disabled={pending} onClick={onArmRemove}>
              <Trash2 aria-hidden="true" className="rpm-icon" />
              Delete
            </AdminGhostButton>
          )}
        </div>
      )}
    </li>
  );
}

function UploadDropArea({
  venueId,
  pending,
  onStage,
}: {
  readonly venueId: string;
  readonly pending: boolean;
  readonly onStage: (input: PhotoStageInput) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [altText, setAltText] = useState("");
  const [attribution, setAttribution] = useState("");
  const [license, setLicense] = useState("unknown");
  const [sourceUrl, setSourceUrl] = useState("");
  const [makePrimary, setMakePrimary] = useState(false);
  const [formError, setFormError] = useState("");

  const acceptFile = (next: File | null): void => {
    if (next === null) return;

    if (previewUrl !== null) URL.revokeObjectURL(previewUrl);

    setFile(next);
    setPreviewUrl(URL.createObjectURL(next));
  };

  const stage = (): void => {
    if (file === null) {
      setFormError("Choose a JPEG, PNG, or WebP photo first.");

      return;
    }

    if (sourceUrl.trim() !== "" && !sourceUrl.trim().startsWith("https://")) {
      setFormError("Source URL must be an https URL.");

      return;
    }

    setFormError("");
    onStage({
      venueId,
      file,
      altText: altText.trim() === "" ? null : altText.trim(),
      attribution: attribution.trim() === "" ? null : attribution.trim(),
      description: null,
      license,
      sourceUrl: sourceUrl.trim() === "" ? null : sourceUrl.trim(),
      focalX: null,
      focalY: null,
      makePrimary,
    });
  };

  return (
    <div className="rpm-upload">
      <div
        className={`rpm-dropzone${dragging ? " rpm-dropzone-active" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          acceptFile(event.dataTransfer.files.item(0));
        }}
      >
        <ImagePlus aria-hidden="true" className="rpm-drop-icon" />
        <p>Drop a venue photo here, or choose a file.</p>
        <p className="rpm-hint">JPEG, PNG, or WebP · 8 MiB or smaller · shortest side 600px.</p>
        <label htmlFor="rpm-file" className="rpm-file-label">
          Choose photo
        </label>
        <input
          id="rpm-file"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={pending}
          onChange={(event) => acceptFile(event.target.files?.item(0) ?? null)}
        />
      </div>
      {previewUrl !== null && file !== null && (
        <div className="rpm-preview">
          <img src={previewUrl} alt="Selected upload preview" />
          <p className="rpm-hint">
            {file.name} · {(file.size / 1048576).toFixed(1)} MiB
          </p>
        </div>
      )}
      {pending && (
        <p aria-live="polite" className="rpm-progress">
          Uploading photo…
        </p>
      )}
      <div className="rpm-field">
        <label htmlFor="rpm-upload-alt">Alt text (required to publish)</label>
        <input
          id="rpm-upload-alt"
          value={altText}
          maxLength={500}
          disabled={pending}
          onChange={(event) => setAltText(event.target.value)}
          placeholder="Storefront at lunch, Vietnamese sign visible"
        />
      </div>
      <div className="rpm-field">
        <label htmlFor="rpm-upload-attribution">Attribution (required to publish)</label>
        <input
          id="rpm-upload-attribution"
          value={attribution}
          maxLength={500}
          disabled={pending}
          onChange={(event) => setAttribution(event.target.value)}
          placeholder="Photo by Linh Nguyen"
        />
      </div>
      <AdminSelectField
        id="rpm-upload-license"
        label="License"
        value={license}
        onValueChange={setLicense}
        options={LICENSE_OPTIONS.map((option) => ({
          label: option.label,
          value: option.value,
        }))}
        disabled={pending}
      />
      <div className="rpm-field">
        <label htmlFor="rpm-upload-source">Source URL (https evidence)</label>
        <input
          id="rpm-upload-source"
          value={sourceUrl}
          inputMode="url"
          disabled={pending}
          onChange={(event) => setSourceUrl(event.target.value)}
          placeholder="https://…"
        />
      </div>
      <label className="rpm-check">
        <input
          type="checkbox"
          checked={makePrimary}
          disabled={pending}
          onChange={(event) => setMakePrimary(event.target.checked)}
        />
        Make this the primary photo
      </label>
      {formError !== "" && (
        <p role="alert" className="rpm-error">
          {formError}
        </p>
      )}
      <div>
        <AdminPrimaryButton
          type="button"
          disabled={pending || file === null}
          aria-busy={pending}
          onClick={stage}
        >
          <Upload aria-hidden="true" className="rpm-icon" />
          Upload photo
        </AdminPrimaryButton>
      </div>
    </div>
  );
}

function failNotice(error: Error | null): string {
  if (error instanceof Error && error.message !== "") return error.message;

  return "The action failed. Retry.";
}

export function RestaurantPhotoManager({
  venueId,
  venueName,
  canManage,
  canReview,
  client,
  initialPhotos,
  initialQueue,
}: {
  readonly venueId: string;
  readonly venueName: string;
  readonly canManage: boolean;
  readonly canReview: boolean;
  readonly client: RestaurantPhotoManagerClient;
  readonly initialPhotos?: ReadonlyArray<ManagedRestaurantPhoto>;
  readonly initialQueue?: ReadonlyArray<ManagedRestaurantPhoto>;
}) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const [serverBlocks, setServerBlocks] = useState<ReadonlyMap<string, ReadonlyArray<string>>>(
    new Map(),
  );

  const photos = useQuery({
    queryKey: restaurantPhotoListKey(venueId),
    queryFn: () => client.listVenuePhotos({ venueId }),
    initialData: initialPhotos,
    retry: false,
  });

  // Review window: the transport serves the latest `review` rows across
  // venues (queue depth is bounded by the per-venue photo cap), so one
  // fixed window covers this venue's candidates; filtering is venue-local.
  const queue = useQuery({
    queryKey: restaurantPhotoReviewKey(venueId),
    queryFn: ({ signal }) => client.listPhotoReviewQueue({ limit: 100, offset: 0 }, signal),
    enabled: canReview,
    initialData: initialQueue,
    retry: false,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "restaurant-photos"] });
  };

  const stage = useMutation({
    mutationFn: (input: PhotoStageInput) => client.stageVenuePhoto(input),
    onSuccess: () => setNotice(describePhotoDecision("staged", false)),
    onError: (error) => setNotice(failNotice(error)),
    onSettled: invalidate,
  });

  const saveMetadata = useMutation({
    mutationFn: (input: PhotoMetadataInput) => client.updatePhotoMetadata(input),
    onSuccess: () => setNotice(describePhotoDecision("saved", false)),
    onError: (error) => setNotice(failNotice(error)),
    onSettled: invalidate,
  });

  const reorder = useMutation({
    mutationFn: (orderedIds: ReadonlyArray<string>) =>
      client.reorderPhotos({ venueId, orderedIds }),
    onSuccess: () => setNotice(describePhotoDecision("saved", false)),
    onError: (error) => setNotice(failNotice(error)),
    onSettled: invalidate,
  });

  const submit = useMutation({
    mutationFn: (photoId: string) => client.submitPhotoForReview(toPhotoIdInput(photoId)),
    onSuccess: () => setNotice(describePhotoDecision("submitted", false)),
    onError: (error) => setNotice(failNotice(error)),
    onSettled: invalidate,
  });

  const publish = useMutation({
    mutationFn: (photoId: string) => client.publishPhoto(toPhotoIdInput(photoId)),
    onSuccess: () => setNotice(describePhotoDecision("published", false)),
    onError: (error) => {
      const message = failNotice(error);
      const blockedId = /photoId "([^"]+)"/.exec(message)?.[1];

      if (blockedId !== undefined) {
        setServerBlocks((previous) => new Map(previous).set(blockedId, [message]));
      }

      setNotice(message);
    },
    onSettled: invalidate,
  });

  const withdraw = useMutation({
    mutationFn: (photoId: string) => client.withdrawPhoto(toPhotoIdInput(photoId)),
    onSuccess: () => setNotice(describePhotoDecision("withdrawn", false)),
    onError: (error) => setNotice(failNotice(error)),
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: (photoId: string) => client.deletePhoto(toPhotoIdInput(photoId)),
    onSuccess: () => {
      setConfirmingId(null);
      setNotice(describePhotoDecision("removed", false));
    },
    onError: (error) => setNotice(failNotice(error)),
    onSettled: invalidate,
  });

  const busy =
    photos.isFetching ||
    queue.isFetching ||
    stage.isPending ||
    saveMetadata.isPending ||
    reorder.isPending ||
    submit.isPending ||
    publish.isPending ||
    withdraw.isPending ||
    remove.isPending;

  const move = (photoId: string, direction: -1 | 1): void => {
    const current = photos.data ?? [];

    if (current.length < 2) return;

    const from = current.findIndex((photo) => photo.id === photoId);

    if (from === -1) return;

    const to = from + direction;

    if (to < 0 || to >= current.length) return;

    const next = [...current];
    const [moved] = next.splice(from, 1);

    if (moved === undefined) return;

    next.splice(to, 0, moved);
    reorder.mutate(next.map((photo) => photo.id));
  };

  const items = photos.data ?? [];
  const queueItems = (queue.data ?? []).filter((photo) => photo.venueId === venueId);

  return (
    <div className="rpm-manager" lang="en">
      <p className="rpm-lede">
        Venue photos for {venueName}. Drafts and review items stay staff-only; guests see published
        photos only. The first photo is the primary in public galleries.
      </p>

      {canManage && <UploadDropArea venueId={venueId} pending={busy} onStage={stage.mutate} />}

      {photos.isPending && (
        <p aria-live="polite" className="rpm-progress">
          Loading venue photos…
        </p>
      )}
      {photos.isError && (
        <p role="alert" className="rpm-error">
          {failNotice(photos.error)}
        </p>
      )}
      {photos.data !== undefined && items.length === 0 && (
        <output className="rpm-empty">
          No venue photos yet. Upload the first photo to start the draft → review → published flow.
        </output>
      )}
      {items.length > 0 && (
        <>
          <p aria-live="polite" className="rpm-count">
            {items.length} {items.length === 1 ? "photo" : "photos"} for this venue.
          </p>
          <ul className="rpm-grid">
            {items.map((photo, index) => (
              <PhotoCard
                key={photo.id}
                photo={photo}
                venueName={venueName}
                position={index}
                total={items.length}
                canManage={canManage}
                canReview={canReview}
                pending={busy}
                confirmingRemove={confirmingId === photo.id}
                blockReasons={serverBlocks.get(photo.id) ?? []}
                onSave={saveMetadata.mutate}
                onMove={move}
                onSubmit={submit.mutate}
                onPublish={publish.mutate}
                onWithdraw={withdraw.mutate}
                onArmRemove={() => setConfirmingId(photo.id)}
                onDisarmRemove={() => setConfirmingId(null)}
                onRemove={remove.mutate}
              />
            ))}
          </ul>
        </>
      )}

      {canReview && (
        <div className="rpm-queue">
          <h3 className="rpm-queue-title">Photo review queue</h3>
          <p className="rpm-lede">
            Photos from this venue awaiting review. Publish decisions need the review grant and
            complete evidence below; the transport serves the review window, this list is
            venue-scoped.
          </p>
          {queue.isPending && (
            <p aria-live="polite" className="rpm-progress">
              Loading photo review queue…
            </p>
          )}
          {queue.isError && (
            <p role="alert" className="rpm-error">
              {failNotice(queue.error)}
            </p>
          )}
          {queue.data !== undefined && (
            <>
              <p aria-live="polite" className="rpm-count">
                {queueItems.length} {queueItems.length === 1 ? "photo" : "photos"} awaiting review
                for this venue.
              </p>
              {queueItems.length === 0 ? (
                <output className="rpm-empty">No photos awaiting review for this venue.</output>
              ) : (
                <ul className="rpm-grid">
                  {queueItems.map((photo) => (
                    <li key={photo.id} className="rpm-card">
                      <div className="rpm-card-head">
                        <PhotoImage
                          photo={photo}
                          venueName={photo.venueName ?? venueName}
                          eager={false}
                        />
                        <div className="rpm-badges">
                          <span className="rpm-badge">{photo.status}</span>
                        </div>
                      </div>
                      <p className="rpm-meta">{photo.venueName ?? venueName}</p>
                      {photo.sourceUrl !== null && (
                        <p className="rpm-source">
                          Source evidence:{" "}
                          <a href={photo.sourceUrl} target="_blank" rel="noreferrer">
                            Review source
                          </a>
                        </p>
                      )}
                      {missingPhotoEvidence(photo).length > 0 && (
                        <ul
                          className="rpm-blocks"
                          aria-label={`Publish blockers for ${photo.venueName ?? venueName}`}
                        >
                          {missingPhotoEvidence(photo).map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {notice !== "" && (
        <p className="rpm-notice" aria-live="polite">
          {notice}
        </p>
      )}
      {(stage.isError ||
        saveMetadata.isError ||
        reorder.isError ||
        submit.isError ||
        publish.isError ||
        withdraw.isError ||
        remove.isError) && (
        <p role="alert" className="rpm-error">
          {failNotice(
            stage.error ??
              saveMetadata.error ??
              reorder.error ??
              submit.error ??
              publish.error ??
              withdraw.error ??
              remove.error,
          )}
        </p>
      )}
      <p className="rpm-hint">
        Destructive actions ask for confirmation first. Action buttons stay disabled while any photo
        request is in flight.
      </p>
    </div>
  );
}
