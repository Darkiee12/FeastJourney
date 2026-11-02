# Hackathon UX2 evidence (append-only — one section per agent run)

## 2026-11-02 — demo QA + artifacts pass (hackathon agent)

Worktree `/home/darkie/projects/goodtaste/.local/pr13`, branch
`feat/restaurant-discovery-v2` (upstream in sync, 0 ahead/behind; no
pull needed). App: existing `infra-app-1` vite dev on
http://localhost:3001 (bind mount of this worktree, dirty P0 files
included). Dev DB `infra-postgres-1`: 2 published venues
(`Hardening branch …`, another agent's rows — browsed read-only, no
writes), 0 reviewed menus, 0 reviews. READ-ONLY run: no `src/`,
`db/`, `infra/`, or existing `tests/` file edited; no seed rows
created, so nothing to clean up. No live Muse calls (not authorized).

### Per-scene verdicts

- Quiz → results/reasons: PASS (live). 3 steps → results; mode
  label reads “Selected from our food catalog without AI ranking”
  (deterministic, no key configured — correct). Shot
  `quiz-results-deterministic.png`. AI-ranked variant BLOCKED (needs
  live key; code path reviewed, not executed).
- Map pin → overview: PASS (live). Pins render with named
  `aria-label`s; selection sets `aria-pressed`, moves focus into
  `div[data-panel]`; overview shows name/address/fallback initial +
  Menu/Reviews/Scan/Directions. Playwright `click` on the pin misses
  (map overlay); JS click works — harness note, not app verdict.
  Note: overview HAS “Back to results” in this build (prior A1 may
  be fixed by in-flight work — confirm at submission cut).
- Menu tab / waiter card: PARTIAL (live empty only). Honest empty
  “No curated menu offerings…” + “Back to overview” verified live.
  Non-empty menu + waiter card BLOCKED on seed (no reviewed menus);
  recorded pair from prior TESTQA run remains in
  `/tmp/opencode/gt-ux2-shots/` (`menu-expanded.png`,
  `menu-waiter-card.png`).
- Reviews tab: PARTIAL (live empty only). Honest empties + “Sign in
  to continue” → `/sign-in?returnTo=%2Frestaurants%2F<venueId>%3Flang%3Den`
  (venue-preserving return nav verified live). Submit/keyboard/draft
  BLOCKED (no test account). Non-empty recorded in
  `reviews-summary-cards.png`, `write-review-signedout.png`.
- Scan standalone + branch check: PASS (live). Hero, privacy
  notice, 7 languages, branch verify returns “✓ <name>” for the
  real published UUID (`scan-branch-verified.png`). Invalid-UUID
  typed handling re-verified via prior run. Analysis/correction
  BLOCKED (needs live Muse + photos).
- Dish → venue CTA: PASS (live). `/dishes/pho-bo` → “Find
  restaurants serving this” → `/restaurants?dish=2…` honest empty
  (refuses to imply unverified supply) → “Back to dish” returns.
- Failure route: PASS (live). Nil UUID → typed “This restaurant is
  unavailable” + Try again / Return home; no crash page.
- Mobile 390px: PASS with one bug. Restaurants + overview/reviews
  fit, no overflow, 0 console errors. Scan page overflows 447>390:
  hidden `#scan-camera`/`#scan-gallery` file inputs at x=57 full
  width (DOM-measured; suspect photo picker in `menu-scan-page.tsx`,
  P0-owned — reported, not fixed). Shot `mobile-scan-overflow.png`.
- Model chip: BLOCKED (code-level). `scanModelChip` exists but
  `scanViewSchema`/`scan-owned.sql` expose no `model` field → always
  null. P0 in-flight (`menu-scans.ts` writes `model` on revision).
- Failure banners (`menuScanPageCopy` retry/validation/conflict/
  auth strings): copy verified in code; runtime BLOCKED (needs a
  failed scan).

### Console

Dish-image 404s (`/api/v1/dish-images/205|290|6|59`) on home —
missing dev media, fallbacks render. Benign WebGL ReadPixels
headless warnings. Zero page errors on all verified flows.

### Bugs (suspects, no fixes)

- B1 mobile scan overflow: hidden file inputs `#scan-camera`,
  `#scan-gallery` (x=57, w=390) overflow 390px viewport.
  Suspect: photo-picker markup/CSS (`menu-scan-page.tsx`,
  `menu-scan-page.css` — P0-owned).
- B2 (observation): Playwright `click` on MapLibre pin buttons does
  not select; native `.click()` does. Harness note only.

### Remaining gaps for submission

1. TEST-prefixed seed (valid RFC UUID!) + cleanup for live
   menu/reviews/scan beats — coordinator-owned.
2. Live Muse verification (ranking + extraction) — explicitly
   unauthorized here; `ai-evaluation.md` records `not_run`.
3. Signed-in review submit flow — needs test account decision.
4. Re-confirm A1/back-nav + model chip after P0 lands.
5. New shots: `/tmp/opencode/hackathon-shots/` (14 files, this
   run); prior `gt-ux2-shots/` covers removed-seed states —
   label recorded vs live in the final cut.
