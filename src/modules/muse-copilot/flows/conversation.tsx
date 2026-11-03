import { Link } from "@tanstack/react-router";
import { Match } from "effect";
import { LoaderCircle, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import {
  MuseResearchStatus,
  type ResearchStatusState,
} from "@/components/research/muse-research-status";
import { researchCopyFor } from "@/components/research/research-copy";
import {
  ResearchFindingsList,
  type ResearchFinding,
} from "@/components/research/research-findings";
import type { CopilotContext, FlowProps } from "@/modules/muse-copilot/journey/types";
import type { CopilotCard } from "@/server/muse-copilot/copilot-schemas";
import type { ResearchOutcome } from "@/server/web-research/research-types";

export type { CopilotContext, FlowProps };

/** One chat turn. Plain text only — provider output is never rendered as HTML. */
export interface CopilotMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

/**
 * Boundary mapper for peer research outcomes. `ResearchFound` findings pass
 * through; every other tag (or an unmappable shape) yields null so callers
 * fall back to the honest no-evidence state instead of inventing results.
 */
export const parseResearchOutcome = (
  outcome: ResearchOutcome,
): ReadonlyArray<ResearchFinding> | null =>
  Match.value(outcome).pipe(
    Match.tag("ResearchFound", ({ findings }) => [...findings]),
    Match.orElse(() => null),
  );

/**
 * Single-column flow frame. Mobile-first with safe-area bottom padding;
 * never introduces nested scroll containers (no scroll traps) and never
 * fixes or sticks content over the reading area.
 */
export function FlowShell({
  children,
  intro,
  title,
}: {
  readonly children: ReactNode;
  readonly intro?: string | undefined;
  readonly title: string;
}): ReactNode {
  return (
    <section
      aria-label={title}
      className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))]"
    >
      <header className="flex flex-col gap-1">
        <h2 className="font-display text-2xl leading-tight tracking-wide text-ink">{title}</h2>

        {intro === undefined || intro === "" ? null : (
          <p className="text-sm leading-relaxed text-muted">{intro}</p>
        )}
      </header>

      {children}
    </section>
  );
}

/**
 * Role-clear conversation thread. Assistant turns render as structured
 * cards with an explicit "Muse" heading and plain-text body
 * (`whitespace-pre-wrap`, no markdown, no HTML injection surface);
 * user turns render as their own labeled card. Empty text never renders.
 */
export function ConversationThread({
  messages,
  museLabel,
  youLabel,
}: {
  readonly messages: ReadonlyArray<CopilotMessage>;
  readonly museLabel: string;
  readonly youLabel: string;
}): ReactNode {
  if (messages.length === 0) {
    return null;
  }

  return (
    <ol aria-live="polite" className="flex flex-col gap-3">
      {messages.map((message) =>
        message.role === "user" ? (
          <li
            key={message.id}
            className="self-end rounded-2xl rounded-br-md border-2 border-ink bg-white px-4 py-3 text-sm leading-relaxed break-words whitespace-pre-wrap text-ink"
          >
            <span className="sr-only">{`${youLabel}: `}</span>

            {message.text}
          </li>
        ) : (
          <li
            key={message.id}
            className="self-start rounded-2xl rounded-bl-md border border-border-soft bg-cream/60 px-4 py-3 text-sm leading-relaxed break-words text-ink shadow-[0_12px_28px_rgba(194,65,12,0.08)]"
          >
            <p className="mb-1 text-xs font-bold tracking-[0.14em] text-food-orange-strong uppercase">
              {museLabel}
            </p>

            <p className="whitespace-pre-wrap">{message.text}</p>
          </li>
        ),
      )}
    </ol>
  );
}

/**
 * Single-line composer. Owned input state clears only after the parent
 * accepts the message; the send button stays disabled while busy or when
 * the trimmed input is empty. Touch targets meet min-h-11.
 */
