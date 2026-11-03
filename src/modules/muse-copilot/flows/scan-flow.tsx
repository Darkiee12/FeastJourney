import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { FlowShell, type FlowProps } from "@/modules/muse-copilot/flows/conversation";

const copy = {
  en: {
    title: "Scan a menu",
    intro:
      "Menu scanning lives in the full scanner — photo checks, text extraction, and review all happen there, so nothing is scanned twice.",
    openScanner: "Open the scanner",
    backHint: "When the scan is saved, return here and continue with what it found.",
    forgetScan: "Forget this scan",
    scopedTo: "Scanner will open scoped to this venue.",
    unscoped: "Pick a venue first if you want the scan attached to a place; otherwise scan freely.",
  },
  vi: {
    title: "Quét thực đơn",
    intro:
      "Quét thực đơn nằm ở trình quét đầy đủ — kiểm tra ảnh, trích xuất chữ và duyệt đều ở đó, để không quét trùng.",
    openScanner: "Mở trình quét",
    backHint: "Khi lưu xong, quay lại đây để tiếp tục với kết quả quét.",
    forgetScan: "Bỏ lần quét này",
    scopedTo: "Trình quét sẽ mở theo quán này.",
    unscoped: "Chọn quán trước nếu muốn gắn lần quét vào một địa điểm; không thì cứ quét tự do.",
  },
} as const;

/**
 * Scan flow. This flow intentionally contains no scanner: photo capture,
 * client validation, server-side extraction, and review stay in the
 * canonical `/scan` route (`MenuScanPage` + `menu-scan-client`). Copying
 * that pipeline here would fork upload bounds, consent, and revision
 * handling. Instead this flow navigates to `/scan` with the current
 * language and venue scope, so the traveler returns to copilot with a
 * `scanId` in context.
 */
export default function ScanFlow({ context, onUpdateContext }: FlowProps): ReactNode {
  const strings = context.language === "vi" ? copy.vi : copy.en;

  return (
    <FlowShell title={strings.title} intro={strings.intro}>
      <p className="text-sm leading-relaxed text-ink">
        {context.venueId === undefined ? strings.unscoped : strings.scopedTo}
      </p>
      <div className="flex flex-col gap-2">
        <Link
          to="/scan"
          search={
            context.venueId === undefined
              ? { lang: context.language }
              : { lang: context.language, venueId: context.venueId }
          }
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-food-orange-strong px-5 text-sm font-bold text-white transition hover:bg-food-orange-dark"
        >
          {strings.openScanner}
        </Link>
        <p className="text-xs leading-relaxed text-muted">{strings.backHint}</p>
        {context.scanId === undefined ? null : (
          <button
            type="button"
            onClick={() => {
              onUpdateContext({ scanId: undefined });
            }}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full border-2 border-ink bg-white px-5 text-sm font-bold text-ink transition hover:bg-ink hover:text-white"
          >
            {strings.forgetScan}
          </button>
        )}
      </div>
    </FlowShell>
  );
}
