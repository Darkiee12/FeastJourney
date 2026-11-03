import { Camera, Images } from "lucide-react";
import { useId, type ReactNode } from "react";

import { SharedSelectField } from "@/components/ui/select";
import { menuLanguageNames } from "@/modules/restaurant-discovery/components/menu-copy";
import {
  ScanPhotoPreview,
  type ScanPreviewPhoto,
} from "@/modules/restaurant-discovery/components/scan-photo-preview";
import {
  ScanPrivacyDetails,
  ScanPrivacyNotice,
} from "@/modules/restaurant-discovery/components/scan-privacy";
import { menuLanguages } from "@/modules/restaurant-discovery/menu-scan.schema";

interface CaptureCopy {
  readonly camera: string;
  readonly gallery: string;
  readonly addPages: string;
  readonly language: string;
  readonly limits: string;
  readonly empty: string;
  readonly submit: string;
}

const captureCopy = (locale: string): CaptureCopy => {
  if (locale === "vi")
    return {
      camera: "Chụp thực đơn",
      gallery: "Chọn từ thư viện",
      addPages: "Thêm trang",
      language: "Dịch sang",
      limits: "JPEG, PNG hoặc WebP — tối đa 6 trang, mỗi ảnh 8 MiB, tổng 24 MiB.",
      empty: "Thêm ít nhất một ảnh thực đơn rõ nét để bắt đầu.",
      submit: "Đọc thực đơn với Muse ✨",
    };

  return {
    camera: "Take a photo",
    gallery: "Choose from gallery",
    addPages: "Add pages",
    language: "Translate into",
    limits: "JPEG, PNG or WebP — up to 6 pages, 8 MiB each, 24 MiB total.",
    empty: "Add at least one clear menu photo to begin.",
    submit: "Read menu with Muse ✨",
  };
};

/**
 * Cohesive capture surface: camera primary, gallery secondary, compact
 * language setting, thumbnail strip, and the single inline primary action.
 * Upload limits appear only contextually (once photos exist). No giant navy
 * blocks, no sticky bar, no duplicate submit buttons.
 */
export function ScanCapture({
  locale,
  targetLanguage,
  onTargetLanguageChange,
  photos,
  onAddFiles,
  onRemovePhoto,
  onMovePhoto,
  busy,
  submitDisabled,
  submitHint,
  onSubmit,
}: {
  readonly locale: string;
  readonly targetLanguage: string;
  readonly onTargetLanguageChange: (value: string) => void;
  readonly photos: ReadonlyArray<ScanPreviewPhoto>;
  readonly onAddFiles: (files: FileList | null) => void;
  readonly onRemovePhoto: (id: string) => void;
  readonly onMovePhoto: (id: string, direction: -1 | 1) => void;
  readonly busy: boolean;
  readonly submitDisabled: boolean;
  readonly submitHint: string | null;
  readonly onSubmit: () => void;
}): ReactNode {
  const copy = captureCopy(locale);
  const cameraId = useId();
  const galleryId = useId();
  const addId = useId();

  const renderFileInput = (
    id: string,
    multiple: boolean,
    capture: "user" | "environment" | null,
  ): ReactNode => (
    <input
      id={id}
      type="file"
      accept="image/jpeg,image/png,image/webp"
      multiple={multiple}
      capture={capture ?? undefined}
      disabled={busy}
      aria-hidden="true"
      tabIndex={-1}
      className="scan-file-input"
      onChange={(event) => {
        onAddFiles(event.target.files);
        event.target.value = "";
      }}
    />
  );

  return (
    <section className="scan-capture" aria-busy={busy}>
      <div className="scan-capture-actions">
        <label htmlFor={cameraId} className="scan-capture-primary">
          <Camera aria-hidden="true" /> {copy.camera}
        </label>
        {renderFileInput(cameraId, false, "environment")}
        <label htmlFor={galleryId} className="scan-capture-secondary">
          <Images aria-hidden="true" /> {copy.gallery}
        </label>
        {renderFileInput(galleryId, true, null)}
      </div>

      <SharedSelectField
        id="scan-target-language"
        label={copy.language}
        value={targetLanguage}
        disabled={busy}
        onValueChange={onTargetLanguageChange}
        options={menuLanguages.map((language) => ({
          label: menuLanguageNames.get(language) ?? language,
          value: language,
        }))}
        size="regular"
      />

      {photos.length > 0 ? (
        <>
          <p className="scan-limits">{copy.limits}</p>
          <ScanPhotoPreview
            photos={photos}
            disabled={busy}
            onRemove={onRemovePhoto}
            onMove={onMovePhoto}
            locale={locale}
          />
          <button
            type="button"
            className="scan-add-pages"
            disabled={busy}
            onClick={() => document.getElementById(addId)?.click()}
          >
            <Images aria-hidden="true" /> {copy.addPages}
          </button>
          <input
            id={addId}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={busy}
            aria-hidden="true"
            tabIndex={-1}
            className="scan-file-input"
            onChange={(event) => {
              onAddFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </>
      ) : (
        <p className="scan-empty">{copy.empty}</p>
      )}

      <button
        type="button"
        className="menu-order-primary scan-submit"
        disabled={submitDisabled}
        onClick={onSubmit}
      >
        {copy.submit}
      </button>
      {submitHint === null ? null : (
        <p className="scan-submit-hint" aria-live="polite">
          {submitHint}
        </p>
      )}

      <ScanPrivacyNotice locale={locale} />
      <ScanPrivacyDetails locale={locale} />
    </section>
  );
}
