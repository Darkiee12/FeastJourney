import { Check, Copy, Sparkles, User } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import { CopilotCards } from "@/modules/muse-copilot/flows/conversation-cards";
import {
  ActionChips,
  FollowUpChips,
  RecoverableError,
} from "@/modules/muse-copilot/flows/conversation-feedback";
import type {
  CopilotContext,
  MuseAction,
  MuseFailure,
  MuseTurn,
} from "@/modules/muse-copilot/journey/types";
import type { Locale } from "@/shared/i18n";

export interface ConversationViewportProps {
  readonly busy: boolean;
  readonly children?: ReactNode | undefined;
  readonly copy: CopilotCopy;
  readonly language: Locale;
  readonly onPickAction: (action: MuseAction) => void;
  readonly onPickFollowUp: (text: string) => void;
  readonly onRetry: (() => void) | null;
  readonly onUpdateContext: (patch: Partial<CopilotContext>) => void;
  readonly pendingStage: ReactNode;
  readonly retryAfterSeconds: number | null;
  readonly retryTurnId: string | null;
  readonly signIn: { readonly lang: Locale; readonly returnTo: string } | null;
  readonly turns: ReadonlyArray<MuseTurn>;
}

/**
 * Copy/inspect affordance for assistant answers (plan §9): copies plain
 * text only. Clipboard failures degrade silently — the answer stays on
 * screen, so nothing depends on the copy succeeding.
 */
function CopyAnswer({ copy, text }: { readonly copy: CopilotCopy; readonly text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            timer.current = window.setTimeout(() => setCopied(false), 2000);
          },
          () => undefined,
        );
      }}
      aria-label={copy.copyAnswer}
      title={copied ? copy.copiedAnswer : copy.copyAnswer}
      className="inline-flex size-9 cursor-pointer items-center justify-center rounded-full text-muted transition hover:bg-cream hover:text-ink"
    >
      {copied ? (
        <Check aria-hidden="true" className="size-4" />
      ) : (
        <Copy aria-hidden="true" className="size-4" />
      )}
    </button>
  );
}

/**
 * Small Sparkles badge avatar: the consistent Muse identity marker
 * (mockups show a mascot; no Muse character asset exists in the repo, so
 * the Sparkles badge stands in — never an invented mascot).
 */
export function MuseAvatar() {
  return (
    <span
      aria-hidden="true"
      className="flex size-7 flex-none items-center justify-center rounded-full bg-space-deep text-mango"
    >
      <Sparkles className="size-3.5" />
    </span>
  );
}

function UserBubble({ copy, text }: { readonly copy: CopilotCopy; readonly text: string }) {
  return (
    <div className="flex items-end justify-end gap-2">
      <p className="max-w-[85%] min-w-0 rounded-2xl rounded-br-md border border-brand-blue/25 bg-brand-blue/10 px-4 py-3 text-sm leading-relaxed break-words whitespace-pre-wrap text-ink">
        <span className="sr-only">{`${copy.youLabel}: `}</span>
        {text}
      </p>

      <span
        aria-hidden="true"
        className="flex size-7 flex-none items-center justify-center rounded-full bg-space-deep/10 text-muted"
      >
        <User className="size-3.5" />
      </span>
    </div>
  );
}

/**
 * One assistant turn owning its enrichment: main text, structured cards,
 * follow-ups, notice, and its own failure metadata (plan §10). Text is
 * plain (`whitespace-pre-wrap`) — model output never becomes HTML.
 */
