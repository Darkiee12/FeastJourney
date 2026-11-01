import { createContext, useCallback, useContext, useMemo, useReducer, type ReactNode } from "react";

import {
  INITIAL_MOBILE_HOME_STATE,
  mobileHomeReducer,
  type MobileHomeState,
} from "@/components/home/mobile/mobile-home-state";

export interface MobileHomeActions {
  readonly state: MobileHomeState;
  readonly openDiscovery: () => void;
  readonly openQuiz: () => void;
  readonly showResults: () => void;
  readonly openLocationPicker: () => void;
  readonly back: () => void;
  readonly closeSheet: () => void;
  readonly setNestedDialogOpen: (open: boolean) => void;
}

const MobileHomeContext = createContext<MobileHomeActions | null>(null);

export function MobileHomeProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(mobileHomeReducer, INITIAL_MOBILE_HOME_STATE);
  const openDiscovery = useCallback(() => dispatch({ type: "open-discovery" }), []);
  const openQuiz = useCallback(() => dispatch({ type: "open-quiz" }), []);
  const showResults = useCallback(() => dispatch({ type: "show-results" }), []);
  const openLocationPicker = useCallback(() => dispatch({ type: "open-location" }), []);
  const back = useCallback(() => dispatch({ type: "back" }), []);
  const closeSheet = useCallback(() => dispatch({ type: "close" }), []);

  const setNestedDialogOpen = useCallback(
    (open: boolean) => dispatch({ type: "set-nested-dialog", open }),
    [],
  );

  const value = useMemo<MobileHomeActions>(
    () => ({
      state,
      openDiscovery,
      openQuiz,
      showResults,
      openLocationPicker,
      back,
      closeSheet,
      setNestedDialogOpen,
    }),
    [
      state,
      openDiscovery,
      openQuiz,
      showResults,
      openLocationPicker,
      back,
      closeSheet,
      setNestedDialogOpen,
    ],
  );

  return <MobileHomeContext.Provider value={value}>{children}</MobileHomeContext.Provider>;
}

export function useMobileHome(): MobileHomeActions {
  const value = useContext(MobileHomeContext);

  if (value === null) throw new Error("useMobileHome requires MobileHomeProvider");

  return value;
}

export function useMobileHomeOptional(): MobileHomeActions | null {
  return useContext(MobileHomeContext);
}
