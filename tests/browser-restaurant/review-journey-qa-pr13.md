# Restaurant customer-review signed journey — browser QA (2026-11-02)

Branch `feat/restaurant-discovery-v2`, worktree `/home/darkie/projects/goodtaste/.local/pr13`.
App under test: reused running `infra-app-1` vite dev on http://localhost:3001
(bind-mounts this worktree; read-only check: 200 + worktree HTML).
Dev DB: `infra-postgres-1` (127.0.0.1:5433). No `src/`, `db/`, `infra/`, `tests/`
source file was edited. Servers left running as found; no dev server started.

## Fixtures (all removed afterwards; zero rows remain)

- Venue `22222222-2222-4222-8222-222222222222` "TESTQA Pho House", published,
  District 1, POINT(106.704 10.775); business `33333333-...`; menu `44444444-...`
  "TESTQA Main Menu" published; item `55555555-...` "TESTQA Pho Bo"; variant
  `66666666-...` "TESTQA Regular". Inserted via `docker exec infra-postgres-1
  psql` (location via `ST_SetSRID(ST_MakePoint(...),4326)::geography`;
  `restaurant_venue_names` trigger fills `normalized_name`).
- Users via repo helper `tests/integration/food-auth.ts` `signupSignin`
  (disposable `@example.com`, verified email, password `correct-horse-123`),
  driven from `/tmp/qa-review/mkusers.ts` (outside repo):
  member A `review-qa-member-a-mvzf3bttsykwem@example.com`
  (`m60aULcHGxLbAcfPQt34Hh69R9BJbuAO`), reviewer
  `review-qa-reviewer-mvzf3bttsykwem@example.com`
  (`51HkuoGPkuNbfj1nXY9ANgJFHEj3j24c`) + `curator` role (holds
  `restaurant:review`). Sign-in itself always through the real `/sign-in` UI.
- Cleanup (verified 0/0/0): reviews → variant → item → menu → venue_names →
  venue → business → users (sessions/accounts/roles cascade). One
  append-only `security_audit_events` row for the approved review id was left
  intact by design (audit trail, not fixture data).

## Step results

1. Sign in member A via UI: PASS.
2. Open venue (pin "Show TESTQA Pho House"), open Reviews: PASS.
3. Rating by click (label tap → 4) AND keyboard (ArrowRight 4→5, ArrowLeft):
   PASS. Note: the 1px radio inputs are not directly clickable in automation;
   real pointer users hit the label/star (verified via label click). Keyboard
   focus lands on the checked radio; arrows move selection and focus.
4. Enter text, submit, pending state: PASS. Dialog + own-section notice
   "received and is awaiting moderation"; DB row pending, `published_at` NULL.
5. Public count/average unchanged: PASS. Public list "No reviews match yet",
   overview summary absent at 0; DB total 0.
6. Reviewer approve via ADMIN Customer reviews queue: BLOCKED (not fixable in
   this run). Queue is a stub returning zero rows
   (`src/routes/admin.restaurants.tsx:197-219`,
   `restaurant-review-moderation.tsx:63-73`): UI shows the stub note plus
   "Showing 0–0 of 0 reviews (0 pending)" with a real pending review present.
   `decide` (the real `moderateRestaurantCustomerReviewFn` endpoint path) was
   exercised with the reviewer's actor via a `/tmp` script using the same
   server operation → `Applied`, status published (permission check + state
   machine + audit row verified). Editorial queue (`/admin/reviews`) correctly
   NOT used.
7. Public count/average update: PASS (post-approval). Overview "5.0 (1)" with
   `aria-label` "5.0 out of 5 from 1 reviews"; public card "Fellow traveler"
   with body; distribution 5-star 1/1; no author controls for non-author.
8. Author edit → back-to-pending: PASS. Keyboard ArrowLeft 5→4 in Edit dialog,
   Save → "Your changes were received and are awaiting moderation"; DB rating
   4, pending, `published_at` NULL; public list back to 0.
9. Delete → aggregates correct: PASS. "Your review was removed.", Write button
   returns; DB status `removed` with redacted body, rating retained (audit);
   public count stays 0.
10. Session-expiration submit: PASS. Cookies cleared with draft open → submit
    shows sign-in prompt ("Your place in this restaurant is kept"), not an
    error; no row written.
11. Draft preservation: PASS. "Sign in to continue" parks intent in
    sessionStorage; after re-login (lands on detail page, which has no reviews
    UI) the next map-drawer Reviews mount auto-reopens the dialog with rating
    3 + full text restored. Retry after recoverable failure: PASS (500 mocked
    via route interception → "Could not save your review. Please retry.",
    draft intact; after unroute the same draft submits → new pending).
12. Mobile 320/390: PASS. Reviews panel usable at both widths via sheet snaps;
    `scrollWidth == clientWidth` at 320 and 390 (no horizontal overflow).
13. Keyboard-only dialog walkthrough: PASS with one bug (F1 below). Tab order
    Close → checked radio → textarea → Cancel → Save → cycles (focus trap
    holds); Escape closes without saving (DB still 3).
14. Reduced-motion: PASS (observation). Emulated `reduce`; no auto-animation in
    the reviews surface; page carries `motion-reduce:scroll-auto`.
15. Focus on panel switch: PASS (overview→Reviews keeps panel context; Back to
    overview focuses the panel container). Map stays mounted across all panel
    switches (same `.maplibregl-map` node, marker flag survived).

## Bugs (suspects, no fixes)

- B1 (blocks end-to-end): Customer-reviews admin queue lists nothing by
  design — stub `loadQueue` (`admin.restaurants.tsx:197-219`) and stub
  contract (`restaurant-review-moderation.tsx:63-73`). No staff-scoped list op
  exists, so a reviewer can never discover a pending review in the UI; only
  `decide` (review-ID-in-hand) is wired. Needs the documented list op before
  step 6 can run in-browser.
- B2 (a11y): closing the review dialog (Escape AND Cancel) moves focus to the
  map drawer FAB ("Show results") instead of the opener (Write/Edit). The
  custom opener-restore effect (`restaurant-review-form.tsx:230-246`) appears
  to lose to Radix FocusScope restoration. Reproduced twice.
- O1 (UX, verify by owner): post-sign-in `returnTo` lands on the detail page
  `/restaurants/<venueId>`, which has no reviews UI; the parked write intent
  only restores on the next map-drawer Reviews mount. Works, but the author
  must re-find the venue. Suspect: `returnTo` construction
  (`restaurant-review-form.tsx:322`, `restaurant-reviews-panel.tsx:186`).
- O2 (harness, not app): one transient 429 ("Too many requests") on the own-
  review query during rapid QA navigation; recovered after ~45 s. Dev-only
  default rate limits (non-test env); no app change proposed.

## Not run + why

- Touch drag of mobile sheet / mouse-drag pan: headless limitation (button
  snaps verified instead).
- Screen reader pass: no SR available; ARIA notes only (radiogroup labelled,
  `aria-label` on radios/summary, `role=alert` errors, `aria-live` counts).
- Live-model paths: out of scope (no `MODEL_*` in this env).

## Evidence

`/tmp/opencode/review-shots/` 01-overview-signedin … 16-reduced-motion
(16 PNGs, listed in step order above). No app code changed; `git status`
worktree deltas (pre-existing P0 edits) untouched.

## Verdict

Journey does NOT pass end-to-end: steps 1–5, 7–15 PASS with evidence, but
step 6 (approve via the ADMIN Customer Reviews queue) is BLOCKED by B1 — the
queue cannot list pending reviews in this build, so no reviewer can complete
the loop through the UI.
