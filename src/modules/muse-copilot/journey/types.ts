import { Data } from "effect";

import type { CopilotCard } from "@/server/muse-copilot/copilot-schemas";

/**
 * The five Muse tasks. The names double as flow-module slugs:
 * `../flows/<task>-flow` (scan-flow, plate-flow, find-flow, ask-flow,
 * order-flow). Keep this list in sync with the flow slot contract in
 * `shell/muse-shell.tsx`.
 */
export const journeyTasks = ["scan", "plate", "find", "ask", "order"] as const;

export type JourneyTask = (typeof journeyTasks)[number];

/**
 * Shareable journey scope. Only public identifiers ride in the URL
 * (?task=&dish=&venue=&scan=); scan ownership tokens and session data never
 * enter this object from a link — the server re-verifies ownership.
 */
export interface CopilotContext {
  readonly city?: string | undefined;
  readonly country?: string | undefined;
  readonly language: "en" | "vi";
  readonly dishId?: string | undefined;
  readonly venueId?: string | undefined;
  readonly scanId?: string | undefined;
}

/**
 * Props every flow module accepts. Flow modules live at
 * `@/modules/muse-copilot/flows/<task>-flow` and export either a named
 * `<Pascal>Flow` component (ScanFlow, PlateFlow, FindFlow, AskFlow,
 * OrderFlow) or a default component with this shape.
 */
export interface FlowProps {
  readonly context: CopilotContext;
  readonly onUpdateContext: (patch: Partial<CopilotContext>) => void;
}

/**
 * Where the copilot journey stands. Flow-carrying states keep their task so
 * back navigation can resume the exact slot; cross-task context (city,
 * dish, venue, scan) lives in `CopilotContext`, never in the state.
 */
export type JourneyState = Data.TaggedEnum<{
  Home: {};
  Capture: { readonly task: JourneyTask };
  Uploading: { readonly task: JourneyTask };
  Analyzing: { readonly task: JourneyTask };
  Researching: { readonly task: JourneyTask };
  PresentingResults: { readonly task: JourneyTask };
  OrderReview: {};
  WaiterCard: {};
  RecoverableFailure: { readonly reason: string };
}>;

export const JourneyState = Data.taggedEnum<JourneyState>();

/**
 * Events the shell and flow slots dispatch. Every (state, event) pair has an
 * explicit outcome in `transition` — unknown pairs hold the current state
 * instead of crashing.
 */
export type JourneyEvent = Data.TaggedEnum<{
  SelectTask: { readonly task: JourneyTask };
  BeginUpload: {};
  UploadSucceeded: {};
  UploadFailed: { readonly reason: string };
  AnalysisSucceeded: {};
  AnalysisFailed: { readonly reason: string };
  BeginResearch: {};
  ResearchSucceeded: {};
  ResearchEmpty: {};
  ResearchFailed: { readonly reason: string };
  BeginOrderReview: {};
  ShowWaiterCard: {};
  Fail: { readonly reason: string };
  GoBack: {};
  GoHome: {};
}>;

export const JourneyEvent = Data.taggedEnum<JourneyEvent>();

const entryForTask = (task: JourneyTask): JourneyState => {
  if (task === "scan") {
    return JourneyState.Capture({ task });
  }

  if (task === "order") {
    return JourneyState.OrderReview();
  }

  return JourneyState.Researching({ task });
};

const failFrom = (state: JourneyState, reason: string): JourneyState =>
  JourneyState.$match(state, {
    RecoverableFailure: () => JourneyState.RecoverableFailure({ reason }),
    Home: () => JourneyState.RecoverableFailure({ reason }),
    Capture: () => JourneyState.RecoverableFailure({ reason }),
    Uploading: () => JourneyState.RecoverableFailure({ reason }),
    Analyzing: () => JourneyState.RecoverableFailure({ reason }),
    Researching: () => JourneyState.RecoverableFailure({ reason }),
    PresentingResults: () => JourneyState.RecoverableFailure({ reason }),
    OrderReview: () => JourneyState.RecoverableFailure({ reason }),
    WaiterCard: () => JourneyState.RecoverableFailure({ reason }),
  });

/**
 * Total transition: every state handles every event exhaustively via nested
 * `$match`, so neither the compiler nor the runtime can meet an unhandled
 * pair. Events that make no sense in a state hold that state.
 */
