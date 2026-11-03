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
    <div className="mx-auto w-full max-w-3xl px-5 pt-[clamp(1.5rem,5vh,3rem)] pb-10 text-center">
      <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-mango/50 bg-space-deep/80 px-4 py-1.5 text-xs font-bold tracking-[0.18em] text-mango uppercase">
        <Sparkles aria-hidden="true" className="size-3.5 flex-none" />
        {copy.shellTitle}
      </p>
      <h1 className="font-display text-[clamp(2rem,6vw,3rem)] leading-tight tracking-wide text-balance text-white">
        {copy.landingTitle}
      </h1>
      <p className="mx-auto mt-3 max-w-xl text-[clamp(1rem,2.5vw,1.15rem)] font-semibold text-balance text-white/85">
        {copy.landingSubtitle}
      </p>
      <div className="mt-8 text-left">
        <TaskSelector availability={availability} copy={copy} onSelect={onSelect} />
      </div>
    </div>
  );
}
