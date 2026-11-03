import {
  ClipboardList,
  Leaf,
  MapPin,
  MessagesSquare,
  ScanLine,
  UtensilsCrossed,
} from "lucide-react";
import type { ComponentType } from "react";

import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import { journeyTasks, type JourneyTask } from "@/modules/muse-copilot/journey/types";

const taskIcons: ReadonlyMap<
  JourneyTask,
  ComponentType<{ className?: string | undefined }>
> = new Map<JourneyTask, ComponentType<{ className?: string | undefined }>>([
  ["scan", ScanLine],
  ["plate", Leaf],
  ["find", MapPin],
  ["ask", UtensilsCrossed],
  ["order", ClipboardList],
]);

const taskLabel = (copy: CopilotCopy, task: JourneyTask): string => {
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

export interface TaskShortcutChipsProps {
  readonly active: JourneyTask | null;
  readonly copy: CopilotCopy;
  readonly onSelect: (task: JourneyTask) => void;
}

/**
 * Compact horizontal task shortcuts for the workspace toolbar (plan §5:
 * optional contextual shortcut controls). One row, scrollable on narrow
 * screens, never a two-column card grid inside the chat.
 */
export function TaskShortcutChips({ active, copy, onSelect }: TaskShortcutChipsProps) {
  return (
    <div className="flex-none overflow-x-auto overscroll-x-contain">
      <ul
        className="flex gap-1.5 px-4 py-1 sm:justify-center sm:px-5"
        aria-label={copy.workspaceTitle}
      >
        {journeyTasks.map((task) => {
          const Icon = taskIcons.get(task) ?? MessagesSquare;
          const selected = active === task;

          return (
            <li key={task} className="flex-none">
              <button
                type="button"
                onClick={() => {
                  onSelect(task);
                }}
                aria-pressed={selected}
                className={`inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3.5 text-xs font-bold whitespace-nowrap transition ${
                  selected
                    ? "border-mango/70 bg-mango/15 text-mango"
                    : "border-white/15 bg-transparent text-white/75 hover:border-white/40 hover:text-white"
                }`}
              >
                <Icon aria-hidden="true" className="size-3.5" />
                {taskLabel(copy, task)}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
