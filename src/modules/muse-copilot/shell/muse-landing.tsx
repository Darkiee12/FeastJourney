import { Sparkles } from "lucide-react";

import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import type { JourneyTask } from "@/modules/muse-copilot/journey/types";
import { TaskSelector } from "@/modules/muse-copilot/shell/task-selector";

export interface MuseLandingProps {
  readonly copy: CopilotCopy;
  readonly availability: ReadonlyMap<JourneyTask, boolean>;
  readonly onSelect: (task: JourneyTask) => void;
}

/**
 * Muse landing: a calm header plus the five task cards. Purely
 * presentational — the shell owns navigation, context, and flow loading.
 */
export function MuseLanding({ availability, copy, onSelect }: MuseLandingProps) {
  return (
    <div>
      <header className="muse-hero">
        <p className="muse-hero-tag">
          <Sparkles aria-hidden="true" className="size-3.5 flex-none" />
          {copy.shellTitle}
        </p>
        <h1 className="font-display text-[clamp(2.25rem,6vw,3.5rem)] leading-tight tracking-wide text-balance text-white">
          {copy.landingTitle}
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-[clamp(1rem,2.5vw,1.15rem)] font-semibold text-balance text-white/85">
          {copy.landingSubtitle}
        </p>
      </header>
      <div className="mx-auto w-full max-w-3xl px-5 py-8 text-left">
        <TaskSelector availability={availability} copy={copy} onSelect={onSelect} />
      </div>
    </div>
  );
}
