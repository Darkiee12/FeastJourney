import {
  JourneyEvent,
  JourneyState,
  transition,
  type JourneyTask,
} from "@/modules/muse-copilot/journey/types";

/** Fresh shell mount always lands on the task picker, never mid-flow. */
export const initialJourneyState: JourneyState = JourneyState.Home();

/** Enter a task from anywhere (deep link, landing card, retry). */
export const enterTask = (task: JourneyTask): JourneyState =>
  transition(JourneyState.Home(), JourneyEvent.SelectTask({ task }));

/** Leave any state for the landing picker. */
export const goHome = (state: JourneyState): JourneyState =>
  transition(state, JourneyEvent.GoHome());

/** Step back one level (flow slot → landing, waiter card → order review). */
export const goBack = (state: JourneyState): JourneyState =>
  transition(state, JourneyEvent.GoBack());

/** The task a flow-carrying state belongs to, or null outside a flow. */
export const taskOfState = (state: JourneyState): JourneyTask | null =>
  JourneyState.$match(state, {
    Home: () => null,
    Capture: ({ task }) => task,
    Uploading: ({ task }) => task,
    Analyzing: ({ task }) => task,
    Researching: ({ task }) => task,
    PresentingResults: ({ task }) => task,
    OrderReview: () => null,
    WaiterCard: () => null,
    RecoverableFailure: () => null,
  });

/** True only on the landing picker — the shell shows task cards then. */
export const isHomeState = (state: JourneyState): boolean =>
  JourneyState.$match(state, {
    Home: () => true,
    Capture: () => false,
    Uploading: () => false,
    Analyzing: () => false,
    Researching: () => false,
    PresentingResults: () => false,
    OrderReview: () => false,
    WaiterCard: () => false,
    RecoverableFailure: () => false,
  });
