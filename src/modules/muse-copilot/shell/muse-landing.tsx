import { ClipboardList, Leaf, MapPin, ScanLine, UtensilsCrossed } from "lucide-react";
import type { ComponentType } from "react";

import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import type { JourneyTask } from "@/modules/muse-copilot/journey/types";

export interface WorkspaceHeroProps {
  readonly copy: CopilotCopy;
  readonly city: string | undefined;
  readonly onSelectTask: (task: JourneyTask) => void;
  readonly onSend: (text: string, task: JourneyTask) => void;
}

interface Suggestion {
  readonly label: string;
  readonly task: JourneyTask;
  readonly send: boolean;
  readonly icon: ComponentType<{ className?: string | undefined }>;
}

const fillCity = (template: string, city: string): string => template.replace("{city}", city);

/**
 * Conversation-first entry (plan §4, mockup landing): one greeting, one
 * line of subcopy, then the five task cards in a compact two-column grid
 * (comfortable at 320px, no narrow chat columns). Typing works
 * immediately via the persistent composer below — no task click required.
 * Food questions send in place; scan/plate/order select their workflow.
 */
export function WorkspaceHero({ city, copy, onSelectTask, onSend }: WorkspaceHeroProps) {
  const findLabel = city === undefined ? copy.suggestFind : fillCity(copy.suggestCity, city);

  const suggestions: ReadonlyArray<Suggestion> = [
    { label: findLabel, task: "find", send: true, icon: MapPin },
    { label: copy.suggestDish, task: "ask", send: true, icon: UtensilsCrossed },
    { label: copy.suggestScan, task: "scan", send: false, icon: ScanLine },
    { label: copy.suggestPlate, task: "plate", send: false, icon: Leaf },
    { label: copy.suggestOrder, task: "order", send: false, icon: ClipboardList },
  ];

  return (
    <div className="flex flex-col gap-4 py-6">
      <div className="flex flex-col gap-1 text-center">
        <p className="font-display text-[clamp(1.75rem,6vw,2.5rem)] leading-tight tracking-wide text-balance text-ink">
          {copy.heroGreeting}
        </p>

        <p className="mx-auto max-w-md text-sm leading-relaxed text-balance text-muted">
          {copy.workspaceTagline}
        </p>
      </div>

      <ul className="mx-auto grid w-full max-w-md grid-cols-2 gap-2">
        {suggestions.map((suggestion, index) => {
          const Icon = suggestion.icon;

          return (
            <li key={suggestion.label} className={index === 0 ? "col-span-2" : undefined}>
              <button
                type="button"
                onClick={() => {
                  if (suggestion.send) {
                    onSelectTask(suggestion.task);
                    onSend(suggestion.label, suggestion.task);
                  } else {
                    onSelectTask(suggestion.task);
                  }
                }}
                className="flex h-full w-full cursor-pointer flex-col items-start gap-2 rounded-2xl border border-border-soft bg-white px-4 py-3 text-left shadow-[0_8px_20px_rgba(3,10,30,0.08)] transition hover:-translate-y-px hover:border-food-orange-strong/50 active:translate-y-0"
              >
                <span className="flex size-9 items-center justify-center rounded-full bg-space-deep text-mango">
                  <Icon aria-hidden="true" className="size-4" />
                </span>

                <span className="text-sm font-bold leading-snug text-ink">{suggestion.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Back-compat alias: the shell's entry render is the workspace hero. */
export const MuseLanding = WorkspaceHero;

export type MuseLandingProps = WorkspaceHeroProps;
