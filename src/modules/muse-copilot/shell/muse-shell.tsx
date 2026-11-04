import { ArrowLeft, LoaderCircle, RotateCcw, TriangleAlert } from "lucide-react";
import { Component, useEffect, useReducer, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";

import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import {
  enterTask,
  initialJourneyState,
  isHomeState,
} from "@/modules/muse-copilot/journey/journey-machine";
import {
  JourneyEvent,
  JourneyState,
  journeyTasks,
  transition,
  type CopilotContext,
  type FlowProps,
  type JourneyTask,
} from "@/modules/muse-copilot/journey/types";
import { MuseLanding } from "@/modules/muse-copilot/shell/muse-landing";

/**
 * Flow slot contract (peers implement against this):
 *
 * - One module per task at `../flows/<task>-flow` relative to this file:
 *   scan-flow, plate-flow, find-flow, ask-flow, order-flow.
 * - Each module exports either a named `<Pascal>Flow` component (ScanFlow,
 *   PlateFlow, FindFlow, AskFlow, OrderFlow) or a default component.
 * - Every flow component accepts `FlowProps`: the shareable `context` plus
 *   `onUpdateContext` for patching it. Context stays in the shell, so back
 *   navigation and refresh-adjacent moves never lose it.
 * - A missing module, a missing export, or a non-component export never
 *   crashes the shell: the task card renders disabled with coming-soon copy.
 */

/**
 * Structural contract for a flow module. Keep the named exports in sync with
 * what peers publish from `../flows/<task>-flow`.
 */
interface FlowModuleExports {
  readonly ScanFlow?: ComponentType<FlowProps> | undefined;
  readonly PlateFlow?: ComponentType<FlowProps> | undefined;
  readonly FindFlow?: ComponentType<FlowProps> | undefined;
  readonly AskFlow?: ComponentType<FlowProps> | undefined;
  readonly OrderFlow?: ComponentType<FlowProps> | undefined;
  readonly default?: ComponentType<FlowProps> | undefined;
}

const namedFlow = (
  task: JourneyTask,
  flowModule: FlowModuleExports,
): ComponentType<FlowProps> | undefined => {
  if (task === "scan") {
    return flowModule.ScanFlow;
  }

  if (task === "plate") {
    return flowModule.PlateFlow;
  }

  if (task === "find") {
    return flowModule.FindFlow;
  }

  if (task === "ask") {
    return flowModule.AskFlow;
  }

  return flowModule.OrderFlow;
};

/**
 * Every flow module matching the slot contract, keyed by relative path.
 * Typed through the `FlowModuleExports` parameter, so loaders resolve to the
 * contract shape with no runtime narrowing or assertions. Peers add
 * `../flows/<task>-flow.tsx`; a task with no key simply has no module yet.
 */
const flowModules = import.meta.glob<FlowModuleExports>("../flows/*-flow.{ts,tsx}");

/**
 * Best-effort flow load. A task with no matching module (peers have not
 * landed it yet) maps to null, and the shell renders its card disabled with
 * coming-soon copy instead of crashing.
 */
const loadFlowComponent = async (task: JourneyTask): Promise<ComponentType<FlowProps> | null> => {
  const prefix = `../flows/${task}-flow.`;
  const entry = Object.entries(flowModules).find(([path]) => path.startsWith(prefix));

  if (entry === undefined) {
    return null;
  }

  const flowModule = await entry[1]();
  const candidate = namedFlow(task, flowModule) ?? flowModule.default;

  return candidate ?? null;
};

type FlowLoads = ReadonlyMap<JourneyTask, ComponentType<FlowProps> | null>;

const availabilityOf = (loads: FlowLoads): ReadonlyMap<JourneyTask, boolean> =>
  new Map(
    journeyTasks.map((task) => {
      // Optimistic until the probe resolves: a present flow never flashes
      // disabled, while a genuinely missing one flips to coming-soon
      // within a tick of mount.
      const loaded = loads.get(task);

      return [task, loaded !== null] as const;
    }),
  );

class FlowErrorBoundary extends Component<
  { children: ReactNode; onFail: (reason: string) => void },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    this.props.onFail(error.message);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return null;
    }

    return this.props.children;
  }
}

