import { Link, getRouteApi } from "@tanstack/react-router";
import {
  Camera,
  ChevronRight,
  ClipboardList,
  MapPin,
  ScanLine,
  Sparkles,
  UtensilsCrossed,
} from "lucide-react";
import type { ComponentType } from "react";

import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import type { JourneyTask } from "@/modules/muse-copilot/journey/types";

const rootRoute = getRouteApi("__root__");

export interface WorkspaceHeroProps {
  readonly copy: CopilotCopy;
  readonly city: string | undefined;
  readonly onSelectTask: (task: JourneyTask) => void;
  readonly onSend: (text: string, task: JourneyTask) => void;
}

interface Suggestion {
  readonly label: string;
  readonly hint: string;
  readonly task: JourneyTask;
  readonly send: boolean;
  readonly icon: ComponentType<{ className?: string | undefined }>;
}

const fillCity = (template: string, city: string): string => template.replace("{city}", city);

/**
 * Conversation-first entry (overhaul §16): one greeting, one line of
 * subcopy, then a vertical list of full-width tool rows — comfortable at
 * 320px, never a two-column grid of narrow cards. Typing works immediately
 * via the persistent composer below; no task click required.
 *
 * Galaxy identity lives in the navy greeting band (white text on navy);
 * tool rows are white cards with dark text. Scan navigates directly to the
 * canonical `/scan` route with the Muse return context; food questions
 * send in place; plate/order select their workflow.
 */
export function WorkspaceHero({ city, copy, onSelectTask, onSend }: WorkspaceHeroProps) {
  const { lang } = rootRoute.useSearch();
  const findLabel = city === undefined ? copy.suggestFind : fillCity(copy.suggestCity, city);

  const suggestions: ReadonlyArray<Suggestion> = [
    { label: findLabel, hint: copy.taskFindBlurb, task: "find", send: true, icon: MapPin },
    {
      label: copy.suggestDish,
      hint: copy.taskAskBlurb,
      task: "ask",
      send: true,
      icon: UtensilsCrossed,
    },
    {
      label: copy.suggestScan,
      hint: copy.taskScanBlurb,
      task: "scan",
      send: false,
      icon: ScanLine,
    },
    {
      label: copy.suggestPlate,
      hint: copy.taskPlateBlurb,
      task: "plate",
      send: false,
      icon: Camera,
    },
    {
      label: copy.suggestOrder,
      hint: copy.taskOrderBlurb,
      task: "order",
      send: false,
      icon: ClipboardList,
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 py-4">
      <div className="flex flex-col gap-1.5 rounded-2xl bg-gradient-to-b from-space-deep to-ocean-deep px-5 py-5 text-center">
        <p className="flex items-center justify-center gap-1.5 text-[11px] font-bold tracking-[0.16em] text-mango uppercase">
          <Sparkles aria-hidden="true" className="size-3.5 flex-none" />
          {copy.workspaceTitle}
        </p>
        <h1 className="font-display text-[clamp(1.75rem,6vw,2.5rem)] leading-tight tracking-wide text-balance text-white">
          {copy.heroGreeting}
        </h1>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-balance text-muted-on-dark">
          {copy.workspaceTagline}
        </p>
      </div>

      <ul className="flex w-full flex-col gap-2">
        {suggestions.map((suggestion) => {
          const row = (
            <>
              <span className="flex size-9 flex-none items-center justify-center rounded-full bg-space-deep text-mango">
                <suggestion.icon aria-hidden="true" className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold break-words text-ink">
                  {suggestion.label}
                </span>
                <span className="block text-xs font-normal break-words text-muted">
                  {suggestion.hint}
                </span>
              </span>
              <ChevronRight aria-hidden="true" className="size-4 flex-none text-muted" />
            </>
          );

          if (suggestion.task === "scan") {
            return (
              <li key={suggestion.label}>
                <Link
                  to="/scan"
                  search={{ lang, returnView: "copilot" }}
                  className="flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-2xl border border-border-soft bg-white px-3.5 py-2 text-left shadow-sm transition hover:border-food-orange-strong/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-food-orange-strong motion-reduce:transition-none"
                >
                  {row}
                </Link>
              </li>
            );
          }

          return (
            <li key={suggestion.label}>
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
                className="flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-2xl border border-border-soft bg-white px-3.5 py-2 text-left shadow-sm transition hover:border-food-orange-strong/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-food-orange-strong active:bg-cream motion-reduce:transition-none"
              >
                {row}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
