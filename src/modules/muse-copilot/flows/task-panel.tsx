import { Data } from "effect";

import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import type {
  CopilotContext,
  JourneyTask,
  MuseFailure,
} from "@/modules/muse-copilot/journey/types";
import type { CopilotCard } from "@/server/muse-copilot/copilot-schemas";

/**
 * Outcome of one workspace exchange (chat send or vision identify). Success
 * publishes an assistant turn owning its enrichment; failure publishes an
 * assistant turn carrying typed failure metadata plus a stored retry thunk
 * (real resend, never a flag reset).
 */
export type ExchangeOutcome = Data.TaggedEnum<{
  ExchangeOk: {
    readonly text: string;
    readonly cards: ReadonlyArray<CopilotCard>;
    readonly followUps: ReadonlyArray<string>;
    readonly notice: string | null;
    readonly synthesized: boolean;
  };
  ExchangeFailed: { readonly failure: MuseFailure };
}>;

export const ExchangeOutcome = Data.taggedEnum<ExchangeOutcome>();

/** Composer-initiated photo capture request, consumed by the plate panel. */
export type PhotoRequestKind = "gallery" | "camera";

export interface ExchangeInput {
  /** Server task tagging this exchange (history + tool budget). */
  readonly task: JourneyTask;
  /** User text appended immediately, preserved for retry. */
  readonly userText: string;
  /** Honest pending stage shown while the work runs. */
  readonly stage: string;
  readonly work: () => Promise<ExchangeOutcome>;
}

/**
 * What every task panel receives from the unified workspace. Panels own
 * task-specific UI (location bar, photo picker, scan actions, order menu)
 * but never their own thread, composer, or retry semantics — those stay in
 * the workspace so enrichment, history, and recovery behave identically.
 */
export interface WorkspacePanelApi {
  readonly copy: CopilotCopy;
  readonly context: CopilotContext;
  readonly task: JourneyTask;
  readonly busy: boolean;
  readonly signedIn: boolean;
  readonly onUpdateContext: (patch: Partial<CopilotContext>) => void;
  readonly startExchange: (input: ExchangeInput) => void;
  /** Publishes a server-free assistant note (e.g. expired-scan guidance). */
  readonly publishNote: (text: string) => void;
  /** Switches the workspace mode (task shortcuts, scan return actions). */
  readonly selectTask: (task: JourneyTask) => void;
  /** Prefills the composer draft (e.g. scan follow-up starters). */
  readonly setDraft: (text: string) => void;
  /** Requests a gallery/camera capture; the plate panel consumes it. */
  readonly requestPhoto: (kind: PhotoRequestKind) => void;
  /** Consumes a pending capture request, if any. */
  readonly consumePhotoRequest: () => PhotoRequestKind | null;
}

export interface KnownCity {
  readonly id: string;
  readonly city: string;
  readonly country: string;
}

/**
 * Curated browsing cities mirrored from the map bounds presets. Display
 * names only — coordinates never leave this module and never ride a Muse
 * request (addendum: never pass unnecessary coordinates to Muse).
 */
export const KNOWN_CITIES: ReadonlyArray<KnownCity> = [
  { id: "hcmc", city: "Ho Chi Minh City", country: "Vietnam" },
  { id: "hanoi", city: "Hanoi", country: "Vietnam" },
  { id: "bangalore", city: "Bengaluru", country: "India" },
];
