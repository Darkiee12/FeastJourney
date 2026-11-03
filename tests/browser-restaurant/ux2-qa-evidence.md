# Restaurant discovery UX v2 — browser QA evidence (2026-11-02)

Branch `feat/restaurant-discovery-v2`, worktree `/home/darkie/projects/goodtaste/.local/pr13`.
App under test: existing `infra-app-1` vite dev (bind mount of this worktree) on
http://localhost:3001 against dev DB `infra-postgres-1` (127.0.0.1:5433).
READ-ONLY run: no `src/`, `db/`, or `infra/` file was edited.

## Data blocker (load-bearing)

- `feastjourney.restaurant_venues` count = **0**. `places` = 271, `dishes` = 1520.
- All pin/selection journeys (A, C, D, and B's venue leg) are BLOCKED: no real rows
  exist to select. No venues were invented. Empty-state legs were exercised instead.
- Flyway history is current through `V20261102_020` (restaurant customer reviews).

## Tile status

- `VITE_MAP_STYLE_URL` = Carto positron (keyless). Style JSON reachable (HTTP 200).
  Map renders with OSM/CARTO attribution; canvas present; 0 console errors.
- Tile-failure path verified by blocking `*.cartocdn.com` (503): map shows
  "The map could not load. The list and directions remain available."
  List keeps working. Routes removed afterwards; map verified healthy again.

## Journey outcomes

- A (pin select/overview/close/reselect): BLOCKED — zero venues.
- B (dish search → eligible venues → pin → menu item): PARTIAL — dish autocomplete
  works against real data (pho, pho bo, pho ga); dish mode (`dish=2`) shows the
  `noReviewed` empty state; "Back to dish" returns to `/dishes/pho-bo`. Venue legs blocked.
- C (Menu → dish → variant → waiter card → back): BLOCKED — no venue.
- D (Reviews list → write signed-in/out → pending): BLOCKED — no venue.
- E (Scan `?venueId=<uuid>` association + draft): PASS — branch ID prefilled,
  "Check branch" reports "No published branch uses this ID", gallery draft intact,
  "Analyze menu" stays disabled until photos are added.
- F (pan → Search this area → bounds → recenter): PASS — drag pans map,
  "Search this map area" appears, click sets `west/south/east/north` in URL,
  region label becomes "Custom map area". Note: drag only works once the location
  chooser overlay is dismissed (it intercepts pointer events).
- G (desktop drawer collapse/expand; mobile sheet snaps): PASS (no-selection leg) —
  Collapse hides results to `aria-hidden` + "Show results"; expand restores with
  bounds intact. Mobile Show less/half/full buttons all switch snaps.
  Selection-preservation leg BLOCKED (no venues). Touch-drag of the sheet was not
  exercised (headless limitation); button-driven snaps verified.
- H (deny geolocation + block tiles → list works): PASS — "Near me" with denied
  permission shows alert "Location unavailable or declined. Choose an area to keep
  browsing." plus chooser; list unaffected. Combined with tile blocking, list and
  empty states keep rendering.

## Viewports / input / motion / a11y

- 320/375/390/430/768 (mobile shell) + 1024/1440 (desktop drawer): no horizontal
  overflow; breakpoint at 64rem switches shell correctly.
- Vietnamese `lang=vi` renders (Tìm nhà hàng…); diacritic query "phở bò…" + long
  name falls back to name search, no overflow, no console errors.
- Keyboard: Tab order is Skip to content → nav → Skip map → map canvas → zoom →
  attribution → recenter → drawer/search/snap controls → results links. Focus ring
  is a solid 3px outline. Escape closes Filters dialog with focus restored to the
  Filters trigger. Observation: Escape with focus in the drawer area collapsed the
  whole results drawer (focus moved to "Show results") — verify that is intended.
- Reduced motion: `prefers-reduced-motion` queries exist in mapapp, venue-overview,
  restaurant-menu, restaurant-reviews CSS and `src/styles.css`; page renders sanely
  with `reduce` emulated.
- Contrast (empty state): heading 15.4:1, body 4.52:1 — AA pass.
- Console: 0 errors in all list/map/search/restaurants flows. Only expected noise:
  failed-venue 404 logs `RestaurantNotFound` through the route error boundary
  (typed failure, user-facing "Discovery is unavailable / This restaurant is
  unavailable" + Try again / Return home), and benign headless WebGL ReadPixels
  performance warnings.

## Screenshots (`/tmp/opencode/gt-ux2-shots/`)

mobile-map-initial, mobile-half-list, mobile-dish-empty, mobile-venue-failed,
mobile-vietnamese-empty, mobile-filters (post-Escape), desktop-map-drawer,
desktop-map-failed, desktop-reduced-motion, viewport-320, viewport-1024,
dish-pho-bo. Could not capture: selected overview, menu highlights, expanded menu,
review summary/cards, write-review dialog (all need a published venue).

## Suspect files (not fixes)

- Pan-gating on chooser overlay: `restaurant-search-page.tsx` (chooser float
  intercepts map pointer events until dismissed).
- Escape collapsing drawer: `results-drawer.tsx` / drawer Escape handling.
- Detail/review/menu panels untestable without seed data (no file implicated).
