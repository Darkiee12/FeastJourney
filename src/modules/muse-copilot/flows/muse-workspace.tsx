import { useRouter } from "@tanstack/react-router";
import { ChevronLeft, MapPin, RotateCcw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { z } from "zod";

import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import { AskPanel } from "@/modules/muse-copilot/flows/ask-flow";
import {
  ConversationComposer,
  PhotoAttachButtons,
} from "@/modules/muse-copilot/flows/conversation-composer";
import {
  ContextChipRow,
  ProcessingIndicator,
} from "@/modules/muse-copilot/flows/conversation-feedback";
import {
  ChatSendResult,
  buildTurnHistory,
  sendCopilotChat,
} from "@/modules/muse-copilot/flows/conversation-model";
import {
  ConversationViewport,
  type ConversationViewportProps,
} from "@/modules/muse-copilot/flows/conversation-viewport";
import { FindPanel } from "@/modules/muse-copilot/flows/find-flow";
import { OrderPanel } from "@/modules/muse-copilot/flows/order-flow";
import { PlatePanel } from "@/modules/muse-copilot/flows/plate-flow";
import { ScanPanel } from "@/modules/muse-copilot/flows/scan-flow";
import {
  ExchangeOutcome,
  KNOWN_CITIES,
  type ExchangeInput,
  type PhotoRequestKind,
  type WorkspacePanelApi,
} from "@/modules/muse-copilot/flows/task-panel";
import {
  MuseFailure,
  type CopilotContext,
  type JourneyTask,
  type MuseContextChip,
  type MuseTurn,
  type TurnHistoryItem,
} from "@/modules/muse-copilot/journey/types";
import { WorkspaceHero } from "@/modules/muse-copilot/shell/muse-landing";
import { TaskShortcutChips } from "@/modules/muse-copilot/shell/task-selector";
import { readStoredPlace } from "@/modules/restaurant-discovery/location-storage";
import { copilotCardSchema } from "@/server/muse-copilot/copilot-schemas";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_STORED_TURNS = 20;

const MAX_STORED_CHARS = 2000;

export interface MuseWorkspaceProps {
  readonly copy: CopilotCopy;
  readonly task: JourneyTask;
  readonly context: CopilotContext;
  readonly signedIn: boolean;
  /** Identity- and language-scoped thread storage; remounts never leak across it. */
  readonly storageKey: string;
  readonly onUpdateContext: (patch: Partial<CopilotContext>) => void;
  readonly onSelectTask: (task: JourneyTask) => void;
  readonly onStartOver: () => void;
}

interface StoredThread {
  readonly turns: ReadonlyArray<MuseTurn>;
  readonly labels: ReadonlyArray<readonly [string, string]>;
  readonly draft: string;
}

/**
 * Session storage boundary: the stored thread re-validates through Zod
 * (peer card schema included, so enrichment survives a reload). Failed
 * turns never persist — their retry thunk cannot cross a reload, so they
 * drop and the prior history stands on its own.
 */
const storedThreadSchema = z.object({
  turns: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(["user", "assistant"]),
        text: z.string(),
        cards: z.array(copilotCardSchema).default([]),
        followUps: z.array(z.string()).default([]),
        notice: z.string().nullable().default(null),
        failed: z.boolean().default(false),
        synthesized: z.boolean().default(false),
      }),
    )
    .default([]),
  labels: z.array(z.tuple([z.string(), z.string()])).default([]),
  draft: z.string().default(""),
});

const restoreThread = (storageKey: string): StoredThread => {
  try {
    const raw = window.sessionStorage.getItem(`fj.muse-thread.v1.${storageKey}`);

    if (raw === null) {
      return { turns: [], labels: [], draft: "" };
    }

    const parsed = storedThreadSchema.safeParse(JSON.parse(raw));

    if (!parsed.success) {
      return { turns: [], labels: [], draft: "" };
    }

    const turns = parsed.data.turns
      .filter((turn) => !turn.failed)
      .slice(-MAX_STORED_TURNS)
      .map((turn): MuseTurn => ({
        id: turn.id,
        role: turn.role,
        text: turn.text.slice(0, MAX_STORED_CHARS),
        cards: turn.cards,
        followUps: turn.followUps,
        notice: turn.notice,
        failure: null,
        synthesized: turn.synthesized,
      }));

    const labels = parsed.data.labels.slice(-MAX_STORED_TURNS);
    const draft = parsed.data.draft.slice(0, MAX_STORED_CHARS);

    return { turns, labels, draft };
  } catch {
    return { turns: [], labels: [], draft: "" };
  }
};