export function Composer({
  busy,
  onSend,
  placeholder,
  sendLabel,
}: {
  readonly busy: boolean;
  readonly onSend: (text: string) => void;
  readonly placeholder: string;
  readonly sendLabel: string;
}): ReactNode {
  const [draft, setDraft] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const text = draft.trim();

    if (text === "" || busy) {
      return;
    }

    setDraft("");
    onSend(text);
  };

  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <label htmlFor="copilot-composer" className="sr-only">
        {placeholder}
      </label>

      <input
        id="copilot-composer"
        type="text"
        value={draft}
        disabled={busy}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        placeholder={placeholder}
        autoComplete="off"
        className="min-h-11 min-w-0 flex-1 rounded-xl border border-border-soft bg-white px-4 text-base text-ink outline-none placeholder:text-muted focus-visible:border-brand-blue focus-visible:ring-2 focus-visible:ring-brand-blue/40 disabled:opacity-60"
      />

      <button
        type="submit"
        disabled={busy || draft.trim() === ""}
        className="inline-flex min-h-11 shrink-0 cursor-pointer items-center rounded-full bg-food-orange-strong px-5 text-sm font-bold text-white transition hover:bg-food-orange-dark disabled:cursor-not-allowed disabled:opacity-50"
      >
        {sendLabel}
      </button>
    </form>
  );
}

/**
 * Honest busy indicator. Renders only while work is actually in flight
 * (`stage === null` renders nothing); indeterminate spinner, never fake
 * percentages or staged progress. Callers pass a truthful stage line.
 */
export function BusyStage({ stage }: { readonly stage: string | null }): ReactNode {
  if (stage === null || stage === "") {
    return null;
  }

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border-soft bg-white px-4 py-3">
      <LoaderCircle
        aria-hidden="true"
        className="size-5 flex-none animate-spin text-food-orange-strong motion-reduce:animate-none"
      />

      <output aria-live="polite" className="text-sm font-semibold text-muted">
        {stage}
      </output>
    </div>
  );
}

/** Explicit failure with retry. No raw errors or stack traces surface. */
export function FlowAlert({
  message,
  onRetry,
  retryLabel,
}: {
  readonly message: string;
  readonly onRetry: () => void;
  readonly retryLabel: string;
}): ReactNode {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-2xl border border-danger/40 bg-white px-4 py-3"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-danger">
        <TriangleAlertIcon aria-hidden="true" className="size-4 flex-none" />

        {message}
      </p>

      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full border-2 border-ink bg-white px-5 text-sm font-bold text-ink transition hover:bg-ink hover:text-white"
      >
        {retryLabel}
      </button>
    </div>
  );
}

/**
 * Follow-up suggestion chips from the backend. Tapping one sends that exact
 * question; chips stay disabled while the flow is busy.
 */
