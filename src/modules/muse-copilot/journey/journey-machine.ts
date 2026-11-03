import {
  JourneyEvent,
  JourneyState,
  MuseAction,
  transition,
  type CopilotContext,
  type JourneyTask,
} from "@/modules/muse-copilot/journey/types";

/** Fresh shell mount always lands on the task picker, never mid-flow. */
export const initialJourneyState: JourneyState = JourneyState.Home();

/** Enter a task from anywhere (deep link, landing card, retry). */
export const enterTask = (task: JourneyTask): JourneyState =>
  transition(JourneyState.Home(), JourneyEvent.SelectTask({ task }));

/**
 * Pure typed context transition for frozen `MuseAction`s (plan §17). This is
 * not a second state machine — the `JourneyState` machine above stays the
 * single state system; this maps action outcomes onto shareable scope. Only
 * actions carrying scope touch the context, and only with defined values:
 * omitted keys keep the current scope so dish/city survive task switches.
 * Explicit clearing stays with the removable scope chips. The workspace
 * reports the result through `onUpdateContext`, which syncs the shareable
 * ids back to the URL; scan ownership is always re-verified server-side.
 */
export const applyActionToContext = (context: CopilotContext, action: MuseAction): CopilotContext =>
  MuseAction.$match(action, {
    AskQuestion: () => context,
    OpenRoute: () => context,
    OpenTool: () => context,
    BrowseDishes: () => context,
    SetContext: ({ city, country, dishId, scanId, venueId }) => ({
      ...context,
      city: city ?? context.city,
      country: country ?? context.country,
      dishId: dishId ?? context.dishId,
      venueId: venueId ?? context.venueId,
      scanId: scanId ?? context.scanId,
    }),
    FindRestaurants: ({ dishId }) => (dishId === undefined ? context : { ...context, dishId }),
    ResumeScan: ({ scanId }) => ({ ...context, scanId }),
    OpenOrder: ({ scanId, venueId }) => ({
      ...context,
      venueId: venueId ?? context.venueId,
      scanId: scanId ?? context.scanId,
    }),
  });
