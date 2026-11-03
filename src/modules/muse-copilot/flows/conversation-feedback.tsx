import { Link } from "@tanstack/react-router";
import { Match } from "effect";
import {
  ArrowUpRight,
  Camera,
  ClipboardList,
  LoaderCircle,
  MapPin,
  ScanLine,
  Sparkles,
  TriangleAlertIcon,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  MuseResearchStatus,
  type ResearchStatusState,
} from "@/components/research/muse-research-status";
import { researchCopyFor } from "@/components/research/research-copy";
import {
  ResearchFindingsList,
  type ResearchFinding,
} from "@/components/research/research-findings";
import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import {
  MuseAction,
  MuseFailure,
  type MuseContextChip,
  type SuggestedAction,
} from "@/modules/muse-copilot/journey/types";
import type { ResearchOutcome } from "@/server/web-research/research-types";
import type { Locale } from "@/shared/i18n";

/**
 * Honest busy indicator: a reserved in-transcript pending assistant slot
 * (avatar + dimensionally-stable skeleton + stage label) rendered only
 * while real work is in flight. Indeterminate spinner, never fake
 * percentages or staged progress; `min-h` keeps the thread from jumping
 * when the slot mounts. Reduced-motion safe.
 */
export function ProcessingIndicator({ stage }: { readonly stage: string | null }): ReactNode {
  if (stage === null || stage === "") {
    return null;
  }

  return (
    <div className="flex items-start gap-2" aria-busy="true">
      <span
        aria-hidden="true"
        className="flex size-7 flex-none items-center justify-center rounded-full bg-space-deep text-mango"
      >
        <Sparkles className="size-3.5" />
      </span>

      <div className="flex min-h-[92px] min-w-0 flex-1 flex-col justify-center gap-2 rounded-2xl rounded-bl-md border border-border-soft bg-white px-4 py-3 shadow-[0_1px_2px_rgba(3,10,30,0.08)]">
        <div aria-hidden="true" className="flex items-center gap-2.5">
          <LoaderCircle className="size-4 flex-none animate-spin text-food-orange-strong motion-reduce:animate-none" />

          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-2.5 w-3/4 animate-pulse rounded-full bg-space-deep/10 motion-reduce:animate-none" />
            <span className="h-2.5 w-1/2 animate-pulse rounded-full bg-space-deep/10 motion-reduce:animate-none" />
          </div>
        </div>

        <output aria-live="polite" className="text-sm font-semibold text-ink">
          {stage}
        </output>
      </div>
    </div>
  );
}

const failureCopyFor = (copy: CopilotCopy, failure: MuseFailure): string =>
  MuseFailure.$match(failure, {
    Transport: () => copy.errorTransport,
    RateLimited: () => copy.errorRateLimited,
    Unavailable: () => copy.errorUnavailable,
    InvalidOutput: () => copy.errorInvalid,
    AuthRequired: () => copy.errorAuth,
    Disabled: () => copy.errorDisabled,
  });

/**
 * Explicit failure with real retry: the button resends the failed request
 * (never just clears a flag), and the failed user message stays visible in
 * the thread so the visitor is never asked to type it again. Authentication
 * failures offer sign-in (with the return destination) instead of a retry
 * that would fail again.
 */
export function RecoverableError({
  copy,
  failure,
  onRetry,
  retryAfterSeconds,
  signIn,
}: {
  readonly copy: CopilotCopy;
  readonly failure: MuseFailure;
  readonly onRetry: () => void;
  readonly retryAfterSeconds: number | null;
  readonly signIn: { readonly lang: Locale; readonly returnTo: string } | null;
}): ReactNode {
  const retryLabel =
    retryAfterSeconds === null ? copy.retryAction : `${copy.retryAction} · ${retryAfterSeconds}s`;

  const retryButton = (
    <button
      type="button"
      onClick={onRetry}
      className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full bg-food-orange-strong px-5 text-sm font-bold text-white transition hover:bg-food-orange-dark"
    >
      {retryLabel}
    </button>
  );

  const signInButton =
    signIn === null ? null : (
      <Link
        to="/sign-in"
        search={{ lang: signIn.lang, returnTo: signIn.returnTo }}
        className="inline-flex min-h-11 items-center justify-center rounded-full bg-food-orange-strong px-5 text-sm font-bold text-white transition hover:bg-food-orange-dark"
      >
        {copy.signInAction}
      </Link>
    );

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-2xl border border-danger/50 bg-danger/10 px-4 py-3"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-ink">
        <TriangleAlertIcon
          aria-hidden="true"
          className="size-4 flex-none text-food-orange-strong"
        />

        {failureCopyFor(copy, failure)}
      </p>

      {MuseFailure.$match(failure, {
        AuthRequired: () => signInButton ?? retryButton,
        Transport: () => retryButton,
        RateLimited: () => retryButton,
        Unavailable: () => retryButton,
        InvalidOutput: () => retryButton,
        // Disabled is not retryable: retrying would fail again. The copy
        // above names a supported alternative instead.
        Disabled: () => null,
      })}
    </div>
  );
}

