# Restaurant discovery UX v2 — browser QA re-run on seeded data (2026-11-02)

Branch `feat/restaurant-discovery-v2`, worktree `/home/darkie/projects/goodtaste/.local/pr13`.
App under test: existing `infra-app-1` vite dev (bind mount of this worktree) on
http://localhost:3001 against dev DB `infra-postgres-1` (127.0.0.1:5433).
READ-ONLY run: no `src/`, `db/`, `infra/`, or `tests/` source file was edited.
Seed (verified, not modified): venue `22222222-2222-4222-9222-222222222222`
"TESTQA Pho House", published, District 1, POINT(106.704 10.775); 3 published
menu items x 1 variant each (no prices); reviews 5-star + 4-star published
(avg 4.5, total 2) + one 2-star pending.

## Coordinator fix verification

- Scan route bounded strings: PASS. `/scan?venueId=not-a-uuid` prefills the
  branch field, "Check branch" reports "No published branch uses this ID.
  Leave empty to scan an unknown restaurant." No crash page, title intact.
- Venue select moves focus into panel container: PASS. After pin tap,
  `document.activeElement` is the `div[data-panel]` container (`tabindex=-1`)
  wrapping the overview (`restaurant-search-page.tsx:178,769`).

## Journey outcomes

- A (pin/list/overview/focus/reselect/sync): PASS with one bug (A1 below).
  Red pin `#E53935` at seeded coords; tap pin opens overview (name, address,
  District 1 area, 4.5 (2) with `aria-label` "4.5 out of 5 from 2 reviews",
  3 highlights with "Price unavailable — ask at the venue", fallback `.res-photo`
  initial "T", actions Menu/Reviews/Scan/Directions with correct Google Maps
  `destination=10.775,106.704`). Focus inside panel. Map click collapses the
  drawer (selection kept); re-tap same pin is idempotent (same content, map
  preserved). Fresh-load card "Show on map" tap gives identical overview.
- C (Menu/variants/waiter/back): PASS. 3 items, each "Price unknown — ask the
  waiter" + "Reviewed menu item; price unknown". Variant "Regular" select,
  Add one enables "Show waiter card"; waiter card shows venue, 1 x Pho Bo,
  unknown-price disclaimers, no-submission notice. Back to menu, back to
  overview: selection, pin pressed state, focus, all preserved.
- D (Reviews/write): PASS except submit (blocked, see D1). Summary "4.5",
  "Based on 2 published reviews", distribution 5x1/4x1/others 0. Cards show
  4-star + 5-star by "Fellow traveler"; 2-star pending absent. Signed-out
  "Write a review" shows sign-in prompt; "Sign in to continue" goes to
  `/sign-in?returnTo=%2Frestaurants%2F22222222-...` (venue preserved).
  Static check only: `restaurant-review-form.tsx:22-55` requires rating 1-5,
  body 1-2000 chars; `reviewFailureKind` keeps draft on non-auth errors.
- E (Scan association): PASS. `?venueId=<seed>` prefills branch field;
  "Check branch" shows "✓ TESTQA Pho House" (name, not raw UUID); language
  change keeps verification; "Analyze menu" stays disabled without photos.
  Invalid `?venueId=not-a-uuid` gives typed unknown-branch UI, no crash.
- G-selection: PASS. Overview open, drawer Collapse hides results, expand
  restores same venue/panel with pin pressed. Mobile 390px sheet Show full
  list / Show half / Show less all keep overview panel + venue. 320px overview
  shot: no horizontal overflow.
- Failure `/restaurants/00000000-...`: PASS. Typed "Discovery is
  unavailable / This restaurant is unavailable." + Try again + Return home;
  console shows expected `RestaurantNotFound` 404 through the route error
  boundary only.
- Regression: PASS. Dish autocomplete suggests Pho / Pho bo / Pho ga;
  `dish=2` shows noReviewed empty state + "Back to dish" returns to
  `/dishes/pho-bo`. Keyboard pan shows "Search this map area"; click sets
  west/south/east/north in URL, region becomes "Custom map area". Chooser
  dismiss via "Not now" works.
- Detail page `/restaurants/<seed-uuid>`: renders H1 venue, photos fallback
  note, menu; no customer-reviews section (reviews live only in the map
  drawer Reviews panel) — observation, not verdict.

## Bugs (suspects, not fixes)

- A1 (no back-to-list after select): `VenueOverview` receives no onBack/onClose
  (`restaurant-search-page.tsx:803-825`); list is `hidden` while preview open
  (`:738`). Pin re-tap calls `handleSelect` again (no toggle, `:523-529`);
  map background click only collapses the drawer, selection persists. Only
  "Back to results" is the detail-error state (`:789`). Suspects:
  `restaurant-search-page.tsx` (overview panel wiring), `venue-overview.tsx`
  (no back affordance), `restaurant-pins.tsx` (no toggle).
- D1 (submit path not run): sign-in offers Google OAuth + email/password only;
  no dev bypass or test account documented; creating an account would write to
  the dev DB, out of scope. Dialog/star keyboard and draft-on-error behavior
  not exercised at runtime for the same reason. Suspect file for follow-up:
  `restaurant-review-form.tsx` (Radix dialog focus handling `:120`).

## A11y notes

- Pin buttons labelled "Show TESTQA Pho House", `aria-pressed` mirrors
  selection (true while selected, including when drawer collapsed).
- Panel focus target is the generic `div[data-panel]` container, not the
  venue heading; `venue-preview.tsx:62-64` focuses a heading but that
  component is not the rendered path here.
- Chooser overlay intercepts map pointer events until dismissed (pin
  unclickable while open; same as prior run).
- Contrast/320px/reduced-motion: unchanged from prior PASS run; 320px
  overview verified no horizontal overflow this run.

## Screenshots (`/tmp/opencode/gt-ux2-shots/`, this run)

overview-with-highlights, menu-expanded, menu-waiter-card,
reviews-summary-cards, write-review-signedout (signed-out prompt; dialog
blocked per D1), scan-with-branch, scan-invalid-venueid, overview-320.

## Console

`agent-browser errors` empty across all journeys. Console has only vite
reconnect info, React DevTools hint, and the expected `RestaurantNotFound`
boundary log for the failure-route test.

## Not run + why

- Review submit (signed-in), write-review dialog keyboard/stars, 2000-char
  limit and draft-preserved-on-error at runtime: blocked per D1.
- Touch drag of mobile sheet: headless limitation (button-driven snaps
  verified instead).
- Mouse-drag pan: CDP-instant drag did not move the map; keyboard pan
  verified the same flow (harness limitation, not app verdict).
