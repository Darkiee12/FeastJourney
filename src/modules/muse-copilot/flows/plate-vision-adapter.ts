import { Data } from "effect";

import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import type {
  CopilotAction,
  CopilotCard,
  CopilotIdentifyPhotoOutput,
} from "@/server/muse-copilot/copilot-schemas";

/**
 * Single-image policy for Know Your Plate (plan §13, addendum §3). One
 * JPEG/PNG/WebP photo up to 8 MiB. Client checks are UX-only; the server
 * enforces format, byte size, signatures, dimensions, and ownership before
 * any vision call (never trust browser MIME claims).
 */
export const PLATE_PHOTO_MAX_BYTES = 8 * 1024 * 1024;

export const PLATE_PHOTO_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * Client-side photo rejection. Cheap pre-upload UX only — the server
 * re-validates everything before bytes reach the vision provider.
 */
export type PlatePhotoIssue = Data.TaggedEnum<{
  PhotoUnsupportedType: {};
  PhotoTooLarge: {};
}>;

export const PlatePhotoIssue = Data.taggedEnum<PlatePhotoIssue>();

export const validatePlatePhoto = (photo: File): PlatePhotoIssue | null => {
  if (!PLATE_PHOTO_TYPES.has(photo.type)) {
    return PlatePhotoIssue.PhotoUnsupportedType();
  }

  if (photo.size === 0 || photo.size > PLATE_PHOTO_MAX_BYTES) {
    return PlatePhotoIssue.PhotoTooLarge();
  }

  return null;
};

export const confidenceLabelFor = (
  copy: CopilotCopy,
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

const fillName = (template: string, name: string): string => template.replace("{name}", name);

export interface PlateVerdict {
  readonly text: string;
  readonly cards: ReadonlyArray<CopilotCard>;
  readonly followUps: ReadonlyArray<string>;
  /**
   * Typed next steps mirroring `followUps`: the explain/find questions
   * travel as `ask`/`findRestaurants` contract actions so the workspace can
   * dispatch them by kind instead of regex-sniffing chip labels. Kept
   * alongside `followUps` so existing callers keep compiling until they
   * switch to dispatching `actions`.
   */
  readonly actions: ReadonlyArray<CopilotAction>;
  readonly notice: string;
  /** First canonical dish match, adopted into journey context by the caller. */
  readonly dishId: string | undefined;
}

/**
 * Tentative verdict from validated vision candidates (plan §13). Names are
 * hedged with careful confidence labels plus the visual evidence Muse saw;
 * canonical dish matches ride as cards with real dish links. Never claims
 * ingredients, allergens, or origin — a photograph proves none of those.
 */
export const describePlateVerdict = (
  output: CopilotIdentifyPhotoOutput,
  copy: CopilotCopy,
): PlateVerdict => {
  if (output.candidates.length === 0) {
    return {
      text: output.unmatchedNote ?? copy.noEvidence,
      cards: [],
      followUps: [],
      actions: [],
      notice: copy.noEvidence,
      dishId: undefined,
    };
  }

  const text = output.candidates
    .map(
      (candidate) =>
        `${candidate.name} — ${confidenceLabelFor(copy, candidate.confidence)}: ${candidate.visualEvidence}`,
    )
    .join("\n");

  const cards = output.candidates.flatMap((candidate): ReadonlyArray<CopilotCard> =>
    candidate.dishId === undefined
      ? []
      : [
          {
            kind: "dish",
            refId: candidate.dishId,
            title: candidate.name,
            summary: candidate.visualEvidence,
            // Tentative photo match, not a verified fact: inference tier.
            provenance: "inference",
          },
        ],
  );

  const first = output.candidates[0];

  if (first === undefined) {
    return {
      text,
      cards,
      followUps: [],
      actions: [],
      notice: copy.plateCandidates,
      dishId: undefined,
    };
  }

  const explain = fillName(copy.plateFollowExplain, first.name);
  const find = fillName(copy.plateFollowFind, first.name);

  const followUps: ReadonlyArray<string> = [explain, find, copy.noneOfThese];

  // The rejection question must stand alone: name the rejected candidates
  // instead of sending the bare "None of these" chip label as a question.
  const rejected = output.candidates.map((candidate) => candidate.name).join(", ");

  const actions: ReadonlyArray<CopilotAction> = [
    { kind: "ask", label: explain, question: explain },
    { kind: "findRestaurants", label: find },
    {
      kind: "ask",
      label: copy.noneOfThese,
      question: `This photo is not ${rejected}. What dish is shown instead?`,
    },
  ];

  const dishId = output.candidates.find((candidate) => candidate.dishId !== undefined)?.dishId;

  return { text, cards, followUps, actions, notice: copy.plateCandidates, dishId };
};