const stageForTask = (copy: CopilotCopy, task: JourneyTask): string => {
  if (task === "find") {
    return copy.thinkingPlaces;
  }

  if (task === "plate") {
    return copy.thinkingPhoto;
  }

  return copy.thinkingCatalog;
};

/**
 * The single Muse workspace (plan §4): one heading, one thread, one
 * composer. Every assistant response owns its cards, follow-ups, notice,
 * and failure metadata; history ships bounded and validated; retries
 * resend the real request. Task panels plug in above the composer without
 * forking the conversation. Galaxy theme: navy workspace, blue message
 * surfaces, cream cards — never ink-on-navy.
 */
export function MuseWorkspace({
  context,
  copy,
  onSelectTask,
  onStartOver,
  onUpdateContext,
  signedIn,
  storageKey,
  task,
}: MuseWorkspaceProps): ReactNode {
  const [initial] = useState(() => restoreThread(storageKey));
  const [turns, setTurns] = useState<ReadonlyArray<MuseTurn>>(() => initial.turns);
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(() => new Map(initial.labels));
  const [draft, setDraft] = useState(() => initial.draft);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [retryTurnId, setRetryTurnId] = useState<string | null>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null);

  const runId = useRef(0);
  const busyRef = useRef(false);
  const turnsRef = useRef(turns);
  const retryInputRef = useRef<ExchangeInput | null>(null);
  const adoptedPlace = useRef(false);
  const photoRequestRef = useRef<PhotoRequestKind | null>(null);
  const router = useRouter();

  // Mirror for history building inside async work closures. Assigned in an
  // effect (never during render) so the ref never drives rendering.
  useEffect(() => {
    turnsRef.current = turns;
  });

  // Session-scoped persistence: text and peer-validated cards only — no
  // photo bytes, no tokens, no ownership secrets.
  useEffect(() => {
    try {
      const payload = JSON.stringify({
        turns: turns.slice(-MAX_STORED_TURNS).map((turn) => ({
          id: turn.id,
          role: turn.role,
          text: turn.text.slice(0, MAX_STORED_CHARS),
          cards: turn.cards,
          followUps: turn.followUps,
          notice: turn.notice,
          failed: turn.failure !== null,
          synthesized: turn.synthesized,
        })),
        labels: [...labels.entries()].slice(-MAX_STORED_TURNS),
        draft: draft.slice(0, MAX_STORED_CHARS),
      });

      window.sessionStorage.setItem(`fj.muse-thread.v1.${storageKey}`, payload);
    } catch {
      // Private mode or quota: the live thread still works for the session.
    }
  }, [turns, labels, draft, storageKey]);

  // Adopt the previously stored city once, when the route carries none.
  useEffect(() => {
    if (adoptedPlace.current) {
      return;
    }

    adoptedPlace.current = true;

    if (context.city !== undefined) {
      return;
    }

    const stored = readStoredPlace();

    if (stored === null) {
      return;
    }

    const known = KNOWN_CITIES.find((entry) => entry.id === stored.id);

    if (known !== undefined) {
      onUpdateContext({ city: known.city, country: known.country });
    }
  }, [context.city, onUpdateContext]);

  const publishAssistant = useCallback(
    (id: number, outcome: ExchangeOutcome): void => {
      ExchangeOutcome.$match(outcome, {
        ExchangeOk: (ok) => {
          const assistantId = `a-${id}`;

          setTurns((previous) => [
            ...previous,
            {
              id: assistantId,
              role: "assistant",
              text: ok.text,
              cards: ok.cards,
              followUps: ok.followUps,
              notice: ok.notice,
              failure: null,
              synthesized: ok.synthesized,
            },
          ]);

          if (ok.cards.length > 0) {
            setLabels((previous) => {
              const next = new Map(previous);

              for (const card of ok.cards) {
                if (card.refId !== undefined && card.title !== "") {
                  next.set(card.refId, card.title);
                }
              }

              return next;
            });

            const dishCard = ok.cards.find((card) => card.kind === "dish");

            const venueCard = ok.cards.find(
              (card) =>
                card.kind === "restaurant" &&
                card.refId !== undefined &&
                UUID_PATTERN.test(card.refId),
            );

            if (dishCard?.refId !== undefined || venueCard?.refId !== undefined) {
              onUpdateContext({
                dishId: dishCard?.refId,
                venueId: venueCard?.refId,
              });
            }
          }

          setRetryTurnId(null);
          setRetryAfterSeconds(null);
          retryInputRef.current = null;
        },
        ExchangeFailed: (failed) => {
          const assistantId = `a-${id}`;

          setTurns((previous) => [
            ...previous,
            {
              id: assistantId,
              role: "assistant",
              text: "",
              cards: [],
              followUps: [],
              notice: null,
              failure: failed.failure,
              synthesized: false,
            },
          ]);

          const seconds = MuseFailure.$match(failed.failure, {
            RateLimited: ({ retryAfterSeconds: retrySeconds }) => retrySeconds,
            Transport: () => null,
            Unavailable: () => null,
            InvalidOutput: () => null,
            AuthRequired: () => null,
            Disabled: () => null,
          });

          setRetryTurnId(assistantId);
          setRetryAfterSeconds(seconds);
        },
      });

      setBusy(false);
      busyRef.current = false;
      setStage(null);
    },
    [onUpdateContext],
  );

  const startExchange = useCallback(
    (input: ExchangeInput, appendUser = true): void => {
      if (busyRef.current) {
        return;
      }

      busyRef.current = true;

      const id = runId.current + 1;
      runId.current = id;

      const alive = (): boolean => runId.current === id;

      if (appendUser) {
        setTurns((previous) => [
          ...previous,
          {
            id: `u-${id}`,
            role: "user",
            text: input.userText,
            cards: [],
            followUps: [],
            notice: null,
            failure: null,
            synthesized: false,
          },
        ]);
      }

      setBusy(true);
      setStage(input.stage);
      setRetryTurnId(null);
      setRetryAfterSeconds(null);

      retryInputRef.current = input;

      void (async () => {
        let outcome: ExchangeOutcome;

        try {
          outcome = await input.work();
        } catch {
          outcome = ExchangeOutcome.ExchangeFailed({
            failure: MuseFailure.InvalidOutput(),
          });
        }

        if (alive()) {
          publishAssistant(id, outcome);
        }
      })();
    },
    [publishAssistant],
  );

  const retryFailed = useCallback((): void => {
    const input = retryInputRef.current;

    if (input !== null) {
      startExchange(input, false);
    }
  }, [startExchange]);

  const sendText = useCallback(
    (text: string, taskOverride?: JourneyTask): void => {
      const sendTask = taskOverride ?? task;
      const history: ReadonlyArray<TurnHistoryItem> = buildTurnHistory(turnsRef.current);
      const requestContext = context;

      startExchange({
        task: sendTask,
        userText: text,
        stage: stageForTask(copy, sendTask),
        work: async () => {
          const result = await sendCopilotChat(
            { message: text, task: sendTask, context: requestContext },
            history,
          );

          return ChatSendResult.$match(result, {
            ChatOk: ({ output }) =>
              ExchangeOutcome.ExchangeOk({
                text: output.reply,
                cards: output.cards,
                followUps: output.followUps,
                notice: null,
                synthesized: output.synthesized,
              }),
            ChatFailed: ({ failure }) => ExchangeOutcome.ExchangeFailed({ failure }),
          });
        },
      });
    },
    [context, copy, startExchange, task],
  );

  const publishNote = useCallback((text: string): void => {
    const id = runId.current + 1;
    runId.current = id;

    setTurns((previous) => [
      ...previous,
      {
        id: `a-${id}`,
        role: "assistant",
        text,
        cards: [],
        followUps: [],
        notice: null,
        failure: null,
        synthesized: false,
      },
    ]);
  }, []);

  const changeDraft = useCallback((next: string): void => {
    setDraft(next);
  }, []);

  const submitDraft = useCallback(
    (text: string): void => {
      setDraft("");
      sendText(text);
    },
    [sendText],
  );

  const api: WorkspacePanelApi = useMemo(
    () => ({
      copy,
      context,
      task,
      busy,
      signedIn,
      onUpdateContext,
      startExchange,
      publishNote,
      selectTask: onSelectTask,
      setDraft: changeDraft,
      requestPhoto: (kind: PhotoRequestKind): void => {
        photoRequestRef.current = kind;

        if (task !== "plate") {
          onSelectTask("plate");
        }
      },
      consumePhotoRequest: (): PhotoRequestKind | null => {
        const pending = photoRequestRef.current;

        photoRequestRef.current = null;

        return pending;
      },
    }),
    [
      busy,
      changeDraft,
      context,
      copy,
      onSelectTask,
      onUpdateContext,
      publishNote,
      signedIn,
      startExchange,
      task,
    ],
  );

  const chips: ReadonlyArray<MuseContextChip> = useMemo(() => {
    const next: Array<MuseContextChip> = [];

    if (context.city !== undefined && context.city.trim() !== "") {
      next.push({ kind: "city", label: context.city });
    }

    if (context.dishId !== undefined) {
      const label = labels.get(context.dishId);

      if (label !== undefined) {
        next.push({ kind: "dish", label: copy.chipAboutDish.replace("{name}", label) });
      }
    }

    if (context.venueId !== undefined) {
      const label = labels.get(context.venueId);

      if (label !== undefined) {
        next.push({ kind: "venue", label: copy.chipAboutVenue.replace("{name}", label) });
      }
    }

    if (context.scanId !== undefined) {
      next.push({ kind: "scan", label: copy.chipScan });
    }

    return next;
  }, [context.city, context.dishId, context.scanId, context.venueId, copy, labels]);

  const removeChip = useCallback(
    (chip: MuseContextChip): void => {
      if (chip.kind === "city") {
        onUpdateContext({ city: undefined, country: undefined });
      } else if (chip.kind === "dish") {
        onUpdateContext({ dishId: undefined });
      } else if (chip.kind === "venue") {
        onUpdateContext({ venueId: undefined });
      } else {
        onUpdateContext({ scanId: undefined });
      }
    },
    [onUpdateContext],
  );

  let panel: ReactNode = null;

  if (task === "find") {
    panel = <FindPanel {...api} />;
  } else if (task === "plate") {
    panel = <PlatePanel {...api} />;
  } else if (task === "scan") {
    panel = <ScanPanel {...api} />;
  } else if (task === "order") {
    panel = <OrderPanel {...api} />;
  } else {
    panel = <AskPanel {...api} />;
  }

  const viewportProps: ConversationViewportProps = {
    busy,
    copy,
    language: context.language,
    onPickFollowUp: sendText,
    onRetry: retryTurnId === null ? null : retryFailed,
    onSelectTask,
    onUpdateContext,
    pendingStage: <ProcessingIndicator stage={busy ? stage : null} />,
    retryAfterSeconds,
    retryTurnId,
    signIn: { lang: context.language, returnTo: "/muse" },
    turns,
  };

  const goBack = (): void => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.history.back();
    }
  };

  const showPhotoButtons = turns.length === 0 || task === "plate";

  return (
    <section aria-label={copy.workspaceTitle} className="muse-workspace">
      <header className="muse-workspace-toolbar">
        <button
          type="button"
          onClick={goBack}
          className="muse-workspace-icon-button"
          aria-label={copy.back}
          title={copy.back}
        >
          <ChevronLeft aria-hidden="true" className="size-5" />
        </button>

        <p className="muse-workspace-identity">
          <Sparkles aria-hidden="true" className="size-4 flex-none text-mango" />
          <span>
            {copy.workspaceTitle} <span aria-hidden="true">✨</span>
          </span>
        </p>

        <div className="muse-workspace-toolbar-actions">
          <button
            type="button"
            onClick={() => {
              onSelectTask("find");
            }}
            className="muse-workspace-city"
            aria-label={copy.changeCity}
            title={copy.changeCity}
          >
            <MapPin aria-hidden="true" className="size-3.5 flex-none text-mango" />
            <span>{context.city ?? copy.locationChoose}</span>
          </button>

          <button
            type="button"
            onClick={onStartOver}
            className="muse-workspace-icon-button"
            aria-label={copy.startOver}
            title={copy.startOver}
          >
            <RotateCcw aria-hidden="true" className="size-4" />
          </button>
        </div>
      </header>

      <TaskShortcutChips active={task} copy={copy} onSelect={onSelectTask} />

      <div className="muse-workspace-card">
        {chips.length === 0 ? null : (
          <div className="muse-workspace-chips">
            <ContextChipRow chips={chips} copy={copy} onRemove={removeChip} />
          </div>
        )}

        <ConversationViewport {...viewportProps}>
          {turns.length === 0 ? (
            <WorkspaceHero
              city={context.city}
              copy={copy}
              onSelectTask={onSelectTask}
              onSend={sendText}
            />
          ) : (
            panel
          )}
        </ConversationViewport>

        <footer className="muse-workspace-composer">
          <ConversationComposer
            attach={
              showPhotoButtons ? (
                <PhotoAttachButtons
                  busy={busy}
                  cameraLabel={copy.photoCameraLabel}
                  galleryLabel={copy.photoGalleryLabel}
                  onCamera={() => {
                    api.requestPhoto("camera");
                  }}
                  onGallery={() => {
                    api.requestPhoto("gallery");
                  }}
                />
              ) : undefined
            }
            busy={busy}
            copy={copy}
            draft={draft}
            followUp={turns.length > 0}
            onDraftChange={changeDraft}
            onSend={submitDraft}
          />
        </footer>
      </div>
    </section>
  );
}
