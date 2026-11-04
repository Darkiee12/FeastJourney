import { useEffect, useReducer, useRef, useState } from "react";

import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import { MuseWorkspace } from "@/modules/muse-copilot/flows/muse-workspace";
import { enterTask, initialJourneyState } from "@/modules/muse-copilot/journey/journey-machine";
import {
  JourneyEvent,
  transition,
  type CopilotContext,
  type JourneyState,
  type JourneyTask,
} from "@/modules/muse-copilot/journey/types";

// eslint-disable-next-line import/no-unassigned-import -- route-scoped Muse layout; Vite bundles it, no value to bind
import "./muse.css";

export interface MuseShellProps {
  readonly copy: CopilotCopy;
  /** Controlled by the route (URL `task` param); null renders the entry hero. */
  readonly task: JourneyTask | null;
  readonly initialContext: CopilotContext;
  readonly signedIn: boolean;
  /** Identity- and language-scoped thread storage; remounts never leak across it. */
  readonly storageKey: string;
  /**
   * Route sync target: the shell owns live context, the route owns the URL.
   * Every task or context change reports the full fresh pair, so browser
   * back/forward restores discovered context instead of a stale object.
   */
  readonly onSync: (task: JourneyTask | null, context: CopilotContext) => void;
}

const sameContext = (left: CopilotContext, right: CopilotContext): boolean =>
  (left.city ?? undefined) === (right.city ?? undefined) &&
  (left.country ?? undefined) === (right.country ?? undefined) &&
  left.language === right.language &&
  (left.dishId ?? undefined) === (right.dishId ?? undefined) &&
  (left.venueId ?? undefined) === (right.venueId ?? undefined) &&
  (left.scanId ?? undefined) === (right.scanId ?? undefined);

/**
 * Muse copilot shell: owns the journey state machine, the shareable
 * context, and Start-Over generation. The single workspace renders every
 * mode — task shortcuts switch modes without forking the conversation.
 * Route changes (back/forward, deep links) adopt the URL context; shell
 * changes report back for URL sync. Never remounts the thread on
 * unrelated route updates.
 */
export function MuseShell({
  copy,
  initialContext,
  onSync,
  signedIn,
  storageKey,
  task,
}: MuseShellProps) {
  const [context, setContext] = useState<CopilotContext>(initialContext);
  const [resetCount, setResetCount] = useState(0);

  const [, dispatch] = useReducer(transition, initialJourneyState, (initial: JourneyState) =>
    task === null ? initial : enterTask(task),
  );

  const syncedTask = useRef<JourneyTask | null>(task);
  const routeContext = useRef<CopilotContext>(initialContext);

  // Adopt URL-driven changes (browser back/forward, deep links) and keep
  // the journey machine coherent: every route task maps to an explicit
  // transition, never a second machine.
  useEffect(() => {
    if (syncedTask.current !== task) {
      syncedTask.current = task;
      dispatch(task === null ? JourneyEvent.GoHome() : JourneyEvent.SelectTask({ task }));
    }

    if (!sameContext(routeContext.current, initialContext)) {
      routeContext.current = initialContext;
      setContext(initialContext);
    }
  }, [task, initialContext]);

  const select = (next: JourneyTask): void => {
    onSync(next, context);
  };

  const updateContext = (patch: Partial<CopilotContext>): void => {
    const next = { ...context, ...patch };

    setContext(next);
    onSync(task, next);
  };

  const startOver = (): void => {
    // Clears dish/venue/scan/task; city/country are location, not task
    // residue, and the language stays. The workspace remounts fresh and the
    // session-stored copy is dropped, so no thread survives the reset.
    const cleared: CopilotContext = {
      language: context.language,
      city: context.city,
      country: context.country,
    };

    try {
      window.sessionStorage.removeItem(`fj.muse-thread.v1.${storageKey}`);
    } catch {
      // Private mode: the remount starts empty regardless.
    }

    setContext(cleared);
    setResetCount((previous) => previous + 1);
    onSync(null, cleared);
  };

  return (
    <MuseWorkspace
      key={`${storageKey}:${resetCount}`}
      copy={copy}
      task={task ?? "ask"}
      context={context}
      signedIn={signedIn}
      storageKey={storageKey}
      onUpdateContext={updateContext}
      onSelectTask={select}
      onStartOver={startOver}
    />
  );
}
