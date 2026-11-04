import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  Camera,
  ChevronDown,
  ClipboardList,
  MapPin,
  ScanLine,
  UtensilsCrossed,
} from "lucide-react";
import type { ComponentType } from "react";
import { z } from "zod";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CopilotCopy } from "@/modules/muse-copilot/copilot-copy";
import type { CopilotContext, JourneyTask } from "@/modules/muse-copilot/journey/types";

const rootRoute = getRouteApi("__root__");

const uuidSchema = z.uuid();

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

/** Trigger glyph: exhaustive branches keep one stable component identity. */
function ActiveToolIcon({
  active,
  className,
}: {
  readonly active: JourneyTask | null;
  readonly className: string;
}) {
  if (active === "scan") {
    return <ScanLine aria-hidden="true" className={className} />;
  }

  if (active === "plate") {
    return <Camera aria-hidden="true" className={className} />;
  }

  if (active === "find") {
    return <MapPin aria-hidden="true" className={className} />;
  }

  if (active === "order") {
    return <ClipboardList aria-hidden="true" className={className} />;
  }

  return <UtensilsCrossed aria-hidden="true" className={className} />;
}

export interface TaskShortcutChipsProps {
  readonly active: JourneyTask | null;
  readonly copy: CopilotCopy;
  readonly onSelect: (task: JourneyTask) => void;
  /**
   * Optional live context for route handoffs (a validated venue scope for
   * the scanner). Absent on first integration pass — the launcher falls
   * back to the route locale and an unscoped scanner entry, exactly like
   * the scan panel does without a venue.
   */
  readonly context?: CopilotContext | undefined;
}

interface LauncherTool {
  readonly key: JourneyTask;
  readonly label: string;
  readonly hint: string;
  readonly icon: ComponentType<{ className?: string | undefined }>;
}

/**
 * Compact tool launcher replacing the permanent five-tab strip (overhaul
 * §§4,15-16: no persistent task tabs, no horizontal scroll strip). One
 * trigger reflecting the active tool; a Radix-anchored menu (existing
 * shared primitive, focus-managed, collision-aware, `modal={false}` so the
 * page keeps scrolling on mobile) listing real capabilities.
 *
 * Every entry performs a REAL action — never just `?task=`:
 * - Ask / Find / Identify / Order activate their workspace tool panels.
 * - Scan navigates directly to the canonical `/scan` route with the Muse
 *   return context (same search contract as the scan panel handoff).
 *
 * The typed action contract (`MuseAction`: AskQuestion/OpenRoute/OpenTool/
 * SetContext/BrowseDishes/FindRestaurants/ResumeScan/OpenOrder) is wired:
 * the workspace `handleAction` dispatches every outcome exhaustively, and
 * the scanner entry below carries the venue scope through `context`.
 * Dish-catalog browsing stays on the dedicated `/dishes` route and answer
 * cards — no invented copy here.
 */
export function TaskShortcutChips({ active, context, copy, onSelect }: TaskShortcutChipsProps) {
  const { lang } = rootRoute.useSearch();
  const navigate = useNavigate();

  const activeLabel = active === null ? copy.taskAskTitle : taskLabel(copy, active);

  const openScanner = (): void => {
    const parsedVenue = uuidSchema.safeParse(context?.venueId);
    const venue = parsedVenue.success ? parsedVenue.data : undefined;

    void navigate({
      to: "/scan",
      search:
        venue === undefined
          ? { lang, returnView: "copilot" as const }
          : { lang, venueId: venue, returnVenue: venue, returnView: "copilot" as const },
    });
  };

  const tools: ReadonlyArray<LauncherTool> = [
    { key: "ask", label: copy.taskAskTitle, hint: copy.taskAskBlurb, icon: UtensilsCrossed },
    { key: "find", label: copy.taskFindTitle, hint: copy.taskFindBlurb, icon: MapPin },
    { key: "plate", label: copy.suggestPlate, hint: copy.taskPlateBlurb, icon: Camera },
    { key: "scan", label: copy.taskScanTitle, hint: copy.taskScanBlurb, icon: ScanLine },
    { key: "order", label: copy.taskOrderTitle, hint: copy.taskOrderBlurb, icon: ClipboardList },
  ];

  return (
    <div className="flex flex-none items-center justify-start px-4 py-1.5 sm:justify-center sm:px-5">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${copy.workspaceTitle}: ${activeLabel}`}
            className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3.5 text-xs font-bold whitespace-nowrap text-white transition min-h-11 hover:border-white/40 hover:bg-white/10 aria-expanded:border-white/40 aria-expanded:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mango motion-reduce:transition-none"
          >
            <ActiveToolIcon active={active} className="size-4 flex-none text-mango" />
            <span className="max-w-36 truncate">{activeLabel}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 flex-none text-white/60" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          side="bottom"
          align="start"
          className="w-72 max-w-[calc(100vw-2rem)] border-white/10 bg-space-deep p-1.5 text-white"
          aria-label={copy.workspaceTitle}
        >
          <DropdownMenuLabel className="px-2.5 pt-1.5 pb-1 text-[11px] font-bold tracking-[0.12em] text-muted-on-dark uppercase">
            {copy.workspaceTitle}
          </DropdownMenuLabel>

          {tools.map((tool) => {
            const selected = active === tool.key;

            const tint =
              tool.key === "scan"
                ? "bg-food-orange-strong/20 text-food-orange"
                : "bg-white/10 text-mango";

            return (
              <DropdownMenuItem
                key={tool.key}
                onSelect={() => {
                  if (tool.key === "scan") {
                    openScanner();
                  } else {
                    onSelect(tool.key);
                  }
                }}
                aria-current={selected ? "true" : undefined}
                className="min-h-11 cursor-pointer gap-2.5 rounded-lg px-2.5 py-2 focus:bg-white/10 focus:text-white"
              >
                <span
                  className={`flex size-8 flex-none items-center justify-center rounded-full ${tint}`}
                >
                  <tool.icon aria-hidden="true" className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold break-words">{tool.label}</span>
                  <span className="block text-xs font-normal break-words text-muted-on-dark">
                    {tool.hint}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
