import { MapPinned, MessagesSquare, ReceiptText, ScanLine, UtensilsCrossed } from "lucide-react";
import type { ComponentType } from "react";

import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import type { JourneyTask } from "@/modules/muse-copilot/journey/types";
import { journeyTasks } from "@/modules/muse-copilot/journey/types";

const taskIcons: ReadonlyMap<
  JourneyTask,
  ComponentType<{ className?: string | undefined }>
> = new Map<JourneyTask, ComponentType<{ className?: string | undefined }>>([
  ["scan", ScanLine],
  ["plate", UtensilsCrossed],
  ["find", MapPinned],
  ["ask", MessagesSquare],
  ["order", ReceiptText],
]);

const taskTitle = (copy: CopilotCopy, task: JourneyTask): string => {
  if (task === "scan") {
    return copy.taskScanTitle;
  }

  if (task === "plate") {
    return copy.taskPlateTitle;
  }

  if (task === "find") {
    return copy.taskFindTitle;
  }

  if (task === "ask") {
    return copy.taskAskTitle;
  }

  return copy.taskOrderTitle;
};

const taskBlurb = (copy: CopilotCopy, task: JourneyTask): string => {
  if (task === "scan") {
    return copy.taskScanBlurb;
  }

  if (task === "plate") {
    return copy.taskPlateBlurb;
  }

  if (task === "find") {
    return copy.taskFindBlurb;
  }

  if (task === "ask") {
    return copy.taskAskBlurb;
  }

  return copy.taskOrderBlurb;
};

export interface TaskSelectorProps {
  readonly copy: CopilotCopy;
  /** True once that task's flow module loaded; false renders it disabled. */
  readonly availability: ReadonlyMap<JourneyTask, boolean>;
  readonly onSelect: (task: JourneyTask) => void;
}

/**
 * The five task cards. A task whose flow module failed to load renders
 * disabled with coming-soon copy — never a crash, never a dead button that
 * pretends to work.
 */
export function TaskSelector({ availability, copy, onSelect }: TaskSelectorProps) {
  return (
    <ul className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
      {journeyTasks.map((task) => {
        const Icon = taskIcons.get(task) ?? MessagesSquare;
        const ready = availability.get(task) ?? false;

        if (!ready) {
          return (
            <li key={task}>
              <div
                aria-disabled="true"
                className="flex h-full items-start gap-3 rounded-2xl border border-border-soft bg-white/60 px-5 py-4 text-left opacity-70"
              >
                <span className="flex size-11 flex-none items-center justify-center rounded-full bg-space-deep/10 text-muted">
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-bold text-ink">{taskTitle(copy, task)}</span>
                    <span className="inline-flex items-center rounded-full bg-space-deep/10 px-2.5 py-0.5 text-xs font-bold tracking-wide text-muted uppercase">
                      {copy.comingSoon}
                    </span>
                  </span>
                  <span className="mt-1 block text-sm leading-relaxed text-muted">
                    {taskBlurb(copy, task)}
                  </span>
                </span>
              </div>
            </li>
          );
        }

        return (
          <li key={task}>
            <button
              type="button"
              onClick={() => onSelect(task)}
              className="flex h-full w-full cursor-pointer items-start gap-3 rounded-2xl border border-border-soft bg-white px-5 py-4 text-left shadow-[0_12px_28px_rgba(194,65,12,0.08)] transition hover:-translate-y-px hover:border-food-orange-strong/50 hover:shadow-[0_16px_32px_rgba(194,65,12,0.16)] active:translate-y-0 active:scale-[0.99]"
            >
              <span className="flex size-11 flex-none items-center justify-center rounded-full bg-space-deep text-cream">
                <Icon className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-base font-bold text-ink">{taskTitle(copy, task)}</span>
                <span className="mt-1 block text-sm leading-relaxed text-muted">
                  {taskBlurb(copy, task)}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
