# Mobile user journeys — mobile homepage shell, sheet and globe (Implemented)

Canonical page for the mobile (`max-md`) homepage architecture. Desktop keeps
the document-flow hero, recommendation section and discovery section.

## Architecture

```text
Home (route split, ClientOnly + useIsMaxMd — only one tree mounts)
├── DesktopHome: HomeHero → RecommendSection → DiscoverySection
└── MobileHome
    └── MobileHomeProvider (useReducer sheet state machine)
        ├── MobileViewport stage (100dvh-based, single coordinate system)
        │   ├── Hero content (CTAs call context actions)
        │   └── PersistentGlobe (single GlobeCanvas mount, transform wrapper)
        └── MobileSheet (collapsed | discovery | quiz | results | location)
            ├── DiscoverySection (sheet variant; state preserved while hidden)
            ├── RecommendSection (embedded quiz/results; state preserved)
            └── MobileLocationPicker (rendered by DiscoverySection in location mode)
```

- Shared presentation state lives in
  `src/components/home/mobile/mobile-home-context.tsx`: active sheet mode,
  location return mode, nested-dialog flag, and actions `openDiscovery`,
  `openQuiz`, `showResults`, `openLocationPicker`, `back`, `closeSheet`.
  Domain state stays with its owners (quiz draft/results in quiz-flow,
  discovery scope/carousel in discovery-section).
- No `QUIZ_DRAWER_*` window events remain. Hero CTAs, sheet, quiz and globe
  read the same provider. The only remaining homepage CustomEvent is the
  globe-internal dish spotlight (`SURPRISE_DISH_EVENT`).
- Scroll ownership is centralized: MobileHome locks document scroll while
  mounted (single cleanup), the sheet pane owns `overflow-y-auto`, and no
  component calls `window.scrollTo` for sheet transitions.

## Sheet modes and sizing

Pure sizing in `mobile-home-state.ts` (`mobileSheetHeightPx`): collapsed is a
76px peek affordance (tap or swipe up, keyboard-operable button); quiz ≈52dvh
stable across steps with docked footer and internal scroll; results ≈46dvh
content-focused; discovery ≈66dvh browsing surface; location ≈72dvh. All
modes cap at viewport minus a 56px stage top so short viewports stay usable.

## Globe geometry

`computeMobileGlobeGeometry` (pure, unit-tested) derives sheet top, globe
diameter and lift from the measured stage size and current sheet height.
The globe wrapper translates upward as the sheet expands on the shared
450ms drawer-spring timing (`motion-safe` only; reduced motion snaps).
The WebGL canvas, pins and static fallback never remount across mode
changes; no per-frame React state is used (ResizeObserver on the stage
only).

## Location picker

Mobile location selection is a full-width sheet view, never a nested
submenu: root choices (Near me — explicit tap only, Country, City,
Worldwide), searchable country list (localized name or ISO code via shared
`filterCountryOptions`, also used by the desktop dropdown search), and
full-width city search over `searchCitiesFn` committing canonical place
IDs with name/context/country disambiguation. Selecting returns to the
prior sheet mode via `back()` without resetting quiz or discovery state.
Desktop retains its dropdown, now with a searchable country submenu.
Served/requested scope honesty (`requestedScope`/`servedScope` labels) is
unchanged.

## Verification

- Unit: `tests/mobile-home-state.test.ts` (reducer transitions, sheet
  sizing, globe geometry, country filtering) plus existing discovery and
  quiz suites.
- Browser journeys and viewport screenshots: see PR report.
