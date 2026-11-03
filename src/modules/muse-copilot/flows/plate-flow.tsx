import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";

import {
  PhotoIdentifyResult,
  classifyChatError,
  identifyPhoto,
} from "@/modules/muse-copilot/flows/conversation-model";
import { ExchangeOutcome, type WorkspacePanelApi } from "@/modules/muse-copilot/flows/task-panel";
import { menuScanClient } from "@/modules/restaurant-discovery/menu-scan-client";
import type {
  CopilotCard,
  CopilotIdentifyPhotoOutput,
} from "@/server/muse-copilot/copilot-schemas";

const uuidSchema = z.uuid();

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

const SUPPORTED_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);

const fillName = (template: string, name: string): string => template.replace("{name}", name);

const confidenceLabelFor = (
  copy: WorkspacePanelApi["copy"],
  confidence: "likely" | "possible" | "tentative",
): string => {
  if (confidence === "likely") {
    return copy.confidenceLikely;
  }

  if (confidence === "possible") {
    return copy.confidencePossible;
  }

  return copy.confidenceTentative;
};

/**
 * Know Your Plate (plan §13, addendum §§3/7). Single-image policy: one
 * JPEG/PNG/WebP photo up to 8 MiB, validated client-side for UX and
 * enforced server-side (never trust browser MIME claims). Guests see the
 * sign-in requirement before uploading — the vision operation only permits
 * signed-in owners, so advertising identification to guests would lie.
 * Uploads reuse the menu-scanner storage path; identification calls the
 * real `copilotIdentifyPhotoFn`, never catalog text search. The exchange
 * retry reuses the owned scan; a newly picked photo always mints a fresh
 * scan so retries never duplicate private storage.
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
  // so a mode switch triggered by the button is honored on mount.
  useEffect(() => {
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

  const presentCandidates = (output: CopilotIdentifyPhotoOutput) =>
    ExchangeOutcome.ExchangeOk({
      text:
        output.candidates.length === 0
          ? (output.unmatchedNote ?? copy.noEvidence)
          : output.candidates
              .map(
                (candidate) =>
                  `${candidate.name} — ${confidenceLabelFor(copy, candidate.confidence)}: ${candidate.visualEvidence}`,
              )
              .join("\n"),
      cards: output.candidates.flatMap((candidate): ReadonlyArray<CopilotCard> =>
        candidate.dishId === undefined
          ? []
          : [
              {
                kind: "dish",
                refId: candidate.dishId,
                title: candidate.name,
                summary: candidate.visualEvidence,
              },
            ],
      ),
      followUps: followUpsFor(output),
      notice: output.candidates.length === 0 ? copy.noEvidence : copy.plateCandidates,
      // Client-composed from validated candidates: deterministic assembly.
      synthesized: false,
    });

  const followUpsFor = (output: CopilotIdentifyPhotoOutput): ReadonlyArray<string> => {
    const first = output.candidates[0];

    if (first === undefined) {
      return [];
    }

    const dishCard = output.candidates.find((candidate) => candidate.dishId !== undefined);

    if (dishCard?.dishId !== undefined) {
      onUpdateContext({ dishId: dishCard.dishId });
    }

    return [
      fillName(copy.plateFollowExplain, first.name),
      fillName(copy.plateFollowFind, first.name),
      copy.noneOfThese,
    ];
  };

  const identify = (photo: File): void => {
    if (!SUPPORTED_TYPES.has(photo.type)) {
      publishNote(copy.errorPhotoType);

      return;
    }

    if (photo.size === 0 || photo.size > MAX_PHOTO_BYTES) {
      publishNote(copy.errorPhotoLarge);

      return;
    }

    setPreview(URL.createObjectURL(photo));

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
              targetLanguage: context.language,
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
    const picked = event.target.files?.[0];

    if (picked !== undefined) {
      identify(picked);
    }

    event.target.value = "";
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

      {photoUrl === null ? null : (
        <img
          src={photoUrl}
          alt=""
          className="w-full rounded-2xl border border-border-soft object-cover"
        />
      )}
    </div>
  );
}

export default PlatePanel;
