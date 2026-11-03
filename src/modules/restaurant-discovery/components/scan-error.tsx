import { Match } from "effect";
import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { scanTransportCopy } from "@/modules/restaurant-discovery/components/menu-copy";

/**
 * Browser-transport failure union (Lane BT `ScanTransportFailure` contract).
 * Declared here as the render-side mirror: BT owns the client decoder, this
 * file owns the EN/VI mapping. Kind literals are frozen by the coordinator —
 * `transport-unavailable | unexpected-response | unavailable | too-slow |
 * rate-limited | unauthorized | not-found | invalid-input | empty`.
 */
export type ScanTransportKind =
  | "transport-unavailable"
  | "unexpected-response"
  | "unavailable"
  | "too-slow"
  | "rate-limited"
  | "unauthorized"
  | "not-found"
  | "invalid-input"
  | "empty";

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

/**
 * Map a frozen transport kind to its safe localized message. Never renders
 * raw errors (no SyntaxError, no HTML error-page content). The closed
 * ScanTransportKind union plus Match.exhaustive replaces the old fallback:
 * a new kind fails typecheck here instead of silently degrading.
 */
export function transportMessageFor(kind: ScanTransportKind, locale: string): string {
  const copy = scanTransportCopy(locale);

  return Match.value(kind).pipe(
    Match.when("transport-unavailable", () => copy.transportUnavailable),
    Match.when("unexpected-response", () => copy.unexpectedResponse),
    Match.when("unavailable", () => copy.serviceUnavailable),
    Match.when("too-slow", () => copy.tooSlow),
    Match.when("rate-limited", () => copy.rateLimited),
    Match.when("unauthorized", () => copy.unauthorized),
    Match.when("not-found", () => copy.notFound),
    Match.when("invalid-input", () => copy.invalidInput),
    Match.when("empty", () => copy.emptyResponse),
    Match.exhaustive,
  );
}

/**
 * Transport kinds that keep the traveler's photos and can be retried.
 * Auth, not-found (expired) and invalid-input need a different action
 * first, so they are not blindly retried.
 */
export function transportRetryable(kind: ScanTransportKind): boolean {
  return Match.value(kind).pipe(
    Match.when("unauthorized", () => false),
    Match.when("not-found", () => false),
    Match.when("invalid-input", () => false),
    Match.when("transport-unavailable", () => true),
    Match.when("unexpected-response", () => true),
    Match.when("unavailable", () => true),
    Match.when("too-slow", () => true),
    Match.when("rate-limited", () => true),
    Match.when("empty", () => true),
    Match.exhaustive,
  );
}

const hintFor = (kind: ScanErrorKind, locale: string): string | null => {
  const vi = locale === "vi";

  return Match.value(kind).pipe(
    Match.when("disabled", () =>
      vi
        ? "Phân tích thực đơn hiện chưa được bật. Ảnh của bạn được giữ nguyên — thử lại sau."
        : "Menu analysis is not enabled right now. Your photos are kept — try again later.",
    ),
    Match.when("outage", () =>
      vi
        ? "Dịch vụ phân tích đang gián đoạn. Ảnh của bạn được giữ nguyên."
        : "The analysis service is having trouble. Your photos are kept.",
    ),
    Match.when("rate-limited", () =>
      vi
        ? "Quá nhiều yêu cầu. Chờ một chút rồi thử lại; ảnh của bạn được giữ nguyên."
        : "Too many requests. Wait a moment, then retry; your photos are kept.",
    ),
    Match.when("auth", () =>
      vi
        ? "Phiên đăng nhập đã hết. Đăng nhập lại rồi thử tiếp."
        : "Your session expired. Sign in again, then continue.",
    ),
    Match.when("timeout", () =>
      vi
        ? "Phân tích quá lâu. Thử lại với ít ảnh hơn hoặc ảnh nhẹ hơn."
        : "Analysis took too long. Retry with fewer or lighter photos.",
    ),
    Match.when("bad-image", () =>
      vi
        ? "Ảnh không dùng được. Chụp lại rõ hơn: JPEG, PNG hoặc WebP, mỗi ảnh tối đa 8 MiB."
        : "That photo cannot be used. Retake it clearly: JPEG, PNG or WebP, up to 8 MiB each.",
    ),
    Match.when("expired", () =>
      vi
        ? "Bản quét riêng tư này đã hết hạn. Bắt đầu phân tích mới với ảnh hiện tại."
        : "This private scan expired. Start a fresh analysis with the current photos.",
    ),
    Match.when("validation", () =>
      vi
        ? "Kiểm tra ảnh và các trường đã đánh dấu, rồi sửa trước khi thử lại."
        : "Check the highlighted fields and photo limits, then correct them before retrying.",
    ),
    Match.when("conflict", () =>
      vi
        ? "Thực đơn đã thay đổi. Tải lại trạng thái trước khi thử lại."
        : "The menu changed. Reload its status before trying again.",
    ),
    Match.when("unknown", () => null),
    Match.exhaustive,
  );
};

const retryLabelFor = (kind: ScanErrorKind, locale: string): string => {
  const vi = locale === "vi";

  return Match.value(kind).pipe(
    Match.when("expired", () => (vi ? "Phân tích lại" : "Analyze again")),
    Match.when("disabled", () => (vi ? "Thử lại" : "Retry")),
    Match.when("outage", () => (vi ? "Thử lại" : "Retry")),
    Match.when("rate-limited", () => (vi ? "Thử lại" : "Retry")),
    Match.when("auth", () => (vi ? "Thử lại" : "Retry")),
    Match.when("timeout", () => (vi ? "Thử lại" : "Retry")),
    Match.when("bad-image", () => (vi ? "Thử lại" : "Retry")),
    Match.when("validation", () => (vi ? "Thử lại" : "Retry")),
    Match.when("conflict", () => (vi ? "Thử lại" : "Retry")),
    Match.when("unknown", () => (vi ? "Thử lại" : "Retry")),
    Match.exhaustive,
  );
};

/**
 * Compact contextual error near the action. Photos stay intact (pure
 * display, no side effects); the retry button renders only when the parent
 * passes a meaningful recovery (`onRetry`), never for terminal states.
 *
 * When `transportKind` carries a frozen Lane BT `ScanTransportFailure`
 * literal, the safe localized transport message replaces the raw client
 * message — raw SyntaxError text and HTML error-page content never reach
 * the visitor.
 */
export function ScanError({
  error,
  retryAfterText,
  onRetry,
  locale,
  transportKind,
}: {
  readonly error: ClassifiableScanError;
  readonly retryAfterText?: string | null | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly locale: string;
  readonly transportKind?: ScanTransportKind | undefined;
}): ReactNode {
  const kind = classifyScanError(error);
  const hint = hintFor(kind, locale);

  const message =
    transportKind === undefined ? error.message : transportMessageFor(transportKind, locale);

  return (
    <div role="alert" className="scan-error">
      <p className="scan-error-message">
        <TriangleAlert aria-hidden="true" /> {message}
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
