import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

import { menuScanPageCopy } from "@/modules/restaurant-discovery/components/menu-copy";

export type ScanPhase = "preparing" | "uploading" | "reading";

const phaseLabel = (phase: ScanPhase, uploaded: number, total: number, locale: string): string => {
  const vi = locale === "vi";

  if (phase === "preparing") return vi ? "Đang chuẩn bị ảnh…" : "Preparing your photos…";

  if (phase === "uploading")
    return vi
      ? `Đang tải ảnh ${uploaded + 1} trên ${total}…`
      : `Uploading photo ${uploaded + 1} of ${total}…`;

  return vi ? "Muse đang đọc thực đơn ✨…" : "Muse is reading your menu ✨…";
};

/**
 * Tagged processing state reusing the real upload-vs-extraction phases:
 * preparing (indeterminate), uploading with true "N of M" counts, reading
 * with an indeterminate spinner (the provider reports no item progress).
 * Photos are preserved — this component never clears them. No fake %.
 */
export function ScanProcessing({
  phase,
  uploaded,
  total,
  locale,
}: {
  readonly phase: ScanPhase;
  readonly uploaded: number;
  readonly total: number;
  readonly locale: string;
}): ReactNode {
  const copy = menuScanPageCopy(locale);
  const determinate = phase === "uploading" && total > 0;

  return (
    <div className="scan-processing" data-phase={phase} aria-busy="true">
      {/* Decorative only: a menu page under a moving scan beam. It implies no
          progress; the provider reports none. */}
      <div className="scan-reading" aria-hidden="true">
        <span className="scan-reading-title" />
        <span className="scan-reading-line" />
        <span className="scan-reading-line" />
        <span className="scan-reading-line" />
        <span className="scan-reading-title" />
        <span className="scan-reading-line" />
        <span className="scan-reading-line" />
        <span className="scan-reading-beam" />
      </div>
      <output aria-live="polite" className="scan-processing-line">
        <LoaderCircle aria-hidden="true" className="scan-spin" />{" "}
        {phaseLabel(phase, uploaded, total, locale)}
      </output>
      {determinate ? (
        <progress
          value={uploaded}
          max={total}
          aria-label={copy.uploadProgress}
          className="scan-processing-bar"
        />
      ) : null}
      {phase === "reading" ? <p className="scan-processing-note">{copy.stageAnalyzing}</p> : null}
    </div>
  );
}