export const transition = (state: JourneyState, event: JourneyEvent): JourneyState =>
  JourneyState.$match(state, {
    Home: () =>
      JourneyEvent.$match(event, {
        SelectTask: ({ task }) => entryForTask(task),
        Fail: ({ reason }) => JourneyState.RecoverableFailure({ reason }),
        BeginUpload: () => state,
        UploadSucceeded: () => state,
        UploadFailed: () => state,
        AnalysisSucceeded: () => state,
        AnalysisFailed: () => state,
        BeginResearch: () => state,
        ResearchSucceeded: () => state,
        ResearchEmpty: () => state,
        ResearchFailed: () => state,
        BeginOrderReview: () => state,
        ShowWaiterCard: () => state,
        GoBack: () => state,
        GoHome: () => state,
      }),
    Capture: () =>
      JourneyEvent.$match(event, {
        BeginUpload: () => JourneyState.Uploading({ task: "scan" }),
        Fail: ({ reason }) => JourneyState.RecoverableFailure({ reason }),
        UploadFailed: ({ reason }) => JourneyState.RecoverableFailure({ reason }),
        GoBack: () => JourneyState.Home(),
        GoHome: () => JourneyState.Home(),
        SelectTask: ({ task }) => entryForTask(task),
        UploadSucceeded: () => state,
        AnalysisSucceeded: () => state,
        AnalysisFailed: () => state,
        BeginResearch: () => state,
        ResearchSucceeded: () => state,
        ResearchEmpty: () => state,
        ResearchFailed: () => state,
        BeginOrderReview: () => state,
        ShowWaiterCard: () => state,
      }),
    Uploading: () =>
      JourneyEvent.$match(event, {
        UploadSucceeded: () => JourneyState.Analyzing({ task: "scan" }),
        UploadFailed: ({ reason }) => JourneyState.RecoverableFailure({ reason }),
        Fail: ({ reason }) => JourneyState.RecoverableFailure({ reason }),
        GoBack: () => JourneyState.Capture({ task: "scan" }),
        GoHome: () => JourneyState.Home(),
        SelectTask: ({ task }) => entryForTask(task),
        BeginUpload: () => state,
        AnalysisSucceeded: () => state,
        AnalysisFailed: () => state,
        BeginResearch: () => state,
        ResearchSucceeded: () => state,
        ResearchEmpty: () => state,
        ResearchFailed: () => state,
        BeginOrderReview: () => state,
        ShowWaiterCard: () => state,
      }),
    Analyzing: () =>
      JourneyEvent.$match(event, {
        AnalysisSucceeded: () => JourneyState.PresentingResults({ task: "scan" }),
        AnalysisFailed: ({ reason }) => JourneyState.RecoverableFailure({ reason }),
        Fail: ({ reason }) => JourneyState.RecoverableFailure({ reason }),
        GoBack: () => JourneyState.Capture({ task: "scan" }),
        GoHome: () => JourneyState.Home(),
        SelectTask: ({ task }) => entryForTask(task),
        BeginUpload: () => state,
        UploadSucceeded: () => state,
        UploadFailed: () => state,
        BeginResearch: () => state,
        ResearchSucceeded: () => state,
        ResearchEmpty: () => state,
        ResearchFailed: () => state,
        BeginOrderReview: () => state,
        ShowWaiterCard: () => state,
      }),
    Researching: ({ task }) =>
      JourneyEvent.$match(event, {
        ResearchSucceeded: () => JourneyState.PresentingResults({ task }),
        ResearchEmpty: () => JourneyState.PresentingResults({ task }),
        ResearchFailed: ({ reason }) => JourneyState.RecoverableFailure({ reason }),
        Fail: ({ reason }) => JourneyState.RecoverableFailure({ reason }),
        GoBack: () => JourneyState.Home(),
        GoHome: () => JourneyState.Home(),
        SelectTask: ({ task: next }) => entryForTask(next),
        BeginUpload: () => state,
        UploadSucceeded: () => state,
        UploadFailed: () => state,
        AnalysisSucceeded: () => state,
        AnalysisFailed: () => state,
        BeginResearch: () => state,
        BeginOrderReview: () => state,
        ShowWaiterCard: () => state,
      }),
    PresentingResults: ({ task }) =>
      JourneyEvent.$match(event, {
        BeginOrderReview: () => JourneyState.OrderReview(),
        BeginResearch: () => JourneyState.Researching({ task }),
        Fail: ({ reason }) => JourneyState.RecoverableFailure({ reason }),
        ResearchFailed: ({ reason }) => JourneyState.RecoverableFailure({ reason }),
        GoBack: () => (task === "scan" ? JourneyState.Capture({ task }) : JourneyState.Home()),
        GoHome: () => JourneyState.Home(),
        SelectTask: ({ task: next }) => entryForTask(next),
        BeginUpload: () => state,
        UploadSucceeded: () => state,
        UploadFailed: () => state,
        AnalysisSucceeded: () => state,
        AnalysisFailed: () => state,
        ResearchSucceeded: () => state,
        ResearchEmpty: () => state,
        ShowWaiterCard: () => state,
      }),
    OrderReview: () =>
      JourneyEvent.$match(event, {
        ShowWaiterCard: () => JourneyState.WaiterCard(),
        Fail: ({ reason }) => JourneyState.RecoverableFailure({ reason }),
        GoBack: () => JourneyState.Home(),
        GoHome: () => JourneyState.Home(),
        SelectTask: ({ task }) => entryForTask(task),
        BeginUpload: () => state,
        UploadSucceeded: () => state,
        UploadFailed: () => state,
        AnalysisSucceeded: () => state,
        AnalysisFailed: () => state,
        BeginResearch: () => state,
        ResearchSucceeded: () => state,
        ResearchEmpty: () => state,
        ResearchFailed: () => state,
        BeginOrderReview: () => state,
      }),
    WaiterCard: () =>
      JourneyEvent.$match(event, {
        GoBack: () => JourneyState.OrderReview(),
        GoHome: () => JourneyState.Home(),
        Fail: ({ reason }) => JourneyState.RecoverableFailure({ reason }),
        SelectTask: ({ task }) => entryForTask(task),
        BeginUpload: () => state,
        UploadSucceeded: () => state,
        UploadFailed: () => state,
        AnalysisSucceeded: () => state,
        AnalysisFailed: () => state,
        BeginResearch: () => state,
        ResearchSucceeded: () => state,
        ResearchEmpty: () => state,
        ResearchFailed: () => state,
        BeginOrderReview: () => state,
        ShowWaiterCard: () => state,
      }),
    RecoverableFailure: () =>
      JourneyEvent.$match(event, {
        GoBack: () => JourneyState.Home(),
        GoHome: () => JourneyState.Home(),
        SelectTask: ({ task }) => entryForTask(task),
        Fail: ({ reason }) => failFrom(state, reason),
        UploadFailed: ({ reason }) => failFrom(state, reason),
        AnalysisFailed: ({ reason }) => failFrom(state, reason),
        ResearchFailed: ({ reason }) => failFrom(state, reason),
        BeginUpload: () => state,
        UploadSucceeded: () => state,
        AnalysisSucceeded: () => state,
        BeginResearch: () => state,
        ResearchSucceeded: () => state,
        ResearchEmpty: () => state,
        BeginOrderReview: () => state,
        ShowWaiterCard: () => state,
      }),
  });

