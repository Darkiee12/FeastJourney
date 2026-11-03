import { useRouter } from "@tanstack/react-router";
import { ChevronLeft, MapPin, RotateCcw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
  ExchangeStatus,
  buildTurnHistory,
  persistThread,
  restoreThread,
  sendCopilotChat,
  sweepForeignThreads,
  type ChatRetryRequest,
  type StoredChatRetry,
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
  MuseAction,
  MuseFailure,
  museActionFromContract,
  type CopilotContext,
  type JourneyTask,
  type MuseContextChip,
  type MuseTurn,
  type SuggestedAction,
  type TurnHistoryItem,
} from "@/modules/muse-copilot/journey/types";
import { WorkspaceHero } from "@/modules/muse-copilot/shell/muse-landing";
import { TaskShortcutChips } from "@/modules/muse-copilot/shell/task-selector";
import { readStoredPlace } from "@/modules/restaurant-discovery/location-storage";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Options for one workspace exchange; defaults append a fresh user turn. */
interface StartExchangeOptions {
  readonly appendUser?: boolean | undefined;
  /** Replace this assistant turn instead of appending (retry path). */
  readonly replaceId?: string | undefined;
  /** Serializable chat retry persisted for reload recovery (chat only). */
  readonly chatRetry?: ChatRetryRequest | undefined;
  /** AbortSignal source; the workspace aborts it on unmount/Start Over. */
  readonly controller?: AbortController | undefined;
}