/**
 * Follow-up suggestion chips from the assistant turn. At most two compact
 * chips (plan §12: no giant static grids once chatting); tapping one sends
 * that exact question. Chips stay disabled while a request is in flight.
 * Every chip sends text verbatim — there is no label sniffing here.
 * Action routing (ask/open-route/open-tool/browse) belongs to Lane 1's
 * frozen action union plus the workspace sender, not to these strings.
 */
export function FollowUpChips({
  busy,
  copy,
  items,
  onPick,
}: {
  readonly busy: boolean;
  readonly copy: CopilotCopy;
  readonly items: ReadonlyArray<string>;
  readonly onPick: (text: string) => void;
}): ReactNode {
  const visible = items.slice(0, 2);

  if (visible.length === 0) {
    return null;
  }

  return (
    <ul className="flex flex-wrap gap-2" aria-label={copy.followUpsLabel}>
      {visible.map((item) => (
        <li key={item} className="min-w-0">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onPick(item);
            }}
            className="inline-flex max-w-full min-h-11 cursor-pointer items-center gap-1.5 rounded-full border border-border-soft bg-white px-4 text-sm font-semibold text-ink shadow-[0_1px_2px_rgba(3,10,30,0.08)] transition hover:border-food-orange-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ArrowUpRight aria-hidden="true" className="size-4 flex-none text-food-orange-strong" />

            <span className="truncate">{item}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Typed action chips from the assistant turn. At most three compact chips;
 * each dispatches its `MuseAction` by tag — labels stay display-only.
 * Chips stay disabled while a request is in flight.
 */
export function ActionChips({
  busy,
  items,
  onPick,
}: {
  readonly busy: boolean;
  readonly items: ReadonlyArray<SuggestedAction>;
  readonly onPick: (action: MuseAction) => void;
}): ReactNode {
  const visible = items.slice(0, 3);

  if (visible.length === 0) {
    return null;
  }

  return (
    <ul className="flex flex-wrap gap-2">
      {visible.map((item, index) => {
        const Icon = iconForMuseAction(item.action);

        return (
          <li key={`${item.label}-${index.toString()}`} className="min-w-0">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onPick(item.action);
              }}
              aria-label={item.label}
              className="inline-flex max-w-full min-h-11 cursor-pointer items-center gap-1.5 rounded-full border border-food-orange-strong/40 bg-food-orange-strong/10 px-4 text-sm font-semibold text-ink transition hover:border-food-orange-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon aria-hidden="true" className="size-4 flex-none text-food-orange-strong" />

              <span className="truncate">{item.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const iconForMuseAction = (action: MuseAction): LucideIcon =>
  MuseAction.$match(action, {
    AskQuestion: () => ArrowUpRight,
    BrowseDishes: () => UtensilsCrossed,
    FindRestaurants: () => MapPin,
    OpenOrder: () => ClipboardList,
    ResumeScan: () => ScanLine,
    OpenTool: ({ tool }) => {
      if (tool === "camera" || tool === "gallery") {
        return Camera;
      }

      if (tool === "location") {
        return MapPin;
      }

      if (tool === "scanner") {
        return ScanLine;
      }

      return ClipboardList;
    },
    OpenRoute: () => ArrowUpRight,
    SetContext: () => ArrowUpRight,
  });

/**
 * Removable scope chips (plan §17): dish, venue, city, scan. Removal clears
 * the corresponding context id and its URL param through the caller.
 */
export function ContextChipRow({
  chips,
  copy,
  onRemove,
}: {
  readonly chips: ReadonlyArray<MuseContextChip>;
  readonly copy: CopilotCopy;
  readonly onRemove: (chip: MuseContextChip) => void;
}): ReactNode {
  if (chips.length === 0) {
    return null;
  }

  return (
    <ul className="flex flex-wrap gap-2" aria-label={copy.workspaceTitle}>
      {chips.map((chip) => (
        <li key={`${chip.kind}-${chip.label}`}>
          <span className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border-soft bg-white py-1 pr-1.5 pl-3.5 text-xs font-bold text-ink shadow-[0_4px_12px_rgba(3,10,30,0.08)]">
            {chip.label}

            <button
              type="button"
              onClick={() => {
                onRemove(chip);
              }}
              aria-label={`${copy.removeChip}: ${chip.label}`}
              className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-muted transition hover:bg-cream hover:text-ink"
            >
              <span aria-hidden="true">×</span>
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Boundary mapper for peer research outcomes. `ResearchFound` findings pass
 * through; every other tag yields null so callers fall back to the honest
 * no-evidence state instead of inventing results.
 */
export const parseResearchOutcome = (
  outcome: ResearchOutcome,
): ReadonlyArray<ResearchFinding> | null =>
  Match.value(outcome).pipe(
    Match.tag("ResearchFound", ({ findings }) => [...findings]),
    Match.orElse(() => null),
  );

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
 * Opt-in web-research fallback with provenance. Findings render through the
 * shared cited list; empty results land on no-evidence, never invented
 * content. Stale runs are ignored rather than rendered.
 */
export function ResearchFallback({
  language,
  load,
  onContinue,
}: {
  readonly language: Locale;
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
        className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-full border border-border-soft bg-white px-5 text-sm font-bold text-ink shadow-[0_4px_12px_rgba(3,10,30,0.08)] transition hover:border-food-orange-strong"
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
