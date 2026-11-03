import { Link } from "@tanstack/react-router";
import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { MuseResearchStatus } from "@/components/research/muse-research-status";
import type { ResearchStatusState } from "@/components/research/muse-research-status";
import { researchCopyFor } from "@/components/research/research-copy";
import { ResearchFindingsList } from "@/components/research/research-findings";
import type { ResearchFinding } from "@/components/research/research-findings";
import { SharedSelectField } from "@/components/ui/select";
import { menuCopy, menuScanPageCopy } from "@/modules/restaurant-discovery/components/menu-copy";
import { parsePriceResearchOutcome } from "@/modules/restaurant-discovery/components/price-compare-panel";
import { ScanCapture } from "@/modules/restaurant-discovery/components/scan-capture";
import { classifyScanError, ScanError } from "@/modules/restaurant-discovery/components/scan-error";
import type { ScanPreviewPhoto } from "@/modules/restaurant-discovery/components/scan-photo-preview";
import {
  ScanProcessing,
  type ScanPhase,
} from "@/modules/restaurant-discovery/components/scan-processing";
import { ScanResults } from "@/modules/restaurant-discovery/components/scan-results";
import { menuBcp47TagFor } from "@/modules/restaurant-discovery/menu-presentation";
import {
  MenuScanClientError,
  menuScanClient,
  validateMenuFiles,
} from "@/modules/restaurant-discovery/menu-scan-client";
import type { ScanView } from "@/modules/restaurant-discovery/menu-scan-client";
import { menuLanguageSchema } from "@/modules/restaurant-discovery/menu-scan.schema";
import type { MenuScanDocument } from "@/modules/restaurant-discovery/menu-scan.schema";
import { getRestaurantFn } from "@/modules/restaurant-discovery/restaurant.functions";
import { researchPricesFn } from "@/server/web-research/research-functions";
import { localeSearchSchema, type Locale } from "@/shared/i18n";
import { isCurrency } from "@/shared/money";

const english = {
  eyebrow: "Powered by Muse ✨",
  title: "Scan a menu",
  subtitle: "Photograph a menu and read it in your language.",
  unknownRestaurant: "Unknown restaurant · adding it comes later.",
  analyzing: "Reading and translating your menu…",
  uploading: "Uploading menu photograph",
  restoring: "Checking your private scan…",
  loading: "Loading private scan…",
  delete: "Delete private scan",
  deleting: "Removing private access and scheduling photo deletion…",
  deleted:
    "Private access removed. Stored photos are deleted by retryable cleanup; this may take time.",
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
  scanningFor: "Scanning at {name}",
  removeBranch: "Remove restaurant association",
  returnToRestaurant: "Back to restaurant",
  returnToMuse: "Back to Muse",
  resultsTitle: "Menu results",
};

const vietnamese: typeof english = {
  eyebrow: "Powered by Muse ✨",
  title: "Quét thực đơn",
  subtitle: "Chụp thực đơn và đọc bằng ngôn ngữ của bạn.",
  unknownRestaurant: "Chưa rõ nhà hàng · thêm sau.",
  analyzing: "Đang đọc và dịch thực đơn…",
  uploading: "Đang tải ảnh thực đơn",
  restoring: "Đang kiểm tra bản quét riêng tư…",
  loading: "Đang tải bản quét riêng tư…",
  delete: "Xóa bản quét riêng tư",
  deleting: "Đang thu hồi truy cập và lên lịch xóa ảnh…",
  deleted:
    "Đã thu hồi truy cập riêng tư. Ảnh sẽ được xóa qua tác vụ có thể thử lại; việc này có thể cần thời gian.",
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
  scanningFor: "Đang quét tại {name}",
  removeBranch: "Gỡ liên kết nhà hàng",
  returnToRestaurant: "Về nhà hàng",
  returnToMuse: "Về Muse",
  resultsTitle: "Kết quả thực đơn",
};

type SelectedPhoto = { readonly id: string; readonly file: File; readonly previewUrl: string };

type RetryAction = "analyze" | "load" | "contribute" | "claim";

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

const storageTargetLanguage = "feastjourney:menu-target-language:v1";

const readStoredTargetLanguage = (): string | null => {
  try {
    return localStorage.getItem(storageTargetLanguage);
  } catch {
    return null;
  }
};

const rememberTargetLanguage = (language: string): void => {
  try {
    localStorage.setItem(storageTargetLanguage, language);
  } catch {
    return;
  }
};