export function FollowUpChips({
  busy,
  items,
  onPick,
}: {
  readonly busy: boolean;
  readonly items: ReadonlyArray<string>;
  readonly onPick: (text: string) => void;
}): ReactNode {
  if (items.length === 0) {
    return null;
  }

  return (
    <ul className="flex flex-wrap gap-2" aria-label="Suggested follow-ups">
      {items.map((item) => (
        <li key={item}>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onPick(item);
            }}
            className="inline-flex min-h-11 cursor-pointer items-center rounded-full border-2 border-border-soft bg-white px-4 text-sm font-semibold text-ink transition hover:border-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {item}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Structured backend cards. Dish and restaurant cards link to the canonical
 * catalog pages (IDs preserved into context on tap) and never invent
 * listings; price and source cards render outbound links only — the server
 * already restricts card URLs to verified http(s) citations.
 */
export function CopilotCards({
  cards,
  language,
  onUpdateContext,
  viewDishLabel,
  viewVenueLabel,
}: {
  readonly cards: ReadonlyArray<CopilotCard>;
  readonly language: "en" | "vi";
  readonly onUpdateContext: (patch: Partial<CopilotContext>) => void;
  readonly viewDishLabel: string;
  readonly viewVenueLabel: string;
}): ReactNode {
  if (cards.length === 0) {
    return null;
  }

  return (
    <ul className="flex flex-col gap-3">
      {cards.map((card, index) => (
        <li
          key={`${card.kind}-${card.refId ?? card.url ?? index}`}
          className="rounded-2xl border border-border-soft bg-white px-4 py-3 shadow-[0_12px_28px_rgba(194,65,12,0.08)]"
        >
          <h3 className="font-display text-xl leading-tight tracking-wide text-ink">
            {card.title}
          </h3>

          {card.summary === undefined || card.summary === "" ? null : (
            <p className="mt-1 text-sm leading-relaxed text-ink">{card.summary}</p>
          )}

          <div className="mt-2 flex flex-wrap gap-2">
            {card.kind === "dish" && card.refId !== undefined ? (
              <Link
                to="/dishes/$dishId"
                params={{ dishId: card.refId }}
                search={{ lang: language }}
                onClick={() => {
                  onUpdateContext({ dishId: card.refId });
                }}
                className="inline-flex min-h-11 items-center rounded-full border-2 border-ink bg-white px-4 text-sm font-bold text-ink transition hover:bg-ink hover:text-white"
              >
                {viewDishLabel}
              </Link>
            ) : null}

            {card.kind === "restaurant" && card.refId !== undefined ? (
              <Link
                to="/restaurants/$venueId"
                params={{ venueId: card.refId }}
                search={{ lang: language }}
                onClick={() => {
                  onUpdateContext({ venueId: card.refId });
                }}
                className="inline-flex min-h-11 items-center rounded-full border-2 border-ink bg-white px-4 text-sm font-bold text-ink transition hover:bg-ink hover:text-white"
              >
                {viewVenueLabel}
              </Link>
            ) : null}

            {(card.kind === "price" || card.kind === "source") && card.url !== undefined ? (
              <a
                href={card.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex min-h-11 items-center rounded-full border-2 border-ink bg-white px-4 text-sm font-bold text-ink transition hover:bg-ink hover:text-white"
              >
                {card.title}
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

const contextLineFor = (
  state: ResearchStatusState,
  contextLine: {
    readonly searching: string;
    readonly reviewing: string;
    readonly completed: string;
    readonly noEvidence: string;
    readonly failed: string;
  },
): string | undefined => {
  if (state === "searching") {
    return contextLine.searching;
  }

  if (state === "reviewing") {
    return contextLine.reviewing;
  }

  if (state === "completed") {
    return contextLine.completed;
  }

  if (state === "no-evidence") {
    return contextLine.noEvidence;
  }

  if (state === "failed") {
    return contextLine.failed;
  }

  return undefined;
};

/**
 * Opt-in web-research fallback with provenance. The caller supplies a
 * loader returning the peer research outcome; mapping and honesty states
 * live here: `preparing` covers synchronous setup only, `searching` is
 * entered once the fetch is in flight, `reviewing` covers mapping, and
 * terminal states reuse the reviewed research copy. Findings render
 * through the shared cited list; empty or unmappable results land on
 * no-evidence, never on invented content. Stale runs are ignored rather
 * than rendered.
 */
export function ResearchFallback({
  language,
  load,
  onContinue,
}: {
  readonly language: "en" | "vi";
  readonly load: () => Promise<ResearchOutcome>;
  readonly onContinue?: (() => void) | undefined;
}): ReactNode {
  const copy = researchCopyFor(language);
  const [state, setState] = useState<ResearchStatusState>("idle");
  const [findings, setFindings] = useState<ReadonlyArray<ResearchFinding>>([]);
  const runId = useRef(0);

  useEffect(
    () => () => {
      runId.current += 1;
    },
    [],
  );

  const start = (): void => {
    const id = runId.current + 1;
    runId.current = id;

    const alive = (): boolean => runId.current === id;

    setState("preparing");
    setState("searching");

    void load().then(
      (outcome) => {
        if (!alive()) {
          return;
        }

        setState("reviewing");

        const parsed = parseResearchOutcome(outcome);

        if (parsed === null || parsed.length === 0) {
          setFindings([]);
          setState("no-evidence");

          return;
        }

        setFindings(parsed);
        setState("completed");
      },
      () => {
        if (alive()) {
          setFindings([]);
          setState("failed");
        }
      },
    );
  };

  if (state === "idle") {
    return (
      <button
        type="button"
        onClick={start}
        className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-full border-2 border-ink bg-white px-5 text-sm font-bold text-ink transition hover:bg-ink hover:text-white"
      >
        {copy.researchAction}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <MuseResearchStatus
        state={state}
        contextLine={contextLineFor(state, {
          searching: copy.statusSearching,
          reviewing: copy.statusReviewing,
          completed: copy.statusCompleted,
          noEvidence: copy.statusNoEvidence,
          failed: copy.statusFailed,
        })}
        onRetry={state === "failed" ? start : undefined}
        retryLabel={copy.retryAction}
        onContinue={state === "no-evidence" || state === "failed" ? onContinue : undefined}
        continueLabel={copy.continueCatalogAction}
      />

      {state === "completed" ? (
        <ResearchFindingsList
          findings={findings}
          badgeLabel={copy.webResultBadge}
          notVerifiedNote={copy.notVerifiedNote}
        />
      ) : null}
    </div>
  );
}
