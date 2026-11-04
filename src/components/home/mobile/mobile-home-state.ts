export type MobileSheetMode = "collapsed" | "discovery" | "quiz" | "results" | "location";

export type MobileSheetReturnMode = Exclude<MobileSheetMode, "location">;

export interface MobileHomeState {
  readonly mode: MobileSheetMode;
  readonly returnTo: MobileSheetReturnMode;
  readonly nestedDialogOpen: boolean;
}

export const INITIAL_MOBILE_HOME_STATE: MobileHomeState = {
  mode: "collapsed",
  returnTo: "discovery",
  nestedDialogOpen: false,
};

export type MobileHomeAction =
  | { readonly type: "open-discovery" }
  | { readonly type: "open-quiz" }
  | { readonly type: "show-results" }
  | { readonly type: "open-location" }
  | { readonly type: "back" }
  | { readonly type: "close" }
  | { readonly type: "set-nested-dialog"; readonly open: boolean };

export function mobileHomeReducer(
  state: MobileHomeState,
  action: MobileHomeAction,
): MobileHomeState {
  switch (action.type) {
    case "open-discovery":
      return { ...state, mode: "discovery", returnTo: "discovery" };
    case "open-quiz":
      return { ...state, mode: "quiz", returnTo: "quiz" };
    case "show-results":
      return { ...state, mode: "results", returnTo: "results" };
    case "open-location":
      return {
        ...state,
        mode: "location",
        returnTo: state.mode === "location" ? state.returnTo : state.mode,
      };
    case "back":
      return state.mode === "location"
        ? { ...state, mode: state.returnTo }
        : { ...state, mode: "collapsed" };
    case "close":
      return { ...state, mode: "collapsed", nestedDialogOpen: false };
    case "set-nested-dialog":
      return state.nestedDialogOpen === action.open
        ? state
        : { ...state, nestedDialogOpen: action.open };
  }

  return state;
}

export const MOBILE_SHEET_PEEK_PX = 76;
const MIN_STAGE_TOP_PX = 56;
const MIN_GLOBE_ARC_PX = 96;

/** Open sheets are for reading: they keep only a sliver of the stage above. */
const OPEN_SHEET_RATIO = 0.88;

export function mobileSheetHeightPx(mode: MobileSheetMode, viewportHeight: number): number {
  const height = Math.max(1, viewportHeight);
  const capped = Math.max(MOBILE_SHEET_PEEK_PX, height - MIN_STAGE_TOP_PX);

  switch (mode) {
    case "collapsed":
      return Math.min(MOBILE_SHEET_PEEK_PX, height);
    case "quiz":
      return Math.min(capped, Math.max(300, height * OPEN_SHEET_RATIO));
    case "results":
      return Math.min(capped, Math.max(280, height * OPEN_SHEET_RATIO));
    case "discovery":
      return Math.min(capped, Math.max(300, height * OPEN_SHEET_RATIO));
    case "location":
      return Math.min(capped, Math.max(320, height * OPEN_SHEET_RATIO));
  }

  return MOBILE_SHEET_PEEK_PX;
}

export interface MobileGlobeGeometryInput {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly sheetHeightPx: number;
  readonly safeAreaBottomPx?: number;
}

export interface MobileGlobeGeometry {
  readonly globeDiameterPx: number;
  readonly globeLiftPx: number;
  readonly sheetTopPx: number;
  readonly visibleGlobeHeightPx: number;
}

/** Pure stage geometry: one coordinate system for sheet top and globe lift. */
export function computeMobileGlobeGeometry(input: MobileGlobeGeometryInput): MobileGlobeGeometry {
  const width = Math.max(1, input.viewportWidth);
  const height = Math.max(1, input.viewportHeight);
  const sheetHeightPx = Math.min(height, Math.max(0, input.sheetHeightPx));
  const sheetTopPx = height - sheetHeightPx;
  const globeDiameterPx = Math.max(1, Math.min(height / 0.8, width - 32));
  const requestedLift = Math.max(0, sheetHeightPx - MOBILE_SHEET_PEEK_PX) * 1.0;
  const maxLift = Math.max(0, sheetTopPx - MIN_GLOBE_ARC_PX);
  const globeLiftPx = Math.min(requestedLift, maxLift);

  return {
    globeDiameterPx,
    globeLiftPx,
    sheetTopPx,
    visibleGlobeHeightPx: sheetTopPx,
  };
}