function AssistantBlock({
  busy,
  copy,
  language,
  onPickAction,
  onPickFollowUp,
  onRetry,
  onUpdateContext,
  retryAfterSeconds,
  signIn,
  turn,
}: {
  readonly busy: boolean;
  readonly copy: CopilotCopy;
  readonly language: Locale;
  readonly onPickAction: (action: MuseAction) => void;
  readonly onPickFollowUp: (text: string) => void;
  readonly onRetry: (() => void) | null;
  readonly onUpdateContext: (patch: Partial<CopilotContext>) => void;
  readonly retryAfterSeconds: number | null;
  readonly signIn: { readonly lang: Locale; readonly returnTo: string } | null;
  readonly turn: MuseTurn;
}): ReactNode {
  const failure: MuseFailure | null = turn.failure;

  // Short text-only replies stay compact: tighter padding, smaller
  // provenance caption — no card chrome for a one-line answer (plan §12).
  const compact =
    turn.text !== "" &&
    turn.text.length <= 160 &&
    turn.cards.length === 0 &&
    turn.followUps.length === 0 &&
    turn.actions.length === 0 &&
    (turn.notice === null || turn.notice === "") &&
    failure === null;

  return (
    <div className="flex items-start gap-2">
      <MuseAvatar />

      <div
        className={
          compact
            ? "flex min-w-0 flex-1 flex-col gap-1.5 rounded-2xl rounded-bl-md border border-border-soft bg-white px-3.5 py-2.5 shadow-[0_1px_2px_rgba(3,10,30,0.08)]"
            : "flex min-w-0 flex-1 flex-col gap-2 rounded-2xl rounded-bl-md border border-border-soft bg-white px-4 py-3 shadow-[0_1px_2px_rgba(3,10,30,0.08)]"
        }
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-bold tracking-[0.14em] text-food-orange-strong uppercase">
            {copy.museLabel}
          </p>

          <CopyAnswer copy={copy} text={turn.text} />
        </div>

        {turn.text === "" ? null : (
          <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-ink">
            {turn.text}
          </p>
        )}

        {turn.text === "" ? null : (
          <p className="text-[11px] font-semibold tracking-wide text-muted">
            {turn.synthesized ? copy.provenanceSynthesized : copy.provenanceCatalog}
          </p>
        )}

        {turn.notice === null || turn.notice === "" ? null : (
          <p className="text-xs leading-relaxed text-muted">{turn.notice}</p>
        )}

        <CopilotCards
          cards={turn.cards}
          copy={copy}
          language={language}
          onAction={onPickAction}
          onUpdateContext={onUpdateContext}
        />

        <FollowUpChips busy={busy} copy={copy} items={turn.followUps} onPick={onPickFollowUp} />

        <ActionChips busy={busy} items={turn.actions} onPick={onPickAction} />

        {failure === null || onRetry === null ? null : (
          <RecoverableError
            copy={copy}
            failure={failure}
            onRetry={onRetry}
            retryAfterSeconds={retryAfterSeconds}
            signIn={signIn}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Scrollable conversation viewport. The message list owns scrolling
 * (plan §5): the workspace bounds this container, and auto-scroll only
 * engages while the visitor is already near the bottom, so reading older
 * content is never yanked away. Honors reduced motion.
 */
export function ConversationViewport({
  busy,
  children,
  copy,
  language,
  onPickAction,
  onPickFollowUp,
  onRetry,
  onUpdateContext,
  pendingStage,
  retryAfterSeconds,
  retryTurnId,
  signIn,
  turns,
}: ConversationViewportProps): ReactNode {
  const listRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const seenTurnsRef = useRef(turns.length);
  const seenBusyRef = useRef(busy);

  // Intentionally runs every render: auto-scroll engages only when a new
  // turn lands (or a pending indicator starts) while the visitor is already
  // near the bottom, so reading older content is never yanked away. No dep
  // array guard is needed because every branch below is state-compared.
  useEffect(() => {
    const grew = seenTurnsRef.current !== turns.length;
    const started = !seenBusyRef.current && busy;

    seenTurnsRef.current = turns.length;
    seenBusyRef.current = busy;

    if ((!grew && !started) || !nearBottomRef.current) {
      return;
    }

    const element = listRef.current;

    if (element === null) {
      return;
    }

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    element.scrollTo({ top: element.scrollHeight, behavior: reduce ? "instant" : "smooth" });
  });

  return (
    <div
      ref={listRef}
      onScroll={(event) => {
        const target = event.currentTarget;

        nearBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 96;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      aria-live="off"
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 py-4 sm:px-5">
        {children}

        {turns.map((turn) =>
          turn.role === "user" ? (
            <UserBubble key={turn.id} copy={copy} text={turn.text} />
          ) : (
            <AssistantBlock
              key={turn.id}
              busy={busy}
              copy={copy}
              language={language}
              onPickAction={onPickAction}
              onPickFollowUp={onPickFollowUp}
              onRetry={retryTurnId === turn.id ? onRetry : null}
              onUpdateContext={onUpdateContext}
              retryAfterSeconds={retryAfterSeconds}
              signIn={signIn}
              turn={turn}
            />
          ),
        )}

        {pendingStage}
      </div>
    </div>
  );
}