/** Retry replaces the failed assistant turn in place — never duplicates it. */
const replaceOrAppendTurn = (
  previous: ReadonlyArray<MuseTurn>,
  id: string,
  turn: MuseTurn,
): ReadonlyArray<MuseTurn> => {
  const index = previous.findIndex((entry) => entry.id === id);

  if (index === -1) {
    return [...previous, turn];
  }

  return previous.map((entry, position) => (position === index ? turn : entry));
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

  const [retryRequest, setRetryRequest] = useState<ChatRetryRequest | null>(() =>
    initial.retry === null ? null : { message: initial.retry.message, task: initial.retry.task },
  );

  const [exchangeStatus, setExchangeStatus] = useState<ExchangeStatus>(() =>
    initial.retry === null
      ? ExchangeStatus.Idle()
      : ExchangeStatus.AwaitingRetry({
          assistantTurnId: initial.retry.assistantTurnId,
          retryAfterSeconds: initial.retry.retryAfterSeconds,
        }),
  );

  const [stage, setStage] = useState<string | null>(null);

  const runId = useRef(0);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const turnsRef = useRef(turns);
  const retryInputRef = useRef<ExchangeInput | null>(null);
  const adoptedPlace = useRef(false);
  const photoRequestRef = useRef<PhotoRequestKind | null>(null);
  /**
   * Contract actions staged by the chat `work` closure for the turn it is
   * about to publish. Exchanges are single-flight (`busyRef`), so the value
   * set inside `work` is always consumed by the immediately following
   * `publishAssistant` before any other exchange can run. Photo exchanges
   * never stage actions, so they publish with an empty chip row.
   */
  const pendingActionsRef = useRef<ReadonlyArray<SuggestedAction> | null>(null);
  const router = useRouter();

  // One exhaustive read of the exchange lifecycle: busy, retry turn, and
  // Retry-After derive together, never as independent nullable states.
  const statusView: {
    readonly busy: boolean;
    readonly retryTurnId: string | null;
    readonly retryAfterSeconds: number | null;
  } = ExchangeStatus.$match(exchangeStatus, {
    Idle: () => ({ busy: false, retryTurnId: null, retryAfterSeconds: null }),
    Sending: () => ({ busy: true, retryTurnId: null, retryAfterSeconds: null }),
    AwaitingRetry: ({ assistantTurnId, retryAfterSeconds: retrySeconds }) => ({
      busy: false,
      retryTurnId: assistantTurnId,
      retryAfterSeconds: retrySeconds,
    }),
  });

  // Mirror for history building inside async work closures. Assigned in an
  // effect (never during render) so the ref never drives rendering.
  useEffect(() => {
    turnsRef.current = turns;
  });

  // Identity isolation: drop other accounts' threads on mount (sign-out and
  // account switching remount with a new key, which triggers this sweep).
  // Back/forward and task switches keep the key, so the thread survives.
  useEffect(() => {
    sweepForeignThreads(storageKey);
  }, [storageKey]);

  // Cancellation: abort the in-flight request on unmount (Start Over
  // remounts, so it cancels too) and invalidate its run so a late answer
  // can never land on a newer question.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      runId.current += 1;
    },
    [],
  );

  // Session-scoped persistence: text and peer-validated cards only — no
  // photo bytes, object-store keys, tokens, or ownership secrets. Chat
  // failures persist with their serializable retry; a reload restores them
  // as retryable instead of silently dropping context.
  useEffect(() => {
    const retry: StoredChatRetry | null =
      statusView.retryTurnId !== null && retryRequest !== null
        ? {
            ...retryRequest,
            assistantTurnId: statusView.retryTurnId,
            retryAfterSeconds: statusView.retryAfterSeconds,
          }
        : null;

    persistThread(storageKey, {
      turns,
      labels: [...labels.entries()],
      draft,
      retry,
    });
  }, [
    turns,
    labels,
    draft,
    retryRequest,
    storageKey,
    statusView.retryTurnId,
    statusView.retryAfterSeconds,
  ]);

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
    (
      id: number,
      outcome: ExchangeOutcome,
      options?: {
        readonly replaceId?: string | undefined;
        readonly chatRetry?: ChatRetryRequest | undefined;
      },
    ): void => {
      const consumePendingActions = (): ReadonlyArray<SuggestedAction> => {
        const staged = pendingActionsRef.current;
        pendingActionsRef.current = null;

        return staged ?? [];
      };

      ExchangeOutcome.$match(outcome, {
        ExchangeOk: (ok) => {
          const assistantId = options?.replaceId ?? `a-${id}`;

          setTurns((previous) =>
            replaceOrAppendTurn(previous, assistantId, {
              id: assistantId,
              role: "assistant",
              text: ok.text,
              cards: ok.cards,
              followUps: ok.followUps,
              actions: consumePendingActions(),
              notice: ok.notice,
              failure: null,
              synthesized: ok.synthesized,
            }),
          );

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

          setRetryRequest(null);
          retryInputRef.current = null;
          setExchangeStatus(ExchangeStatus.Idle());
        },
        ExchangeFailed: (failed) => {
          // Retry reuses this turn id, so the failed turn is replaced in
          // place instead of accumulating one failure turn per attempt.
          const assistantId = options?.replaceId ?? `a-${id}`;

          setTurns((previous) =>
            replaceOrAppendTurn(previous, assistantId, {
              id: assistantId,
              role: "assistant",
              text: "",
              cards: [],
              followUps: [],
              actions: [],
              notice: null,
              failure: failed.failure,
              synthesized: false,
            }),
          );

          const seconds = MuseFailure.$match(failed.failure, {
            RateLimited: ({ retryAfterSeconds: retrySeconds }) => retrySeconds,
            Transport: () => null,
            Unavailable: () => null,
            InvalidOutput: () => null,
            AuthRequired: () => null,
            Disabled: () => null,
          });

          // Only chat retries are serializable (photo Files cannot cross a
          // reload); photo failures stay retryable in-session via the closure
          // below and become context-preserving history after a reload.
          setRetryRequest(options?.chatRetry ?? null);
          setExchangeStatus(
            ExchangeStatus.AwaitingRetry({
              assistantTurnId: assistantId,
              retryAfterSeconds: seconds,
            }),
          );
        },
      });

      busyRef.current = false;
      setStage(null);
    },
    [onUpdateContext],
  );

  const startExchange = useCallback(
    (input: ExchangeInput, options?: StartExchangeOptions): void => {
      if (busyRef.current) {
        return;
      }

      busyRef.current = true;

      const id = runId.current + 1;
      runId.current = id;

      // Stale-request rejection: only the latest attempt may publish; a
      // late answer to an older question is dropped, never attached to the
      // newer thread.
      const alive = (): boolean => runId.current === id;

      if (options?.controller !== undefined) {
        abortRef.current?.abort();
        abortRef.current = options.controller;
      }

      if (options?.appendUser !== false) {
        setTurns((previous) => [
          ...previous,
          {
            id: `u-${id}`,
            role: "user",
            text: input.userText,
            cards: [],
            followUps: [],
            actions: [],
            notice: null,
            failure: null,
            synthesized: false,
          },
        ]);
      }

      // The resend key is the assistant-turn id this attempt resolves; a
      // retry reuses it (replaceId), so the attempt is idempotent — no
      // duplicate user turn, no forked failure turns.
      setExchangeStatus(ExchangeStatus.Sending({ resendKey: options?.replaceId ?? `a-${id}` }));
      setStage(input.stage);
      setRetryRequest(options?.chatRetry ?? null);

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
          publishAssistant(id, outcome, {
            replaceId: options?.replaceId,
            chatRetry: options?.chatRetry,
          });
        }
      })();
    },
    [publishAssistant],
  );

  const sendChatExchange = useCallback(
    (message: string, sendTask: JourneyTask, replaceId?: string): void => {
      const controller = new AbortController();
      // History and context rebuild at send time (and again at retry time),
      // so a retry revalidates against the current thread instead of
      // replaying a stale snapshot.
      const history: ReadonlyArray<TurnHistoryItem> = buildTurnHistory(turnsRef.current);
      const requestContext = context;

      startExchange(
        {
          task: sendTask,
          userText: message,
          stage: stageForTask(copy, sendTask),
          work: async () => {
            const result = await sendCopilotChat(
              { message, task: sendTask, context: requestContext },
              history,
              { signal: controller.signal },
            );

            return ChatSendResult.$match(result, {
              ChatOk: ({ output }) => {
                pendingActionsRef.current = output.actions.map((action): SuggestedAction => ({
                  label: action.label,
                  action: museActionFromContract(action),
                }));

                return ExchangeOutcome.ExchangeOk({
                  text: output.reply,
                  cards: output.cards,
                  followUps: output.followUps,
                  notice: null,
                  synthesized: output.synthesized,
                });
              },
              ChatFailed: ({ failure }) => ExchangeOutcome.ExchangeFailed({ failure }),
            });
          },
        },
        {
          appendUser: replaceId === undefined,
          replaceId,
          chatRetry: { message, task: sendTask },
          controller,
        },
      );
    },
    [context, copy, startExchange],
  );

  const retryFailed = useCallback((): void => {
    const failedId = ExchangeStatus.$match(exchangeStatus, {
      Idle: () => null,
      Sending: () => null,
      AwaitingRetry: ({ assistantTurnId }) => assistantTurnId,
    });

    if (failedId === null) {
      return;
    }

    // Chat retries rebuild fresh (revalidated history/context); photo
    // retries reuse the in-session closure, which itself reuses the owned
    // scan instead of uploading again.
    if (retryRequest !== null) {
      sendChatExchange(retryRequest.message, retryRequest.task, failedId);
    } else {
      const input = retryInputRef.current;

      if (input !== null) {
        startExchange(input, { appendUser: false, replaceId: failedId });
      }
    }
  }, [exchangeStatus, retryRequest, sendChatExchange, startExchange]);

  const sendText = useCallback(
    (text: string, taskOverride?: JourneyTask): void => {
      sendChatExchange(text, taskOverride ?? task);
    },
    [sendChatExchange, task],
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
        actions: [],
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
      busy: statusView.busy,
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
      statusView.busy,
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

  /**
   * Typed action dispatch (plan §17): every action chip and card action
   * produces one `MuseAction` handled exhaustively here. AskQuestion sends
   * text in the current thread; OpenRoute pushes a genuine history entry;
   * tool activation and task switches stay in place so Back never steps
   * through previous tool selections. Defined after `api` because OpenTool
   * photo capture routes through it.
   */
  const handleAction = useCallback(
    (action: MuseAction): void => {
      MuseAction.$match(action, {
        AskQuestion: ({ question }) => {
          sendText(question);
        },
        OpenRoute: ({ search, to }) => {
          const query = new URLSearchParams(search).toString();
          router.history.push(query === "" ? to : `${to}?${query}`);
        },
        OpenTool: ({ tool }) => {
          if (tool === "camera" || tool === "gallery") {
            api.requestPhoto(tool);
          } else if (tool === "location") {
            onSelectTask("find");
          } else if (tool === "scanner") {
            onSelectTask("scan");
          } else {
            onSelectTask("order");
          }
        },
        SetContext: (patch) => {
          onUpdateContext(patch);
        },
        BrowseDishes: () => {
          void router.navigate({ to: "/dishes", search: { lang: context.language } });
        },
        FindRestaurants: ({ dishId }) => {
          if (dishId !== undefined) {
            onUpdateContext({ dishId });
          }

          onSelectTask("find");
        },
        ResumeScan: ({ scanId }) => {
          onUpdateContext({ scanId });
          onSelectTask("scan");
        },
        OpenOrder: ({ scanId, venueId }) => {
          onUpdateContext({ venueId, scanId });
          onSelectTask("order");
        },
      });
    },
    [api, context.language, onSelectTask, onUpdateContext, router, sendText],
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
    busy: statusView.busy,
    copy,
    language: context.language,
    onPickAction: handleAction,
    onPickFollowUp: sendText,
    onRetry: statusView.retryTurnId === null ? null : retryFailed,
    onUpdateContext,
    pendingStage: <ProcessingIndicator stage={statusView.busy ? stage : null} />,
    retryAfterSeconds: statusView.retryAfterSeconds,
    retryTurnId: statusView.retryTurnId,
    signIn: { lang: context.language, returnTo: "/muse" },
    turns,
  };

  const goBack = (): void => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.history.back();
    } else {
      void router.navigate({ to: "/", search: { lang: context.language } });
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

      <TaskShortcutChips active={task} context={context} copy={copy} onSelect={onSelectTask} />

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
                  busy={statusView.busy}
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
            busy={statusView.busy}
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