/**
 * Frozen turn-history contract (see plan §10): bounded recent conversation
 * context sent alongside the latest message. Chronological, capped turns
 * and per-turn length; never trusted server-side as evidence of database
 * facts or prior authorization — canonical ids re-resolve every request.
 */
export interface TurnHistoryItem {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/** Maximum history turns per chat request (plan §10 bound). */
export const MAX_HISTORY_TURNS = 6;

/** Maximum characters per history turn (plan §10 bound). */
export const MAX_HISTORY_CHARS = 2000;

/** Removable scope chips rendered above the thread (plan §17). */
export type MuseContextChipKind = "dish" | "venue" | "city" | "scan";

export interface MuseContextChip {
  readonly kind: MuseContextChipKind;
  readonly label: string;
}

/**
 * Typed request failure for one assistant turn. Rendered exhaustively in
 * the thread — never a generic "something went wrong", never raw JSON,
 * stack traces, or Zod internals (plan §18, addendum §7).
 */
export type MuseFailure = Data.TaggedEnum<{
  /** Connection failure (offline/network), distinct from model failure. */
  Transport: {};
  /** HTTP 429 with structured code; retry is manual, never immediate. */
  RateLimited: { readonly retryAfterSeconds: number | null };
  /** Provider temporarily unavailable; previous content preserved. */
  Unavailable: {};
  /** Response failed peer-shape validation; safe message only. */
  InvalidOutput: {};
  /** Feature requires sign-in; intended destination preserved. */
  AuthRequired: {};
  /** Vision/research disabled server-side; offer alternatives. */
  Disabled: {};
}>;

export const MuseFailure = Data.taggedEnum<MuseFailure>();

/**
 * One conversation turn owning its enrichment: main text, structured
 * cards, follow-ups, notice, and its own failure metadata (plan §10).
 * Photo bytes, ownership tokens, and secrets never live here — text only,
 * so session-scoped persistence stays privacy-safe. The `synthesized`
 * flag mirrors the peer contract: true only after a validated bounded
 * synthesis call, false for deterministic catalog assembly — the UI
 * captions it instead of claiming generation either way.
 */
export interface MuseTurn {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly cards: ReadonlyArray<CopilotCard>;
  readonly followUps: ReadonlyArray<string>;
  readonly notice: string | null;
  readonly failure: MuseFailure | null;
  readonly synthesized: boolean;
}
