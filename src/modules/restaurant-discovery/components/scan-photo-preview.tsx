import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

export interface ScanPreviewPhoto {
  readonly id: string;
  readonly previewUrl: string;
  readonly name: string;
}

const pageLabel = (index: number, locale: string): string =>
  locale === "vi" ? `Trang ${index + 1}` : `Page ${index + 1}`;

interface PhotoPreviewCopy {
  readonly remove: string;
  readonly earlier: string;
  readonly later: string;
  readonly inspect: string;
  readonly close: string;
}

const copyFor = (locale: string): PhotoPreviewCopy => {
  if (locale === "vi")
    return {
      remove: "Xóa ảnh",
      earlier: "Chuyển lên trước",
      later: "Chuyển ra sau",
      inspect: "Xem ảnh lớn",
      close: "Đóng",
    };

  return {
    remove: "Remove photo",
    earlier: "Move earlier",
    later: "Move later",
    inspect: "Inspect photo",
    close: "Close",
  };
};

/**
 * Compact thumbnail grid labeled Page 1/2… with small remove + compact
 * reorder (no reorder UI for a single photo). Tapping a thumbnail opens a
 * native dialog for full inspection via object-fit:contain. Object URLs are
 * owned by the parent; this component never revokes them.
 */
export function ScanPhotoPreview({
  photos,
  disabled,
  onRemove,
  onMove,
  locale,
}: {
  readonly photos: ReadonlyArray<ScanPreviewPhoto>;
  readonly disabled: boolean;
  readonly onRemove: (id: string) => void;
  readonly onMove: (id: string, direction: -1 | 1) => void;
  readonly locale: string;
}): ReactNode {
  const copy = copyFor(locale);
  const dialogId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [inspected, setInspected] = useState<ScanPreviewPhoto | null>(null);

  const inspect = (photo: ScanPreviewPhoto): void => {
    setInspected(photo);

    // Dialog element mounts with the inspected photo; open after paint.
    requestAnimationFrame(() => dialogRef.current?.showModal());
  };

  const close = (): void => {
    dialogRef.current?.close();
    setInspected(null);
  };

  return (
    <>
      <ol
        className="scan-photo-grid"
        aria-label={locale === "vi" ? "Các trang thực đơn" : "Menu pages"}
      >
        {photos.map((photo, index) => (
          <li key={photo.id} className="scan-photo-cell">
            <button
              type="button"
              className="scan-photo-thumb"
              disabled={disabled}
              onClick={() => inspect(photo)}
              aria-label={`${copy.inspect}: ${pageLabel(index, locale)}`}
            >
              <img src={photo.previewUrl} alt={pageLabel(index, locale)} />
              <span className="scan-photo-badge">{pageLabel(index, locale)}</span>
            </button>
            <div className="scan-photo-cell-actions">
              {photos.length > 1 ? (
                <>
                  <button
                    type="button"
                    disabled={disabled || index === 0}
                    onClick={() => onMove(photo.id, -1)}
                    aria-label={`${copy.earlier}: ${index + 1}`}
                    title={copy.earlier}
                  >
                    <ChevronUp aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={disabled || index === photos.length - 1}
                    onClick={() => onMove(photo.id, 1)}
                    aria-label={`${copy.later}: ${index + 1}`}
                    title={copy.later}
                  >
                    <ChevronDown aria-hidden="true" />
                  </button>
                </>
              ) : null}
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRemove(photo.id)}
                aria-label={`${copy.remove}: ${pageLabel(index, locale)}`}
                title={copy.remove}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          </li>
        ))}
      </ol>
      {inspected === null ? null : (
        <dialog
          ref={dialogRef}
          aria-labelledby={dialogId}
          className="scan-photo-dialog"
          onClose={close}
        >
          <p id={dialogId} className="scan-photo-dialog-title">
            {pageLabel(
              photos.findIndex((photo) => photo.id === inspected.id),
              locale,
            )}
          </p>
          <img src={inspected.previewUrl} alt={inspected.name} className="scan-photo-full" />
          <button type="button" autoFocus onClick={close}>
            {copy.close}
          </button>
        </dialog>
      )}
    </>
  );
}
