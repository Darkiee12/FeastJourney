import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

export type ScanErrorKind =
  | "disabled"
  | "outage"
  | "rate-limited"
  | "auth"
  | "timeout"
  | "bad-image"
  | "expired"
  | "validation"
  | "conflict"
  | "unknown";

export interface ClassifiableScanError {
  readonly code: string | undefined;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Classify a scan failure into guidance families. Codes come from the real
 * server contract (`api-error.ts` trouble codes surfaced as `clientFailure`):
 * `unavailable` (503 ExtractionUnavailable/StorageUnavailable — disabled or
 * outage, told apart by `retryable`), `rate_limited` (429), `unauthenticated`
 * / `reauthentication_required` / `forbidden`, `invalid_image`,
 * `invalid_request`, `invalid_extraction`, `conflict`, `not_found` (expired
 * private scan). Timeouts arrive as retryable failures whose message names
 * the timeout.
 */
export function classifyScanError(error: ClassifiableScanError): ScanErrorKind {
  if (error.code === "not_found") return "expired";

  if (error.code === "conflict") return "conflict";

  if (
    error.code === "unauthenticated" ||
    error.code === "reauthentication_required" ||
    error.code === "forbidden"
  )
    return "auth";

  if (error.code === "rate_limited") return "rate-limited";

  if (error.code === "unavailable") return error.retryable ? "outage" : "disabled";

  if (error.code === "invalid_image") return "bad-image";

  if (error.code === "invalid_request" || error.code === "invalid_extraction") return "validation";

  if (error.retryable && /timed?\s?out/i.test(error.message)) return "timeout";

  return "unknown";
}

const hintFor = (kind: ScanErrorKind, locale: string): string | null => {
  const vi = locale === "vi";

  switch (kind) {
    case "disabled":
      return vi
        ? "Phân tích thực đơn hiện chưa được bật. Ảnh của bạn được giữ nguyên — thử lại sau."
        : "Menu analysis is not enabled right now. Your photos are kept — try again later.";

    case "outage":
      return vi
        ? "Dịch vụ phân tích đang gián đoạn. Ảnh của bạn được giữ nguyên."
        : "The analysis service is having trouble. Your photos are kept.";

    case "rate-limited":
      return vi
        ? "Quá nhiều yêu cầu. Chờ một chút rồi thử lại; ảnh của bạn được giữ nguyên."
        : "Too many requests. Wait a moment, then retry; your photos are kept.";

    case "auth":
      return vi
        ? "Phiên đăng nhập đã hết. Đăng nhập lại rồi thử tiếp."
        : "Your session expired. Sign in again, then continue.";

    case "timeout":
      return vi
        ? "Phân tích quá lâu. Thử lại với ít ảnh hơn hoặc ảnh nhẹ hơn."
        : "Analysis took too long. Retry with fewer or lighter photos.";

    case "bad-image":
      return vi
        ? "Ảnh không dùng được. Chụp lại rõ hơn: JPEG, PNG hoặc WebP, mỗi ảnh tối đa 8 MiB."
        : "That photo cannot be used. Retake it clearly: JPEG, PNG or WebP, up to 8 MiB each.";

    case "expired":
      return vi
        ? "Bản quét riêng tư này đã hết hạn. Bắt đầu phân tích mới với ảnh hiện tại."
        : "This private scan expired. Start a fresh analysis with the current photos.";

    case "validation":
      return vi
        ? "Kiểm tra ảnh và các trường đã đánh dấu, rồi sửa trước khi thử lại."
        : "Check the highlighted fields and photo limits, then correct them before retrying.";

    case "conflict":
      return vi
        ? "Thực đơn đã thay đổi. Tải lại trạng thái trước khi thử lại."
        : "The menu changed. Reload its status before trying again.";

    case "unknown":
      return null;
  }

  return null;
};

const retryLabelFor = (kind: ScanErrorKind, locale: string): string => {
  const vi = locale === "vi";

  if (kind === "expired") return vi ? "Phân tích lại" : "Analyze again";

  return vi ? "Thử lại" : "Retry";
};

/**
 * Compact contextual error near the action. Photos stay intact (pure
 * display, no side effects); the retry button renders only when the parent
 * passes a meaningful recovery (`onRetry`), never for terminal states.
 */
export function ScanError({
  error,
  retryAfterText,
  onRetry,
  locale,
}: {
  readonly error: ClassifiableScanError;
  readonly retryAfterText?: string | null | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly locale: string;
}): ReactNode {
  const kind = classifyScanError(error);
  const hint = hintFor(kind, locale);

  return (
    <div role="alert" className="scan-error">
      <p className="scan-error-message">
        <TriangleAlert aria-hidden="true" /> {error.message}
      </p>
      {hint === null ? null : <p className="scan-error-hint">{hint}</p>}
      {retryAfterText === null || retryAfterText === undefined ? null : (
        <p className="scan-error-hint">{retryAfterText}</p>
      )}
      {onRetry === undefined ? null : (
        <button type="button" className="scan-error-retry" onClick={onRetry}>
          {retryLabelFor(kind, locale)}
        </button>
      )}
    </div>
  );
}
