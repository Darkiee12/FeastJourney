import {
  Camera,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Images,
  LoaderCircle,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { InteractiveMenuView } from "@/modules/restaurant-discovery/components/interactive-menu";
import {
  menuLanguageNames,
  menuScanPageCopy,
} from "@/modules/restaurant-discovery/components/menu-copy";
import { ScanEditor } from "@/modules/restaurant-discovery/components/scan-editor";
import { presentScan } from "@/modules/restaurant-discovery/menu-presentation";
import {
  MenuScanClientError,
  menuScanClient,
  validateMenuFiles,
} from "@/modules/restaurant-discovery/menu-scan-client";
import type { ScanView } from "@/modules/restaurant-discovery/menu-scan-client";
import {
  menuLanguages,
  menuLanguageSchema,
  menuScanDocumentSchema,
} from "@/modules/restaurant-discovery/menu-scan.schema";
import type { MenuScanDocument } from "@/modules/restaurant-discovery/menu-scan.schema";
import { getRestaurantFn } from "@/modules/restaurant-discovery/restaurant.functions";

const english = {
  title: "Read the menu. Choose your meal.",
  introduction:
    "Photograph a menu, understand it in your language, then show your choices to the waiter. Guests are welcome.",
  privacy:
    "Personal scans stay private and expire after 24 hours on FeastJourney. Photos are sent to Meta for analysis in standard mode; Meta may retain them under its own terms. Contributing is optional and never publishes your photograph.",
  camera: "Take a menu photograph",
  gallery: "Choose menu photographs",
  cameraHelp:
    "If the camera is unavailable or permission is denied, choose images from your gallery. JPEG, PNG or WebP; up to 6 pages, 8 MiB each, 24 MiB together.",
  language: "Translate into",
  branch: "Restaurant branch ID (optional)",
  branchHelp:
    "Use an existing FeastJourney branch ID if known. Leave empty for an unknown restaurant.",
  branchCheck: "Check branch",
  branchUnknown: "No published branch uses this ID. Leave empty to scan an unknown restaurant.",
  pages: "Menu pages",
  earlier: "Move earlier",
  later: "Move later",
  removePhoto: "Remove photograph",
  analyze: "Analyze menu",
  retry: "Start a new analysis",
  analyzing: "Reading and translating your menu…",
  uploading: "Uploading menu photograph",
  restoring: "Checking your private scan…",
  loading: "Loading private scan…",
  saving: "Saving a new revision…",
  delete: "Delete private scan",
  deleting: "Removing private access and scheduling photo deletion…",
  deleted:
    "Private access removed. Stored photos are deleted by retryable cleanup; this may take time.",
  save: "Save corrections",
  unsaved: "Your corrections are visible now. Save them before contributing.",
  sourceLanguage: "Confirm the original menu language",
  unknown: "Unknown",
  empty: "Add at least one clear menu photograph to begin.",
  uploadRetry:
    "Retrying starts a fresh scan and removes the previous attempt from your private view.",
  refresh: "Reload scan status",
  processing: "This scan is being processed. Reload its status before starting another analysis.",
  contributeTitle: "Help the next traveler",
  contributeHelp:
    "You can send this saved revision and its private photographs to FeastJourney curators. Photos and scan drafts are kept for up to 30 days, including after approval. Reviewed menu facts and audit records may remain after those private files are deleted. Your photograph is never published. Personal use works without contributing.",
  consent:
    "I agree to submit this exact saved revision and private evidence for curator review under menu-facts-v1.",
  contribute: "Contribute saved menu",
  contributing: "Submitting your contribution for private review…",
  contributed: "Contribution status",
  revision: "Saved revision",
  expired: "Private scan expires",
  claim: "Keep my previous guest scan in this account",
  claimHelp:
    "A guest scan was created in this browser before sign-in. Choose whether to move it into this account.",
  claiming: "Moving the guest scan into your account…",
  failure: "This request could not be completed. Check your connection and retry.",
};

const vietnamese: typeof english = {
  title: "Hiểu thực đơn. Chọn món ngon.",
  introduction:
    "Chụp thực đơn, đọc bằng ngôn ngữ của bạn, rồi đưa lựa chọn cho nhân viên xem. Không cần đăng ký.",
  privacy:
    "Bản quét cá nhân luôn riêng tư và hết hạn sau 24 giờ trên FeastJourney. Ảnh được gửi cho Meta để phân tích ở chế độ tiêu chuẩn; Meta có thể lưu ảnh theo điều khoản riêng. Đóng góp là tùy chọn và không công khai ảnh.",
  camera: "Chụp ảnh thực đơn",
  gallery: "Chọn ảnh thực đơn",
  cameraHelp:
    "Nếu không dùng được camera hoặc bị từ chối quyền, hãy chọn ảnh từ thư viện. JPEG, PNG hoặc WebP; tối đa 6 trang, mỗi ảnh 8 MiB, tổng 24 MiB.",
  language: "Dịch sang",
  branch: "Mã chi nhánh nhà hàng (không bắt buộc)",
  branchHelp: "Dùng mã chi nhánh FeastJourney có sẵn nếu biết. Để trống nếu chưa rõ nhà hàng.",
  branchCheck: "Kiểm tra chi nhánh",
  branchUnknown:
    "Không có chi nhánh đã công bố nào dùng mã này. Để trống để quét thực đơn chưa rõ.",
  pages: "Các trang thực đơn",
  earlier: "Chuyển lên trước",
  later: "Chuyển ra sau",
  removePhoto: "Xóa ảnh đã chọn",
  analyze: "Phân tích thực đơn",
  retry: "Bắt đầu phân tích mới",
  analyzing: "Đang đọc và dịch thực đơn…",
  uploading: "Đang tải ảnh thực đơn",
  restoring: "Đang kiểm tra bản quét riêng tư…",
  loading: "Đang tải bản quét riêng tư…",
  saving: "Đang lưu phiên bản mới…",
  delete: "Xóa bản quét riêng tư",
  deleting: "Đang thu hồi truy cập và lên lịch xóa ảnh…",
  deleted:
    "Đã thu hồi truy cập riêng tư. Ảnh sẽ được xóa qua tác vụ có thể thử lại; việc này có thể cần thời gian.",
  save: "Lưu bản sửa",
  unsaved: "Bản sửa hiển thị ngay. Hãy lưu trước khi đóng góp.",
  sourceLanguage: "Xác nhận ngôn ngữ gốc của thực đơn",
  unknown: "Chưa rõ",
  empty: "Thêm ít nhất một ảnh thực đơn rõ nét để bắt đầu.",
  uploadRetry: "Thử lại sẽ tạo bản quét mới và thu hồi truy cập riêng tư của lần trước.",
  refresh: "Tải lại trạng thái",
  processing: "Bản quét đang được xử lý. Tải lại trạng thái trước khi phân tích lần nữa.",
  contributeTitle: "Giúp người du lịch tiếp theo",
  contributeHelp:
    "Bạn có thể gửi đúng phiên bản đã lưu và ảnh riêng tư cho người duyệt FeastJourney. Ảnh và bản quét được giữ tối đa 30 ngày, kể cả sau khi duyệt. Thông tin thực đơn đã duyệt và hồ sơ kiểm tra có thể được giữ sau khi xóa tệp riêng tư. Ảnh không bao giờ được công khai. Không cần đóng góp để dùng cá nhân.",
  consent:
    "Tôi đồng ý gửi đúng phiên bản đã lưu và bằng chứng riêng tư này để xem xét theo menu-facts-v1.",
  contribute: "Đóng góp thực đơn đã lưu",
  contributing: "Đang gửi đóng góp riêng tư để xem xét…",
  contributed: "Trạng thái đóng góp",
  revision: "Phiên bản đã lưu",
  expired: "Bản quét riêng tư hết hạn",
  claim: "Lưu bản quét của khách trước đó vào tài khoản này",
  claimHelp:
    "Một bản quét khách đã được tạo trong trình duyệt này trước khi đăng nhập. Bạn có thể chuyển bản quét vào tài khoản này.",
  claiming: "Đang chuyển bản quét vào tài khoản…",
  failure: "Không thể hoàn thành yêu cầu. Kiểm tra kết nối và thử lại.",
};

type SelectedPhoto = { readonly id: string; readonly file: File; readonly previewUrl: string };

type RetryAction = "analyze" | "load" | "save" | "contribute" | "claim";

interface ScanFailure {
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly action: RetryAction | null;
  readonly code: string | undefined;
}

export type ScanFailureKind = "validation" | "conflict" | "auth" | "expired";

/** Map a server failure code to the guidance family. Retryable codes need no family. */
export function scanFailureKind(code: string | undefined): ScanFailureKind | null {
  if (code === "invalid_request" || code === "invalid_image" || code === "invalid_extraction")
    return "validation";

  if (code === "conflict") return "conflict";

  if (code === "unauthenticated" || code === "reauthentication_required") return "auth";

  if (code === "not_found") return "expired";

  return null;
}

/**
 * Read-only model chip from the scan revision view. The view is the only
 * source; when the revision carries no model (e.g. customer revisions),
 * this returns null and the page renders nothing instead of inventing a value.
 */
export function scanModelChip(
  revision: {
    readonly number: number;
    readonly model: string | null;
  } | null,
): { readonly model: string; readonly revision: number } | null {
  if (revision === null) return null;

  const parsed = z.string().min(1).safeParse(revision.model);

  if (!parsed.success) return null;

  return { model: parsed.data, revision: revision.number };
}

const storageOwner = "feastjourney:menu-scan-owner:v1";

const storageScan = "feastjourney:menu-scan:v1";

/** Branch IDs are backend concepts: confirm the typed ID against the published venue before use. */
function BranchField({
  id,
  value,
  onChange,
  disabled,
  copy,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly copy: typeof english;
}) {
  const [lookup, setLookup] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  return (
    <>
      <label htmlFor={id}>{copy.branch}</label>
      <input
        id={id}
        value={value}
        disabled={disabled}
        maxLength={36}
        aria-describedby={`${id}-help`}
        onChange={(event) => {
          setLookup(null);
          onChange(event.target.value);
        }}
      />
      <button
        type="button"
        disabled={disabled || checking || value === ""}
        onClick={() => {
          const parsed = z.uuid().safeParse(value);

          if (!parsed.success) {
            setLookup(copy.branchUnknown);

            return;
          }

          setChecking(true);
          setLookup(null);
          void getRestaurantFn({ data: { venueId: parsed.data, channel: "dine_in" } })
            .then(
              (detail) => setLookup(detail.venue.name),
              () => setLookup(copy.branchUnknown),
            )
            .finally(() => setChecking(false));
        }}
      >
        {copy.branchCheck}
      </button>
      <p id={`${id}-help`}>{copy.branchHelp}</p>
      {lookup !== null && (
        <output aria-live="polite">{lookup === copy.branchUnknown ? lookup : `✓ ${lookup}`}</output>
      )}
    </>
  );
}

/** Honest per-photo upload state from the observable attach count. No staged reads. */
function PhotoUploadState({
  index,
  uploaded,
  uploading,
  copy,
}: {
  readonly index: number;
  readonly uploaded: number;
  readonly uploading: boolean;
  readonly copy: ReturnType<typeof menuScanPageCopy>;
}) {
  if (index < uploaded)
    return (
      <>
        <CircleCheck aria-hidden="true" /> {copy.photoUploaded}
      </>
    );

  if (index === uploaded && uploading)
    return (
      <>
        <LoaderCircle aria-hidden="true" /> {copy.photoUploading}
      </>
    );

  return copy.photoWaiting;
}

export function MenuScanPage({
  locale,
  venueId,
  userId,
}: {
  readonly locale: string;
  readonly venueId?: string;
  readonly userId?: string | null;
}) {
  const copy = locale === "vi" ? vietnamese : english;
  const pageCopy = menuScanPageCopy(locale);
  const owner = userId ?? "guest";

  const [targetLanguage, setTargetLanguage] = useState(() => {
    const parsed = menuLanguageSchema.safeParse(locale);

    return parsed.success ? parsed.data : "en";
  });

  const [branchId, setBranchId] = useState(venueId ?? "");
  const [photos, setPhotos] = useState<ReadonlyArray<SelectedPhoto>>([]);
  const [view, setView] = useState<ScanView | null>(null);
  const [scanId, setScanId] = useState<string | null>(null);
  const [document, setDocument] = useState<MenuScanDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [consent, setConsent] = useState(false);
  const [claimCandidate, setClaimCandidate] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(copy.restoring);
  const [failure, setFailure] = useState<ScanFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const previewUrls = useRef(new Set<string>());
  const busy = status !== null;
  const uploading = uploadTotal > 0 && uploaded < uploadTotal;

  const adoptView = useCallback(
    (next: ScanView): void => {
      setView(next);
      setScanId(next.scan.id);
      setDocument(next.document);
      setDirty(false);
      setConsent(false);
    },
    [setView, setScanId, setDocument, setDirty, setConsent],
  );

  useEffect(() => {
    const urls = previewUrls.current;

    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;

    const restore = async (): Promise<void> => {
      try {
        const previousOwner = sessionStorage.getItem(storageOwner);
        const remembered = sessionStorage.getItem(storageScan);
        sessionStorage.setItem(storageOwner, owner);

        if (previousOwner !== owner) {
          sessionStorage.removeItem(storageScan);

          if (previousOwner === "guest" && owner !== "guest") setClaimCandidate(remembered);

          return;
        }

        if (remembered === null) return;
        const next = await menuScanClient.get(remembered, abort.signal);

        if (abort.signal.aborted) return;
        adoptView(next);
      } catch (error) {
        if (!abort.signal.aborted)
          setFailure({
            message: error instanceof Error ? error.message : copy.failure,
            retryable: error instanceof MenuScanClientError ? error.retryable : false,
            retryAfterSeconds:
              error instanceof MenuScanClientError ? error.retryAfterSeconds : null,
            action: null,
            code: error instanceof MenuScanClientError ? error.failure?.code : undefined,
          });
      } finally {
        if (!abort.signal.aborted) setStatus(null);
      }
    };

    void restore();

    return () => {
      // Cancel whatever this page started: the restore above or a task
      // installed in controller.current by runTask.
      abort.abort();
      controller.current?.abort();
    };
  }, [owner, adoptView, copy.failure]);

  const runTask = async (
    label: string,
    task: (signal: AbortSignal) => Promise<void>,
    retryAction: RetryAction | null,
  ): Promise<void> => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setStatus(label);
    setFailure(null);
    setNotice(null);

    try {
      await task(abort.signal);
    } catch (error) {
      if (abort.signal.aborted) return;
      const retryable = error instanceof MenuScanClientError && error.retryable;
      setFailure({
        message: error instanceof Error ? error.message : copy.failure,
        retryable,
        retryAfterSeconds: error instanceof MenuScanClientError ? error.retryAfterSeconds : null,
        action: retryable ? retryAction : null,
        code: error instanceof MenuScanClientError ? error.failure?.code : "invalid_request",
      });
    } finally {
      if (!abort.signal.aborted) setStatus(null);
    }
  };

  const addPhotos = (files: FileList | null): void => {
    if (files === null) return;
    const selected = [...files];
    const rejected = validateMenuFiles([...photos.map((photo) => photo.file), ...selected]);

    if (rejected !== null) {
      setFailure({
        message: rejected,
        retryable: false,
        retryAfterSeconds: null,
        action: null,
        code: "invalid_request",
      });

      return;
    }

    setFailure(null);
    setPhotos((previous) => [
      ...previous,
      ...selected.map((file) => {
        const previewUrl = URL.createObjectURL(file);
        previewUrls.current.add(previewUrl);

        return { id: crypto.randomUUID(), file, previewUrl };
      }),
    ]);
  };

  const movePhoto = (id: string, direction: -1 | 1): void =>
    setPhotos((previous) => {
      const next = [...previous];
      const index = next.findIndex((photo) => photo.id === id);
      const source = next[index];
      const destination = next[index + direction];

      if (source === undefined || destination === undefined) return previous;
      next[index] = destination;
      next[index + direction] = source;

      return next;
    });

  const analyze = (): void => {
    void runTask(
      copy.analyzing,
      async (signal) => {
        if (photos.length === 0) throw new Error(copy.empty);
        const branch = branchId === "" ? null : z.uuid().parse(branchId);

        if (scanId !== null) await menuScanClient.remove(scanId, signal);
        const created = await menuScanClient.create({ targetLanguage, venueId: branch }, signal);
        setScanId(created.id);
        sessionStorage.setItem(storageScan, created.id);
        sessionStorage.setItem(storageOwner, owner);

        setUploaded(0);
        setUploadTotal(photos.length);

        for (const [index, photo] of photos.entries()) {
          setStatus(`${copy.uploading} ${index + 1}/${photos.length}`);
          // oxlint-disable-next-line no-await-in-loop -- Photos upload in page order so progress matches the visible list.
          await menuScanClient.attach(created.id, index + 1, photo.file, signal);
          setUploaded(index + 1);
        }

        setStatus(copy.analyzing);
        const next = await menuScanClient.extract(created.id, signal);

        if (!signal.aborted) adoptView(next);
      },
      "analyze",
    );
  };

  const reloadScan = (): void => {
    if (scanId === null) return;
    void runTask(
      copy.loading,
      async (signal) => adoptView(await menuScanClient.get(scanId, signal)),
      "load",
    );
  };

  const saveRevision = (): void => {
    if (document === null || view?.scan.current_revision === null || view === null) return;
    const expectedRevision = view.scan.current_revision;
    const parsed = menuScanDocumentSchema.safeParse(document);

    if (!parsed.success) {
      setFailure({
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
        retryable: false,
        retryAfterSeconds: null,
        action: null,
        code: "invalid_request",
      });

      return;
    }

    void runTask(
      copy.saving,
      async (signal) =>
        adoptView(
          await menuScanClient.revise(
            { scanId: view.scan.id, expectedRevision, document: parsed.data },
            signal,
          ),
        ),
      "save",
    );
  };

  const submitContribution = (): void => {
    if (view === null || view.scan.current_revision === null || !consent || dirty) return;
    const revision = view.scan.current_revision;
    void runTask(
      copy.contributing,
      async (signal) => {
        const requestedVenue = branchId === "" ? null : z.uuid().parse(branchId);
        await menuScanClient.contribute(
          {
            scanId: view.scan.id,
            revision,
            consent: true,
            termsVersion: "menu-facts-v1",
            venueId: requestedVenue,
          },
          signal,
        );
        adoptView(await menuScanClient.get(view.scan.id, signal));
      },
      "contribute",
    );
  };

  const retryFailure = (): void => {
    if (failure?.action === "analyze") analyze();

    if (failure?.action === "load") reloadScan();

    if (failure?.action === "save") saveRevision();

    if (failure?.action === "contribute") submitContribution();

    if (failure?.action === "claim" && claimCandidate !== null) {
      void runTask(
        copy.claiming,
        async (signal) => {
          const next = await menuScanClient.claim(claimCandidate, signal);
          sessionStorage.setItem(storageScan, next.scan.id);
          sessionStorage.setItem(storageOwner, owner);
          adoptView(next);
          setClaimCandidate(null);
        },
        "claim",
      );
    }
  };

  const guidanceKind = failure === null ? null : scanFailureKind(failure.code);

  let guidance: string | null = null;

  if (guidanceKind === "validation") guidance = pageCopy.failureValidation;

  if (guidanceKind === "conflict") guidance = pageCopy.failureConflict;

  if (guidanceKind === "auth") guidance = pageCopy.failureAuth;

  let retryAfterText: string | null = null;

  if (failure !== null && failure.retryable) {
    if (failure.retryAfterSeconds !== null)
      retryAfterText = pageCopy.failureRetryAfter.replace(
        "{seconds}",
        String(failure.retryAfterSeconds),
      );
    else retryAfterText = pageCopy.failureRetryNow;
  }

  const modelChip = scanModelChip(view === null ? null : view.revision);

  return (
    <article className="menu-scan-page" lang={locale === "vi" ? "vi" : "en"}>
      <header className="scan-intro">
        <h1 className="font-display text-4xl">{copy.title}</h1>
        <p>{copy.introduction}</p>
      </header>
      <p className="scan-privacy">{pageCopy.privacyShort}</p>
      <details className="scan-privacy-details">
        <summary>{pageCopy.privacyDetailsLabel}</summary>
        <p>
          {copy.privacy}{" "}
          <a href="https://dev.meta.ai/legal/terms-of-service" target="_blank" rel="noreferrer">
            Meta terms
          </a>
        </p>
      </details>
      {failure !== null && (
        <div role="alert" className="scan-failure">
          <p>
            <TriangleAlert aria-hidden="true" /> {failure.message}
          </p>
          {failure.retryable && <p>{pageCopy.failureRetryable}</p>}
          {guidance !== null && <p>{guidance}</p>}
          {retryAfterText !== null && <p>{retryAfterText}</p>}
          {failure.retryable && failure.action !== null && (
            <button type="button" onClick={retryFailure}>
              <RefreshCw aria-hidden="true" /> {pageCopy.retryAction}
            </button>
          )}
        </div>
      )}
      {status !== null && (
        <div className="scan-progress" aria-busy="true">
          <output aria-live="polite">
            {busy && <LoaderCircle aria-hidden="true" />} {status}
          </output>
          {uploading && (
            <>
              <progress value={uploaded} max={uploadTotal} aria-label={pageCopy.uploadProgress} />
              <p aria-live="polite">
                {pageCopy.uploadProgress}: {uploaded}/{uploadTotal}
              </p>
            </>
          )}
          {!uploading && uploadTotal > 0 && status === copy.analyzing && (
            <p aria-live="polite">{pageCopy.stageAnalyzing}</p>
          )}
        </div>
      )}
      {status === null && notice !== null && (
        <output className="scan-status" aria-live="polite">
          {notice}
        </output>
      )}
      {claimCandidate !== null && (
        <section className="scan-claim">
          <p>{copy.claimHelp}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void runTask(
                copy.claiming,
                async (signal) => {
                  const next = await menuScanClient.claim(claimCandidate, signal);
                  sessionStorage.setItem(storageScan, next.scan.id);
                  sessionStorage.setItem(storageOwner, owner);
                  adoptView(next);
                  setClaimCandidate(null);
                },
                "claim",
              );
            }}
          >
            {copy.claim}
          </button>
        </section>
      )}
      {document === null && (
        <section className="scan-sheet" aria-label={pageCopy.sheetTitle} aria-busy={busy}>
          <h2>{pageCopy.sheetTitle}</h2>
          <p>{pageCopy.sheetHint}</p>
          <div className="scan-sheet-actions">
            <div className="scan-camera-action">
              <label htmlFor="scan-camera">
                <Camera aria-hidden="true" /> {copy.camera}
              </label>
              <input
                id="scan-camera"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                disabled={busy}
                aria-describedby="scan-camera-help"
                onChange={(event) => {
                  addPhotos(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>
            <div className="scan-gallery-action">
              <label htmlFor="scan-gallery">
                <Images aria-hidden="true" /> {copy.gallery}
              </label>
              <input
                id="scan-gallery"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                disabled={busy}
                aria-describedby="scan-camera-help"
                onChange={(event) => {
                  addPhotos(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>
          </div>
          <p id="scan-camera-help">{copy.cameraHelp}</p>
          <label htmlFor="scan-target-language">{copy.language}</label>
          <select
            id="scan-target-language"
            value={targetLanguage}
            disabled={busy}
            onChange={(event) => setTargetLanguage(menuLanguageSchema.parse(event.target.value))}
          >
            {menuLanguages.map((language) => (
              <option key={language} value={language}>
                {menuLanguageNames.get(language)}
              </option>
            ))}
          </select>
          <BranchField
            id="scan-branch"
            value={branchId}
            onChange={setBranchId}
            disabled={busy}
            copy={copy}
          />
          <ol className="scan-photo-list" aria-label={copy.pages}>
            {photos.map((photo, index) => (
              <li key={photo.id}>
                <img src={photo.previewUrl} alt={`${copy.pages} ${index + 1}`} />
                <p>
                  {index + 1}. {photo.file.name}
                </p>
                {uploadTotal > 0 && (
                  <p className="scan-photo-state">
                    <PhotoUploadState
                      index={index}
                      uploaded={uploaded}
                      uploading={uploading}
                      copy={pageCopy}
                    />
                  </p>
                )}
                <div className="scan-photo-actions">
                  <button
                    type="button"
                    disabled={busy || index === 0}
                    onClick={() => movePhoto(photo.id, -1)}
                    aria-label={`${copy.earlier}: ${index + 1}`}
                  >
                    <ChevronUp aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={busy || index === photos.length - 1}
                    onClick={() => movePhoto(photo.id, 1)}
                    aria-label={`${copy.later}: ${index + 1}`}
                  >
                    <ChevronDown aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      URL.revokeObjectURL(photo.previewUrl);
                      previewUrls.current.delete(photo.previewUrl);
                      setPhotos((previous) => previous.filter((entry) => entry.id !== photo.id));
                    }}
                  >
                    <X aria-hidden="true" /> {copy.removePhoto}
                  </button>
                </div>
              </li>
            ))}
          </ol>
          {photos.length === 0 && <p>{copy.empty}</p>}
          {scanId !== null && <p>{copy.uploadRetry}</p>}
          <div className="scan-actionbar">
            <button
              type="button"
              className="menu-order-primary"
              disabled={busy || photos.length === 0}
              onClick={analyze}
            >
              {scanId === null ? copy.analyze : copy.retry}
            </button>
          </div>
        </section>
      )}
      {view?.scan.status === "processing" && <p>{copy.processing}</p>}
      {scanId !== null && (
        <div className="scan-session-actions">
          <button type="button" disabled={busy} onClick={reloadScan}>
            <RefreshCw aria-hidden="true" /> {copy.refresh}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void runTask(
                copy.deleting,
                async (signal) => {
                  await menuScanClient.remove(scanId, signal);
                  sessionStorage.removeItem(storageScan);
                  setScanId(null);
                  setView(null);
                  setDocument(null);
                  setDirty(false);
                  setConsent(false);
                  setNotice(copy.deleted);
                },
                null,
              );
            }}
          >
            <Trash2 aria-hidden="true" /> {copy.delete}
          </button>
        </div>
      )}
      {document !== null && view !== null && (
        <>
          <p>
            {copy.revision}: {view.scan.current_revision} · {copy.expired}:{" "}
            <time dateTime={view.scan.expires_at}>
              {new Date(view.scan.expires_at).toLocaleString(locale)}
            </time>
          </p>
          {modelChip !== null && (
            <p className="scan-model-chip">
              {pageCopy.modelLabel}: {modelChip.model} · rev {modelChip.revision}
            </p>
          )}
          <InteractiveMenuView
            key={`${owner}:${view.scan.id}`}
            menu={presentScan(document, view.scan.venue_name)}
            locale={locale}
            photoUrl={(assetId) => `/api/menu-scans?scanId=${view.scan.id}&assetId=${assetId}`}
          />
          <details className="scan-corrections">
            <summary>
              {locale === "vi" ? "Kiểm tra hoặc sửa thông tin" : "Check or correct the extraction"}
            </summary>
            <label htmlFor="scan-source-language">{copy.sourceLanguage}</label>
            <select
              id="scan-source-language"
              value={document.sourceLanguage ?? ""}
              disabled={busy}
              onChange={(event) => {
                setDocument({
                  ...document,
                  sourceLanguage:
                    event.target.value === "" ? null : menuLanguageSchema.parse(event.target.value),
                  orderIntroduction: { original: null, translated: null },
                });
                setDirty(true);
                setConsent(false);
              }}
            >
              <option value="">{copy.unknown}</option>
              {menuLanguages.map((language) => (
                <option key={language} value={language}>
                  {menuLanguageNames.get(language)}
                </option>
              ))}
            </select>
            <ScanEditor
              document={document}
              onChange={(next) => {
                setDocument(next);
                setDirty(true);
                setConsent(false);
              }}
            />
            {dirty && <output>{copy.unsaved}</output>}
            <button type="button" disabled={busy || !dirty} onClick={saveRevision}>
              {copy.save}
            </button>
          </details>
          <section className="scan-contribution">
            <h2 className="font-display text-3xl">{copy.contributeTitle}</h2>
            {view.contribution !== null && (
              <p>
                {copy.contributed}: {view.contribution.status} · {copy.revision}{" "}
                {view.contribution.revision}
              </p>
            )}
            {view.contribution?.status === "rejected" && (
              <p>
                {locale === "vi"
                  ? "Bạn có thể sửa thực đơn, lưu phiên bản mới rồi tự chọn đóng góp lại."
                  : "You can correct the menu, save a new revision, then choose whether to contribute again."}
              </p>
            )}
            {(view.contribution === null ||
              (view.contribution.status === "rejected" &&
                view.scan.current_revision !== null &&
                view.scan.current_revision > view.contribution.revision)) && (
              <>
                <p>{copy.contributeHelp}</p>
                <BranchField
                  id="scan-contribution-branch"
                  value={branchId}
                  onChange={setBranchId}
                  disabled={busy}
                  copy={copy}
                />
                <label className="scan-consent">
                  <input
                    type="checkbox"
                    checked={consent}
                    disabled={busy || dirty}
                    onChange={(event) => setConsent(event.target.checked)}
                  />
                  {copy.consent}
                </label>
                <button
                  type="button"
                  disabled={busy || !consent || dirty}
                  onClick={submitContribution}
                >
                  {copy.contribute}
                </button>
              </>
            )}
          </section>
        </>
      )}
    </article>
  );
}
