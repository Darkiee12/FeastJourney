import type { ReactNode } from "react";

const noticeText = (locale: string): string =>
  locale === "vi"
    ? "Ảnh được Meta Muse phân tích. Bản quét riêng tư hết hạn sau 24 giờ."
    : "Photos are analyzed by Meta Muse. Your private scan expires after 24 hours.";

const detailsLabel = (locale: string): string =>
  locale === "vi" ? "Chi tiết quyền riêng tư" : "Privacy details";

const detailsBody = (locale: string): string =>
  locale === "vi"
    ? "Bản quét riêng tư hết hạn sau 24 giờ; ảnh được xóa bằng tác vụ có thể thử lại, việc này cần thời gian. Ảnh được gửi cho Meta để phân tích ở chế độ tiêu chuẩn (yêu cầu đặt store:false, nhưng đó không phải bảo đảm xóa — Meta có thể lưu ảnh theo điều khoản riêng). Đóng góp là tùy chọn và không bao giờ công khai ảnh của bạn; tệp đã đóng góp được giữ tối đa 30 ngày."
    : "Private scans expire after 24 hours; photos are removed by retryable cleanup, which takes time. Photos are sent to Meta for analysis in standard mode (the request sets store:false, but that is not a deletion guarantee — Meta may retain them under its own terms). Contributing is optional and never publishes your photograph; contributed files are kept for up to 30 days.";

/** One-line privacy notice shown next to the submit action. */
export function ScanPrivacyNotice({ locale }: { readonly locale: string }): ReactNode {
  return <p className="scan-privacy-line">{noticeText(locale)}</p>;
}

/** Accurate retention disclosure. Never claims Meta deletes in 24h. */
export function ScanPrivacyDetails({ locale }: { readonly locale: string }): ReactNode {
  return (
    <details className="scan-privacy-details">
      <summary>{detailsLabel(locale)}</summary>
      <p>
        {detailsBody(locale)}{" "}
        <a href="https://dev.meta.ai/legal/terms-of-service" target="_blank" rel="noreferrer">
          Meta terms
        </a>
      </p>
    </details>
  );
}
