# Restaurant discovery v2 — browser QA follow-up (2026-11-02, 2nd run)

Branch `feat/restaurant-discovery-v2`, worktree `/home/darkie/projects/goodtaste/.local/pr13`.
App under test: existing `infra-app-1` vite dev (bind mount of this worktree) on
http://127.0.0.1:3001 against dev DB `infra-postgres-1` (127.0.0.1:5433).
READ-ONLY run: no `src/`, `db/`, `infra/`, or existing `tests/` file was edited.
Runner: headless Chromium (`~/.cache/ms-playwright/chromium-1247`), 1440×900 + 320×740.

## Seed verified (not reseeded)

- `feastjourney.restaurant_venues`: 1 row — `22222222-2222-2222-2222-222222222222`
  ("TESTQA Pho House", "TESTQA 1 Nguyen Hue, District 1", District 1, published,
  lon 106.704 / lat 10.775).
- 3 published `restaurant_menu_items` (+ 3 `restaurant_menu_item_variants`) on the venue menu.
- `restaurant_customer_reviews`: 5★ published, 4★ published, 2★ pending.

## Load-bearing blocker: seed UUID fails the app's strict UUID check

`22222222-2222-2222-2222-222222222222` is NOT a valid RFC UUID: the 4th group
starts with `2`, but zod v4 `z.uuid()` requires variant bits `[89abAB]`.
Every venue-detail path rejects it before any DB read:

- Pin tap / card tap → detail fetch rejected → drawer shows typed
  "Restaurant unavailable / This restaurant could not load. It may have been removed."
  (+ Try again / Back to results). No HTTP failure, no crash, deterministic on re-tap.
- Direct `/restaurants/22222222-…?channel=dine_in` → route `errorComponent`
  "Discovery is unavailable / Discovery could not load. Please retry."
  (server-fn validator threw; HTTP 500 on the document request).
- `/scan?venueId=22222222-…` → HARD CRASH page "Something went wrong!" with raw
  zod `invalid_format`/`Invalid UUID` JSON (uncaught search-param validation).
  Control with a valid-format unknown UUID
  (`aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa`) renders the scan page fine, so the
  crash is the invalid-UUID rejection escaping to the crash boundary.

Coordinator action needed: reseed with a real v4/v7 UUID (correct variant bits)
and re-run A, C, D, E, G-selection. Nothing in app code was changed for this.

## Journey outcomes

- A (pin select → overview → close → re-tap; card↔marker sync): FAIL — blocked.
  Pin renders with `aria-label="Show TESTQA Pho House"`, `aria-pressed` toggles
  false→true on select. List card links to `/restaurants/22222222-…` (correct id).
  Both pin and card legs end in the typed-unavailable states above, so overview
  content, menu highlights, fallback photo, map preservation, and card↔marker
  sync are all unverifiable. Back-to-results restores the list; re-tap is
  deterministic (same error, no stale content); Try again re-runs and fails
  identically without crashing.
- C (Menu → variant → waiter card → back): BLOCKED — detail route 500s for seed.
- D (Reviews summary/distribution/pagination/sign-in/publish): BLOCKED — same.
  Pending-review invisibility unverifiable through the UI.
- E (Scan association + draft): PARTIAL. Standalone `/scan?lang=en` renders
  (hero, privacy/Meta notice, photo picker). Valid-UUID `?venueId=` keeps the
  page alive with branch-ID field + "Check branch". Seed-UUID `?venueId=`
  crashes (see above). Verified branch name/address display is unverifiable.
- G-selection (drawer collapse/expand with selection; mobile sheet with panel):
  BLOCKED selection leg. No-selection leg PASS: Hide results → drawer
  `aria-hidden` + "Show results"; expand restores list with card intact and
  bounds preserved. Mobile sheet button snaps verified in prior run; touch-drag
  still not exercised (headless limitation).
- Failure states: `/restaurants/00000000-0000-0000-0000-000000000000` → PASS,
  typed "Discovery is unavailable / This restaurant is unavailable." + Try again /
  Return home (nil UUID passes the validator by design). `/scan` without venueId
  → PASS, works standalone.

## Viewports / tiles / console

- Map healthy: Carto positron style + OSM/CARTO attribution, canvas present,
  venue pin painted. 0 pageerrors on all flows; only expected noise is the HTTP
  500 on the seed-UUID document request and the 404 on the nil-UUID redirect.
- 320px list renders, no horizontal overflow (screenshot).

## Screenshots (`/tmp/opencode/gt-ux2-shots/`, this run)

selected-pin-overview.png (pin-selected error panel), failed-venue-nil-uuid.png,
scan-standalone.png, scan-unknown-venue.png, drawer-collapsed.png,
overview-320.png. Not capturable (blocked): menu highlights row, expanded menu,
review summary + cards, write-review dialog, scan-with-verified-branch.

## a11y notes

- Pin is a real `<button>` with a named `aria-label` and working `aria-pressed` —
  good. After pin tap, `document.activeElement` is the "Restaurants" H2, not the
  overview/error panel: focus is not moved into the new panel content on
  selection. Keyboard/dialog/star-input checks are blocked (no reachable dialog).
- Drawer collapse/expand keeps controls as named buttons ("Hide results" /
  "Show results") — good.

## Suspect files (not fixes)

- `src/modules/restaurant-discovery/restaurant.schema.ts:76` (`venueIdSchema`
  with strict `z.uuid()`), consumed by `restaurant.functions.ts:33`
  (`getRestaurantFn` validator) — rejects the non-RFC seed UUID; pin-overview
  path fails the same way.
- `src/routes/scan.tsx:8` (`venueId: z.uuid().optional()` search validation) —
  invalid input escapes to the crash boundary instead of a typed fallback.
- `src/routes/restaurants.$venueId.tsx:22-23` (loader passes raw param into the
  strict-validated server fn) and `discovery-error.tsx:13` (typed UI that masks
  a validation rejection as "could not load").
- `src/modules/restaurant-discovery/components/restaurant-copy.ts:101-102`
  (detailFailed copy shown for a venue that exists but fails validation —
  "may have been removed" is misleading here).
