import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";

import {
  PhotoIdentifyResult,
  classifyChatError,
  identifyPhoto,
} from "@/modules/muse-copilot/flows/conversation-model";
import {
  PlatePhotoIssue,
  describePlateVerdict,
  validatePlatePhoto,
} from "@/modules/muse-copilot/flows/plate-vision-adapter";
import { ExchangeOutcome, type WorkspacePanelApi } from "@/modules/muse-copilot/flows/task-panel";
import { isMenuReadingLanguage } from "@/modules/restaurant-discovery/menu-language";
import { menuScanClient } from "@/modules/restaurant-discovery/menu-scan-client";

const uuidSchema = z.uuid();

/**
 * Know Your Plate (plan §13, addendum §§3/7). The composer's gallery/camera
 * buttons open the native picker directly through the hidden inputs below —
 * no intermediate form. A picked photo shows a compact preview for
 * confirmation BEFORE any upload; the upload then reuses the existing
 * private menu-scan storage path and identification calls the real
 * `copilotIdentifyPhotoFn`, never catalog text search. The exchange retry
 * reuses the owned scan; a newly picked photo always mints a fresh scan so
 * retries never duplicate private storage and failures keep the photo for
 * retry without re-upload.
 *
 * Guests see the sign-in requirement before uploading: the vision operation
 * only permits signed-in owners, so advertising identification to guests
 * would lie. The verdict stays tentative — careful confidence, visual
 * evidence, canonical dish link, Explain/Find-nearby/None-of-these — and
 * never claims ingredients, allergens, or origin from an image.
 */
export function PlatePanel(api: WorkspacePanelApi): ReactNode {
  const {
    busy,
    consumePhotoRequest,
    context,
    copy,
    onUpdateContext,
    publishNote,
    signedIn,
    startExchange,
  } = api;

  const [picked, setPicked] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const photoUrlRef = useRef<string | null>(null);
  /** Latest upload per photo: exchange retries reuse the owned scan. */
  const lastUploadRef = useRef<{ readonly photo: File; readonly scanId: string } | null>(null);
  const galleryRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);

  useEffect(
    () => () => {
      if (photoUrlRef.current !== null) {
        URL.revokeObjectURL(photoUrlRef.current);
        photoUrlRef.current = null;
      }
    },
    [],
  );

  // Composer capture buttons (gallery/camera) delegate here: consume a
  // pending request and open the matching native picker. Runs every render
  // so a mode switch triggered by the button is honored on mount. Skipped
  // while an identification is in flight.
  useEffect(() => {
    if (busy) {
      return;
    }

    const request = consumePhotoRequest();

    if (request === "gallery") {
      galleryRef.current?.click();
    } else if (request === "camera") {
      cameraRef.current?.click();
    }
  });

  const setPreview = (next: string | null): void => {
    if (photoUrlRef.current !== null) {
      URL.revokeObjectURL(photoUrlRef.current);
      photoUrlRef.current = null;
    }

    photoUrlRef.current = next;
    setPhotoUrl(next);
  };

  const presentCandidates = (
    output: Parameters<typeof describePlateVerdict>[0],
  ): ExchangeOutcome => {
    const verdict = describePlateVerdict(output, copy);

    if (verdict.dishId !== undefined) {
      onUpdateContext({ dishId: verdict.dishId });
    }

    return ExchangeOutcome.ExchangeOk({
      text: verdict.text,
      cards: verdict.cards,
      followUps: verdict.followUps,
      notice: verdict.notice,
      // Client-composed from validated candidates: deterministic assembly.
      synthesized: false,
    });
  };

  const identify = (): void => {
    if (picked === null || busy) {
      return;
    }

    const photo = picked;
    const parsedVenue = uuidSchema.safeParse(context.venueId);
    const venueId = parsedVenue.success ? parsedVenue.data : null;

    startExchange({
      task: "plate",
      userText: copy.photoShared,
      stage: copy.thinkingPhoto,
      work: async () => {
        // Retry reuses the existing owned scan (addendum §3); only a newly
        // picked photo uploads again.
        const reuse = lastUploadRef.current;
        let ownedScanId: string;

        if (reuse !== null && reuse.photo === photo) {
          ownedScanId = reuse.scanId;
        } else {
          try {
            const created = await menuScanClient.create({
              targetLanguage: isMenuReadingLanguage(context.language) ? context.language : "en",
              venueId,
            });

            await menuScanClient.attach(created.id, 1, photo);
            ownedScanId = created.id;
            lastUploadRef.current = { photo, scanId: ownedScanId };
          } catch (error) {
            return ExchangeOutcome.ExchangeFailed({
              failure: classifyChatError({
                message: error instanceof Error ? error.message : "",
              }),
            });
          }

          onUpdateContext({ scanId: ownedScanId });
        }

        const result = await identifyPhoto(ownedScanId, context.language);

        return PhotoIdentifyResult.$match(result, {
          PhotoFailed: ({ failure }) => ExchangeOutcome.ExchangeFailed({ failure }),
          PhotoReady: ({ output }) => presentCandidates(output),
        });
      },
    });
  };

  const pickPhoto = (event: { readonly target: HTMLInputElement }): void => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (file === undefined) {
      return;
    }

    const issue = validatePlatePhoto(file);

    if (issue !== null) {
      PlatePhotoIssue.$match(issue, {
        PhotoUnsupportedType: () => {
          publishNote(copy.errorPhotoType);
        },
        PhotoTooLarge: () => {
          publishNote(copy.errorPhotoLarge);
        },
      });

      return;
    }

    // A newly picked photo invalidates the previous upload binding.
    lastUploadRef.current = null;
    setPicked(file);
    setPreview(URL.createObjectURL(file));
  };

  if (!signedIn) {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-border-soft bg-white px-4 py-3">
        <p className="text-sm leading-relaxed text-ink">{copy.errorAuth}</p>

        <Link
          to="/sign-in"
          search={{ lang: context.language, returnTo: "/muse" }}
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-food-orange-strong px-5 text-sm font-bold text-white transition hover:bg-food-orange-dark"
        >
          {copy.signInAction}
        </Link>
      </div>
    );
  }

  const pickerButton =
    "inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-full border border-border-soft bg-white px-4 text-sm font-bold text-ink transition hover:border-food-orange-strong";

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={galleryRef}
        id="muse-plate-photo"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        disabled={busy}
        onChange={(event) => {
          pickPhoto(event);
        }}
      />

      <input
        ref={cameraRef}
        id="muse-plate-camera"
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        disabled={busy}
        onChange={(event) => {
          pickPhoto(event);
        }}
      />

      <p className="text-sm leading-relaxed text-ink">{copy.suggestPlate}</p>

      <p className="text-xs leading-relaxed text-muted">{copy.plateConstraints}</p>

      <div className="flex flex-wrap gap-2">
        <label htmlFor="muse-plate-photo" className={pickerButton}>
          {copy.photoGalleryLabel}
        </label>

        <label htmlFor="muse-plate-camera" className={pickerButton}>
          {copy.photoCameraLabel}
        </label>
      </div>

      {photoUrl === null || picked === null ? null : (
        <figure className="flex flex-col gap-2">
          <img
            src={photoUrl}
            alt={copy.photoShared}
            className="max-h-56 w-full rounded-2xl border border-border-soft object-cover"
          />

          <button
            type="button"
            onClick={identify}
            disabled={busy}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full bg-food-orange-strong px-5 text-sm font-bold text-white transition hover:bg-food-orange-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? copy.thinkingPhoto : copy.plateIdentifyAction}
          </button>
        </figure>
      )}
    </div>
  );
}

export default PlatePanel;