/**
 * Per-dish public price research for private scan results. The single
 * research trigger on this page: one dish picker plus ONE lookup button, so
 * no competing research buttons share the screen. Only extracted dish TEXT
 * (names, variant labels, observed price currency) enters the lookup —
 * photographs never leave the scan, and the private image→Muse extraction
 * flow above is untouched. Findings render through the shared peer
 * components, stay in memory for future curator review, and are never
 * promoted to canonical price tables.
 */
function ScanPriceResearch({
  locale,
  items,
}: {
  readonly locale: string;
  readonly items: MenuScanDocument["items"];
}) {
  const language = locale === "vi" ? "vi" : "en";
  const strings = researchCopyFor(language);
  const copy = menuScanPageCopy(locale);
  const dishCopy = menuCopy(locale);
  const firstId = items[0]?.id ?? "";
  const [dishId, setDishId] = useState(firstId);
  const selected = items.find((item) => item.id === dishId) ?? items[0] ?? null;

  const selectedCurrency =
    selected?.variants
      .map((variant) => variant.price?.currency ?? null)
      .find((currency): currency is string => currency !== null && isCurrency(currency)) ?? "";

  const [currency, setCurrency] = useState(selectedCurrency);
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [state, setState] = useState<ResearchStatusState>("idle");
  const [contextLine, setContextLine] = useState("");
  const [findings, setFindings] = useState<ReadonlyArray<ResearchFinding>>([]);
  const runRef = useRef(0);

  const chooseDish = (id: string): void => {
    const next = items.find((item) => item.id === id);

    if (next === undefined) return;

    setDishId(id);

    const priced = next.variants
      .map((variant) => variant.price?.currency ?? null)
      .find((code): code is string => code !== null && isCurrency(code));

    if (priced !== undefined) setCurrency(priced);
  };

  const dismiss = (): void => {
    runRef.current += 1;
    setState("idle");
    setContextLine("");
    setFindings([]);
  };

  const fail = (message: string): void => {
    runRef.current += 1;
    setFindings([]);
    setContextLine(message);
    setState("failed");
  };

  const run = (): void => {
    if (selected === null) {
      fail(copy.researchNeedsDish);

      return;
    }

    const dishText =
      selected.originalName.trim() === "" ? (selected.translatedName ?? "") : selected.originalName;

    if (dishText.trim() === "") {
      fail(copy.researchNeedsDish);

      return;
    }

    if (city.trim() === "" || country.trim() === "") {
      fail(copy.researchNeedsPlace);

      return;
    }

    const trimmedCurrency = currency.trim().toUpperCase();

    if (trimmedCurrency !== "" && !isCurrency(trimmedCurrency)) {
      fail(copy.researchNeedsCurrency);

      return;
    }

    const portionLabel =
      selected.variants[0]?.translatedLabel ?? selected.variants[0]?.originalLabel ?? "";

    const runId = runRef.current + 1;

    runRef.current = runId;

    const alive = (): boolean => runRef.current === runId;

    setFindings([]);
    setContextLine(strings.statusSearching);
    setState("preparing");
    void (async () => {
      try {
        if (!alive()) return;

        setState("searching");

        const raw = await researchPricesFn({
          data: {
            dish: dishText,
            city: city.trim(),
            country: country.trim(),
            portion: portionLabel === "" ? undefined : portionLabel,
            currency: trimmedCurrency === "" ? undefined : trimmedCurrency,
            language,
          },
        });

        if (!alive()) return;

        setContextLine(strings.statusReviewing);
        setState("reviewing");

        const outcome = parsePriceResearchOutcome(raw);

        if (!alive()) return;

        if (outcome === null || outcome.tag === "ResearchUnavailable") {
          fail(strings.statusFailed);

          return;
        }

        if (outcome.tag === "ResearchFound" && outcome.findings.length > 0) {
          setFindings(outcome.findings);
          setContextLine(strings.statusCompleted);
          setState("completed");

          return;
        }

        setContextLine(strings.statusNoEvidence);
        setState("no-evidence");
      } catch {
        if (!alive()) return;

        fail(strings.statusFailed);
      }
    })();
  };

  return (
    <section className="scan-price-research" aria-label={copy.researchTitle}>
      <h2 className="font-display text-2xl">{copy.researchTitle}</h2>
      <p>{copy.researchHint}</p>
      <SharedSelectField
        id="scan-research-dish"
        label={copy.researchDish}
        value={selected?.id ?? ""}
        onValueChange={chooseDish}
        options={items.map((item) => ({
          label: item.translatedName ?? item.originalName,
          value: item.id,
        }))}
        size="regular"
      />
      <div className="scan-research-place">
        <div>
          <label htmlFor="scan-research-city">{copy.researchCity}</label>
          <input
            id="scan-research-city"
            type="text"
            autoComplete="address-level2"
            maxLength={100}
            placeholder={copy.researchCityPlaceholder}
            value={city}
            onChange={(event) => setCity(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="scan-research-country">{copy.researchCountry}</label>
          <input
            id="scan-research-country"
            type="text"
            autoComplete="country-name"
            maxLength={100}
            placeholder={copy.researchCountryPlaceholder}
            value={country}
            onChange={(event) => setCountry(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="scan-research-currency">{copy.researchCurrency}</label>
          <input
            id="scan-research-currency"
            type="text"
            autoComplete="off"
            maxLength={3}
            placeholder="VND"
            value={currency}
            onChange={(event) => setCurrency(event.target.value.trim().toUpperCase())}
          />
        </div>
      </div>
      <button
        type="button"
        className="menu-order-primary scan-research-trigger"
        disabled={state === "preparing" || state === "searching" || state === "reviewing"}
        onClick={run}
      >
        {dishCopy.compareNearbyPrices}
      </button>
      {state === "idle" ? null : (
        <>
          <MuseResearchStatus
            state={state}
            contextLine={contextLine}
            onRetry={run}
            onContinue={dismiss}
            retryLabel={strings.retryAction}
            continueLabel={strings.continueCatalogAction}
          />
          {state === "completed" && (
            <>
              <p className="mapapp-note">{copy.researchComparability}</p>
              <ResearchFindingsList
                findings={findings}
                badgeLabel={strings.webResultBadge}
                notVerifiedNote={strings.notVerifiedNote}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}

// S2 CONTRACT (scan-results): results body is the peer `ScanResults`
// component (`scan-results.tsx`), mounted with the scan id. `onEditDish` is
// intentionally omitted so dish edits open S2's internal corrections.
// Corrections saving therefore lives inside S2; this page keeps the
// surrounding chrome the peer does not render: revision/expiry line, model
// chip, price-research sibling (single-trigger rule), contribution, and
// session actions.

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function capturePhaseFor(
  active: boolean,
  isUploading: boolean,
  isReading: boolean,
): ScanPhase | null {
  if (!active) return null;

  if (isUploading) return "uploading";

  if (isReading) return "reading";

  return "preparing";
}

export function MenuScanPage({
  locale,
  venueId,
  userId,
  returnVenue,
  returnView = "menu",
}: {
  readonly locale: string;
  readonly venueId?: string;
  readonly userId?: string | null;
  readonly returnVenue?: string | undefined;
  readonly returnView?: "overview" | "menu" | "reviews" | "copilot" | undefined;
}) {
  const copy = locale === "vi" ? vietnamese : english;
  const pageCopy = menuScanPageCopy(locale);
  const owner = userId ?? "guest";

  // Route search is validated upstream, but this component accepts a plain
  // string prop: re-validate once so return links carry a genuine Locale
  // without a type assertion, falling back to English when unknown.
  const langParse = localeSearchSchema.shape.lang.safeParse(locale);
  const validatedLang: Locale = langParse.success ? langParse.data : "en";

  const [targetLanguage, setTargetLanguage] = useState(() => {
    const stored = readStoredTargetLanguage();
    const remembered = stored === null ? null : menuLanguageSchema.safeParse(stored);

    if (remembered !== null && remembered.success) return remembered.data;

    const parsed = menuLanguageSchema.safeParse(locale);

    return parsed.success ? parsed.data : "en";
  });

  const changeTargetLanguage = (value: string): void => {
    const parsed = menuLanguageSchema.safeParse(value);

    if (!parsed.success) return;

    setTargetLanguage(parsed.data);
    rememberTargetLanguage(parsed.data);
  };

  // Verified source identity for scans launched from a restaurant: the venue
  // name (never a raw UUID) with an explicit dissociation control. Direct
  // entry stays unknown; adding a restaurant is deferred, so there is no
  // manual UUID field on this page.
  const [verifiedBranch, setVerifiedBranch] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (venueId !== undefined && venueId !== "") {
      const parsed = z.uuid().safeParse(venueId);

      if (parsed.success) {
        void getRestaurantFn({ data: { venueId: parsed.data, channel: "dine_in" } }).then(
          (detail) => {
            if (!cancelled) setVerifiedBranch({ id: parsed.data, name: detail.venue.name });
          },
          () => {
            if (!cancelled) setVerifiedBranch(null);
          },
        );
      }
    }

    return () => {
      cancelled = true;
    };
  }, [venueId]);
  const [photos, setPhotos] = useState<ReadonlyArray<SelectedPhoto>>([]);
  const [view, setView] = useState<ScanView | null>(null);
  const [scanId, setScanId] = useState<string | null>(null);
  const [document, setDocument] = useState<MenuScanDocument | null>(null);
  const [consent, setConsent] = useState(false);
  const [claimCandidate, setClaimCandidate] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(copy.restoring);
  const [reading, setReading] = useState(false);
  const [failure, setFailure] = useState<ScanFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const previewUrls = useRef(new Set<string>());
  const submitGuard = useRef(false);
  const resultsHeading = useRef<HTMLHeadingElement | null>(null);
  const busy = status !== null;
  const uploading = uploadTotal > 0 && uploaded < uploadTotal;

  const adoptView = useCallback(
    (next: ScanView): void => {
      setView(next);
      setScanId(next.scan.id);
      setDocument(next.document);
      setConsent(false);
    },
    [setView, setScanId, setDocument, setConsent],
  );

  useEffect(() => {
    const urls = previewUrls.current;

    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  // Results enter at the reading position: scroll the results heading into
  // view and move focus there once per scan. Same-scan updates keep the
  // traveler's scroll position.
  const lastScrolledScan = useRef<string | null>(null);

  useEffect(() => {
    if (document === null || scanId === lastScrolledScan.current) return;

    lastScrolledScan.current = scanId;

    resultsHeading.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
    resultsHeading.current?.focus({ preventScroll: true });
  }, [document, scanId]);

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
      if (!abort.signal.aborted) {
        setStatus(null);
        setReading(false);
      }
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

  const removePhoto = (id: string): void => {
    setPhotos((previous) => {
      const target = previous.find((photo) => photo.id === id);

      if (target !== undefined) {
        URL.revokeObjectURL(target.previewUrl);
        previewUrls.current.delete(target.previewUrl);
      }

      return previous.filter((photo) => photo.id !== id);
    });
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
    if (submitGuard.current || busy) return;

    submitGuard.current = true;
    void runTask(
      copy.analyzing,
      async (signal) => {
        if (photos.length === 0) throw new Error(copy.empty);
        const branch = verifiedBranch === null ? null : verifiedBranch.id;

        try {
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

          setReading(true);
          setStatus(copy.analyzing);
          const next = await menuScanClient.extract(created.id, signal);

          if (!signal.aborted) adoptView(next);
        } finally {
          setReading(false);
        }
      },
      "analyze",
    ).finally(() => {
      submitGuard.current = false;
    });
  };

  const reloadScan = (): void => {
    if (scanId === null) return;
    void runTask(
      copy.loading,
      async (signal) => adoptView(await menuScanClient.get(scanId, signal)),
      "load",
    );
  };

  const submitContribution = (): void => {
    if (view === null || view.scan.current_revision === null || !consent) return;
    const revision = view.scan.current_revision;
    void runTask(
      copy.contributing,
      async (signal) => {
        const requestedVenue = verifiedBranch === null ? null : verifiedBranch.id;
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

  let retryAfterText: string | null = null;

  if (failure !== null && failure.retryable) {
    if (failure.retryAfterSeconds !== null)
      retryAfterText = pageCopy.failureRetryAfter.replace(
        "{seconds}",
        String(failure.retryAfterSeconds),
      );
    else retryAfterText = pageCopy.failureRetryNow;
  }

  // Retry is meaningful only for retryable server guidance, or for an
  // expired scan where the intact photos can start a fresh analysis.
  const canRetry =
    failure !== null && !busy && (failure.retryable || classifyScanError(failure) === "expired");

  const modelChip = scanModelChip(view === null ? view : view.revision);

  const capturePhase = capturePhaseFor(status !== null && document === null, uploading, reading);

  const previewPhotos: ReadonlyArray<ScanPreviewPhoto> = photos.map((photo) => ({
    id: photo.id,
    previewUrl: photo.previewUrl,
    name: photo.file.name,
  }));

  const submitHint = photos.length > 0 && !busy && scanId !== null ? copy.uploadRetry : null;

  return (
    <article className="menu-scan-page" lang={menuBcp47TagFor(locale)}>
      <header className="scan-hero">
        <p className="scan-eyebrow">{copy.eyebrow}</p>
        <h1 className="font-display">{copy.title}</h1>
        <p className="scan-subtitle">{copy.subtitle}</p>
      </header>
      {returnView === "copilot" && (
        <p className="scan-return">
          <Link
            to="/muse"
            search={{
              lang: validatedLang,
              task: scanId !== null ? "order" : "scan",
            }}
          >
            ← {copy.returnToMuse}
          </Link>
        </p>
      )}
      {returnVenue !== undefined && (
        <p className="scan-return">
          <Link
            to="/restaurants"
            search={{
              lang: validatedLang,
              venue: returnVenue,
              view: returnView === "copilot" ? "menu" : returnView,
            }}
          >
            ← {copy.returnToRestaurant}
          </Link>
        </p>
      )}
      {verifiedBranch !== null ? (
        <p className="scan-branch-chip" aria-live="polite">
          ✓ {copy.scanningFor.replace("{name}", verifiedBranch.name)}{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setVerifiedBranch(null);
            }}
          >
            {copy.removeBranch}
          </button>
        </p>
      ) : (
        <p className="scan-branch-unknown">{copy.unknownRestaurant}</p>
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
        <>
          <ScanCapture
            locale={locale}
            targetLanguage={targetLanguage}
            onTargetLanguageChange={changeTargetLanguage}
            photos={previewPhotos}
            onAddFiles={addPhotos}
            onRemovePhoto={removePhoto}
            onMovePhoto={movePhoto}
            busy={busy}
            submitDisabled={busy || photos.length === 0}
            submitHint={submitHint}
            onSubmit={analyze}
          />
          {capturePhase !== null && (
            <ScanProcessing
              phase={capturePhase}
              uploaded={uploaded}
              total={uploadTotal}
              locale={locale}
            />
          )}
          {failure !== null && (
            <ScanError
              error={failure}
              retryAfterText={retryAfterText}
              onRetry={canRetry ? retryFailure : undefined}
              locale={locale}
            />
          )}
          {status !== null && capturePhase === null && (
            <output className="scan-status" aria-live="polite">
              {status}
            </output>
          )}
        </>
      )}
      {view?.scan.status === "processing" && <p>{copy.processing}</p>}
      {scanId !== null && document !== null && (
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
                  setConsent(false);
                  setNotice(copy.deleted);
                },
                null,
              );
            }}
          >
            <Trash2 aria-hidden="true" /> {copy.delete}
          </button>
          {returnVenue !== undefined && (
            <Link
              className="scan-return-link"
              to="/restaurants"
              search={{
                lang: validatedLang,
                venue: returnVenue,
                view: returnView === "copilot" ? "menu" : returnView,
              }}
            >
              ← {copy.returnToRestaurant}
            </Link>
          )}
        </div>
      )}
      {document !== null && view !== null && (
        <section className="scan-results scan-enter" aria-labelledby="scan-results-title">
          <h2
            id="scan-results-title"
            ref={resultsHeading}
            tabIndex={-1}
            className="scan-results-title"
          >
            {copy.resultsTitle}
          </h2>
          {status === null && notice !== null && (
            <output className="scan-status" aria-live="polite">
              {notice}
            </output>
          )}
          {failure !== null && (
            <ScanError
              error={failure}
              retryAfterText={retryAfterText}
              onRetry={canRetry ? retryFailure : undefined}
              locale={locale}
            />
          )}
          <p className="scan-revision-line">
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
          <ScanResults scanId={view.scan.id} />
          {document.items.length > 0 && (
            <ScanPriceResearch locale={locale} items={document.items} />
          )}
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
                <label className="scan-consent">
                  <input
                    type="checkbox"
                    checked={consent}
                    disabled={busy}
                    onChange={(event) => setConsent(event.target.checked)}
                  />
                  {copy.consent}
                </label>
                <button type="button" disabled={busy || !consent} onClick={submitContribution}>
                  {copy.contribute}
                </button>
              </>
            )}
          </section>
        </section>
      )}
    </article>
  );
}