function LoadedFlow({
  component: Flow,
  context,
  onUpdateContext,
}: {
  readonly component: ComponentType<FlowProps>;
  readonly context: CopilotContext;
  readonly onUpdateContext: (patch: Partial<CopilotContext>) => void;
}) {
  return <Flow context={context} onUpdateContext={onUpdateContext} />;
}

export interface MuseShellProps {
  readonly copy: CopilotCopy;
  /** Controlled by the route (URL `task` param); null renders the landing. */
  readonly task: JourneyTask | null;
  readonly initialContext: CopilotContext;
  readonly onTaskChange: (task: JourneyTask | null) => void;
}

/**
 * Muse copilot shell: owns the journey state machine, the shareable context,
 * the visited-task stack for back navigation, and lazy flow loading. The
 * route owns the URL; the shell mirrors it, so browser back/forward and the
 * shell back button both return to the prior task with context intact.
 */
export function MuseShell({ copy, initialContext, onTaskChange, task }: MuseShellProps) {
  const [context, setContext] = useState<CopilotContext>(initialContext);
  const [loads, setLoads] = useState<FlowLoads>(new Map());
  const [entered, setEntered] = useState(false);

  const [state, dispatch] = useReducer(transition, initialJourneyState, (initial): JourneyState =>
    task === null ? initial : enterTask(task),
  );

  const stackRef = useRef<Array<JourneyTask>>(task === null ? [] : [task]);
  const syncedRef = useRef<JourneyTask | null>(task);

  // Entrance: 200–350ms opacity/transform, skipped under reduced motion.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));

    return () => cancelAnimationFrame(frame);
  }, []);

  // Probe every flow module once; failures stay null (coming-soon cards).
  useEffect(() => {
    let cancelled = false;

    void Promise.all(
      journeyTasks.map((probe) =>
        loadFlowComponent(probe).then((component) => {
          if (!cancelled) {
            setLoads((previous) => new Map(previous).set(probe, component));
          }
        }),
      ),
    );

    return () => {
      cancelled = true;
    };
  }, []);

  // Adopt URL-driven task changes (browser back/forward, deep links) and keep
  // the back stack coherent: truncate to a revisited task, push a new one.
  useEffect(() => {
    if (syncedRef.current === task) {
      return;
    }

    syncedRef.current = task;

    if (task === null) {
      stackRef.current = [];
      dispatch(JourneyEvent.GoHome());
    } else {
      const stack = stackRef.current;
      const index = stack.lastIndexOf(task);

      stackRef.current = index === -1 ? [...stack, task] : stack.slice(0, index + 1);
      dispatch(JourneyEvent.SelectTask({ task }));
    }
  }, [task]);

  const select = (next: JourneyTask): void => {
    stackRef.current = [...stackRef.current, next];
    syncedRef.current = next;
    dispatch(JourneyEvent.SelectTask({ task: next }));
    onTaskChange(next);
  };

  const back = (): void => {
    const stack = stackRef.current;
    const previous = stack[stack.length - 2] ?? null;

    stackRef.current = stack.slice(0, -1);
    syncedRef.current = previous;
    dispatch(
      previous === null ? JourneyEvent.GoHome() : JourneyEvent.SelectTask({ task: previous }),
    );
    onTaskChange(previous);
  };

  const startOver = (): void => {
    stackRef.current = [];
    syncedRef.current = null;
    setContext({ language: context.language });
    dispatch(JourneyEvent.GoHome());
    onTaskChange(null);
  };

  const retry = (): void => {
    if (task === null) {
      dispatch(JourneyEvent.GoHome());
      onTaskChange(null);

      return;
    }

    setLoads((previous) => {
      const next = new Map(previous);

      next.delete(task);

      return next;
    });
    void loadFlowComponent(task).then((component) => {
      setLoads((previous) => new Map(previous).set(task, component));
    });
    dispatch(JourneyEvent.SelectTask({ task }));
  };

  const onUpdateContext = (patch: Partial<CopilotContext>): void => {
    setContext((previous) => ({ ...previous, ...patch }));
  };

  const showLanding = task === null || isHomeState(state);
  const loaded = task === null ? undefined : loads.get(task);

  const failureReason: string | null = JourneyState.$match(state, {
    RecoverableFailure: ({ reason }) => reason,
    Home: () => null,
    Capture: () => null,
    Uploading: () => null,
    Analyzing: () => null,
    Researching: () => null,
    PresentingResults: () => null,
    OrderReview: () => null,
    WaiterCard: () => null,
  });

  return (
    <section
      aria-label={copy.shellTitle}
      className="muse-shell overflow-hidden rounded-3xl bg-space-deep shadow-[0_24px_64px_rgba(3,10,30,0.45)]"
    >
      <div
        key={task ?? "home"}
        className={`transition-opacity transition-transform duration-300 ease-out motion-reduce:transition-none motion-reduce:opacity-100 motion-reduce:translate-y-0 ${
          entered ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"
        }`}
      >
        {showLanding ? (
          <MuseLanding availability={availabilityOf(loads)} copy={copy} onSelect={select} />
        ) : (
          <div className="mx-auto w-full max-w-3xl px-5 py-6">
            <div className="mb-5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={back}
                className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-full border border-white/25 bg-white/5 px-4 text-sm font-bold text-white transition hover:border-white/50 hover:bg-white/10 active:scale-[0.97]"
              >
                <ArrowLeft aria-hidden="true" className="size-4 flex-none" />
                {copy.back}
              </button>
              <button
                type="button"
                onClick={startOver}
                className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-full border border-transparent bg-transparent px-4 text-sm font-bold text-white/70 transition hover:bg-white/10 hover:text-white active:scale-[0.97]"
              >
                <RotateCcw aria-hidden="true" className="size-4 flex-none" />
                {copy.startOver}
              </button>
            </div>

            {loaded === undefined ? (
              <output
                aria-live="polite"
                className="flex min-h-48 w-full flex-col items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-5 py-8 text-center"
              >
                <LoaderCircle
                  aria-hidden="true"
                  className="size-6 animate-spin text-mango motion-reduce:animate-none"
                />
                <span className="text-sm font-semibold text-white/80">{copy.loadingFlow}</span>
              </output>
            ) : null}

            {loaded === null ? (
              <div className="w-full rounded-2xl border border-white/10 bg-white/5 px-5 py-8 text-center">
                <p className="text-base font-bold text-white">{copy.comingSoon}</p>
                <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-white/70">
                  {copy.landingSubtitle}
                </p>
                <button
                  type="button"
                  onClick={retry}
                  className="mt-4 inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-full bg-food-orange-strong px-5 text-sm font-bold text-white transition hover:bg-food-orange-dark active:scale-[0.97]"
                >
                  <RotateCcw aria-hidden="true" className="size-4 flex-none" />
                  {copy.retryAction}
                </button>
              </div>
            ) : null}

            {loaded !== undefined && loaded !== null ? (
              <FlowErrorBoundary
                key={task}
                onFail={(reason) => dispatch(JourneyEvent.Fail({ reason }))}
              >
                <LoadedFlow
                  component={loaded}
                  context={context}
                  onUpdateContext={onUpdateContext}
                />
              </FlowErrorBoundary>
            ) : null}

            {failureReason === null ? null : (
              <div
                role="alert"
                className="mt-4 w-full rounded-2xl border border-danger/40 bg-danger/10 px-5 py-6 text-center"
              >
                <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-danger/15 text-danger">
                  <TriangleAlert aria-hidden="true" className="size-5" />
                </span>
                <p className="mt-3 text-base font-bold text-white">{copy.failureTitle}</p>
                <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-white/75">
                  {copy.failureBody}
                </p>
                <button
                  type="button"
                  onClick={retry}
                  className="mt-4 inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-full bg-food-orange-strong px-5 text-sm font-bold text-white transition hover:bg-food-orange-dark active:scale-[0.97]"
                >
                  <RotateCcw aria-hidden="true" className="size-4 flex-none" />
                  {copy.retryAction}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
