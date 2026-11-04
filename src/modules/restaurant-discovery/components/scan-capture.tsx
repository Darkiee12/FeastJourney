import { Camera, ChevronRight, Images, MapPin } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { SharedSelectField } from "@/components/ui/select";
import {
  menuLanguageNames,
  scanLocationCopy,
  scanLocationPickerCopy,
} from "@/modules/restaurant-discovery/components/menu-copy";
import {
  ScanLocationPicker,
  type ScanLocationPickerProps,
} from "@/modules/restaurant-discovery/components/scan-location-picker";
import {
  ScanPhotoPreview,
  type ScanPreviewPhoto,
} from "@/modules/restaurant-discovery/components/scan-photo-preview";
import {
  ScanPrivacyDetails,
  ScanPrivacyNotice,
} from "@/modules/restaurant-discovery/components/scan-privacy";
import { CITY_PRESETS } from "@/modules/restaurant-discovery/map-bounds";
import { menuLanguages } from "@/modules/restaurant-discovery/menu-scan.schema";

/**
 * Optional coarse menu location: a curated city id + display label.
 *
 * cityId grammar: curated preset ids ("hcmc" | "hanoi" | "bangalore"),
 * geolocated labels ("geo:<name>", taken as-is from nearestCityFn), or
 * canonical catalog identities ("place:<decimalId>" from city search).
 * Only cityId + label persist (feastjourney:menu-location:v1).
 */
export interface ScanMenuLocation {
  readonly cityId: string;
  readonly label: string;
}

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
      limits: "JPEG, PNG hoặc WebP — số trang và dung lượng theo giới hạn máy chủ.",
      empty: "Thêm ít nhất một ảnh thực đơn rõ nét để bắt đầu.",
      submit: "Đọc thực đơn với Muse ✨",
    };

  return {
    camera: "Take a photo",
    gallery: "Choose from gallery",
    addPages: "Add pages",
    language: "Translate into",
    limits: "JPEG, PNG or WebP — page, size and total limits are enforced by the server.",
    empty: "Add at least one clear menu photo to begin.",
    submit: "Read menu with Muse ✨",
  };
};

const cityLabelFor = (cityId: string, locale: string): string => {
  const copy = scanLocationCopy(locale);

  if (cityId === "hcmc") return copy.cityHcmc;

  if (cityId === "hanoi") return copy.cityHanoi;

  if (cityId === "bangalore") return copy.cityBangalore;

  return cityId;
};

/**
 * Compact location trigger: one row opening the location sheet. Recent
 * history is real session state only — selections made through this row,
 * seeded with the stored location — capped at five, never invented.
 * Dismissing the sheet preserves the choice; selecting auto-closes.
 */
function ScanLocationSetting({
  locale,
  menuLocation,
  disabled,
  onLocationChange,
}: {
  readonly locale: string;
  readonly menuLocation: ScanMenuLocation | null;
  readonly disabled: boolean;
  readonly onLocationChange: (location: ScanMenuLocation | null) => void;
}): ReactNode {
  const copy = scanLocationPickerCopy(locale);

  const [open, setOpen] = useState(false);

  const [recent, setRecent] = useState<ReadonlyArray<ScanMenuLocation>>(() =>
    menuLocation === null ? [] : [menuLocation],
  );

  const presets: ReadonlyArray<ScanMenuLocation> = CITY_PRESETS.map((city) => ({
    cityId: city.id,
    label: cityLabelFor(city.id, locale),
  }));

  const choose: ScanLocationPickerProps["onSelect"] = (location) => {
    if (location !== null) {
      setRecent((previous) =>
        [location, ...previous.filter((entry) => entry.cityId !== location.cityId)].slice(0, 5),
      );
    }

    onLocationChange(location);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-border-soft bg-white px-3 py-2 text-left disabled:opacity-60"
      >
        <MapPin aria-hidden="true" className="size-4 flex-none text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-ink">{copy.trigger}</span>
          {menuLocation === null ? null : (
            <span className="block truncate text-sm text-muted">{menuLocation.label}</span>
          )}
        </span>
        <ChevronRight aria-hidden="true" className="size-4 flex-none text-muted" />
      </button>
      <ScanLocationPicker
        locale={locale}
        open={open}
        disabled={disabled}
        current={menuLocation}
        recent={recent}
        presets={presets}
        onOpenChange={setOpen}
        onSelect={choose}
      />
    </>
  );
}

/**
 * Cohesive capture surface: camera primary, gallery secondary, compact
 * language setting, optional coarse location, thumbnail strip, and the
 * single inline primary action. Upload limits appear only contextually
 * (once photos exist). No giant navy blocks, no sticky bar, no duplicate
 * submit buttons.
 */
export function ScanCapture({
  locale,
  targetLanguage,
  onTargetLanguageChange,
  menuLocation,
  onLocationChange,
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
  readonly menuLocation: ScanMenuLocation | null;
  readonly onLocationChange: (location: ScanMenuLocation | null) => void;
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

      <ScanLocationSetting
        locale={locale}
        menuLocation={menuLocation}
        disabled={busy}
        onLocationChange={onLocationChange}
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
