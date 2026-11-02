# FeastJourney — demo script (hackathon, 90–150 s)

Traveler: first evening in Ho Chi Minh City, hungry, no Vietnamese.
Each beat is marked **[LIVE]** (verified 2026-11-02 on `infra-app-1`
`:3001`, evidence below) or **[RECORDED]** (prior seeded run
`/tmp/opencode/gt-ux2-shots/`, seed since removed) or
**[NOT DEMONSTRABLE]** (needs live Muse or missing data).

## Beats

1. **Quiz (0–20 s) [LIVE].** Home → “Find your dish”: region →
   meal/mood → exclusions. Results arrive with the catalog note
   (“Selected from our food catalog without AI ranking”) when no
   Muse key is configured, or the “AI-ranked by Muse” note with the
   ranking-only explainer when it is. Names stay curated either way.
   Shot: `quiz-results-deterministic.png`.
2. **Muse-ranked reasons (20–35 s) [NOT DEMONSTRABLE live].**
   Narrate: Muse re-orders at most 10 already-eligible dishes; the
   sidebar card credits Muse with ranking only. No live inference
   ran in this environment (no live calls permitted), so show the
   deterministic card and state the swap explicitly. Do not present
   fixture text as a live ranking.
3. **Map pin → overview (35–60 s) [LIVE].** Restaurants → dismiss
   the area chooser → tap the red pin. Overview opens with name,
   address, area, rating, photo fallback, and Menu / Reviews / Scan
   / Directions. Focus moves into the panel; the pin shows pressed.
   Shot: `map-pin-overview.png`.
4. **Menu → waiter card (60–80 s) [RECORDED].** On a venue with a
   reviewed menu: Menu tab → variant quantities → “Show waiter
   card”. Recorded shots (`menu-expanded.png`, `menu-waiter-card.png`
   in `gt-ux2-shots/`) used the removed TESTQA seed. Current dev
   venues have no menus, so the live app shows the honest empty
   (“No curated menu offerings…”, shot `menu-empty-honest.png`).
   For the demo, replay the recorded pair and label them.
5. **Scan (80–115 s) [LIVE standalone / RECORDED extraction].**
   “Scan a menu” → hero + privacy notice → photo picker → 7 target
   languages → branch check against a real venue (“✓ …”, shot
   `scan-branch-verified.png`). Analysis, correction, and the
   corrected waiter card need live Muse + photos: replay from the
   prior verified journey or narrate over the standalone shots.
   Never upload a real customer photo on stage without consent.
6. **Trust note (115–150 s) [LIVE].** Reviews tab signed out:
   honest empties + “Sign in to continue” preserving the venue
   (`returnTo` round-trip verified). Dish page → “Find restaurants
   serving this” → honest dish empty that refuses to imply
   unverified places serve the dish, with “Back to dish”. Failure
   route stays typed (“This restaurant is unavailable” + Try again
   / Return home). Shots: `reviews-empty-signedout.png`,
   `dish-pho-bo-cta.png`, `dish-mode-honest-empty.png`,
   `failure-typed.png`.

## Appendix A — demo venue seed plan (dev only)

Use only if the demo needs beats 4–5 fully live. All rows
`TEST`-prefixed; remove afterwards.

```sql
-- 1. Venue (valid RFC UUID, variant bits 8/9/a/b in 4th group!)
INSERT INTO feastjourney.restaurant_venues
  (id, name, address, status, location)
VALUES
  ('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
   'TESTDEMO Pho House', 'TEST 1 Nguyen Hue, District 1',
   'published',
   public.ST_SetSRID(public.ST_MakePoint(106.704, 10.775), 4326)::public.geography);
-- 2. Menu + 3 items x 1 variant (published, prices optional/unknown).
-- 3. Reviews: 5-star + 4-star published, 2-star pending (proves gating).
```

Warnings from prior runs: a seed UUID like `22222222-2222-…`
(fourth group starts with `2`) fails the strict `z.uuid()` check
and breaks every venue path — generate a real v4/v7 UUID. Seeds
belong to the coordinator; confirm no other agent is using the dev
DB before writing. Cleanup: delete in reverse FK order and confirm
`restaurant_venues` returns to its prior count.

## Appendix B — smoke checklist (run before recording)

- [ ] `infra-app-1` responds 200 on `/`; note the worktree commit.
- [ ] Quiz completes to results; mode label reads correctly.
- [ ] `/restaurants` shows pins; pin tap opens overview; focus in panel.
- [ ] Overview actions route: Menu / Reviews / Scan / Directions.
- [ ] `/scan` standalone renders; branch check names the venue.
- [ ] Failure route `/restaurants/00000000-…` stays typed, no crash.
- [ ] Dish page CTA → dish mode → honest empty → Back to dish.
- [ ] Mobile 390 px: no horizontal overflow on demo pages
      (known exception: scan file inputs — see limitations).
- [ ] Console: no errors beyond known dish-image 404s.
- [ ] Shots saved under `/tmp/opencode/hackathon-shots/` with
      live/recorded labels; no binary shots committed to the repo.
