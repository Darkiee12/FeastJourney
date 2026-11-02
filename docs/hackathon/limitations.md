# FeastJourney — limitations (hackathon)

Honest bounds for judges and reviewers. Each item names what was
verified and what was not.

## Coverage

- Restaurant data is sparse by design: venues are never invented
  from tiles, names, or cuisine labels (ADR-0006). Dev currently
  holds 2 published venues with no reviewed menus, so menu-item,
  variant, and review-list live states need a `TEST`-prefixed seed
  (see `demo-script.md` Appendix A) or replayed recorded evidence.
- Dish search without approved serving evidence returns an honest
  empty by contract; “browse nearby” never implies those places
  serve the dish.

## Photos

- Dish cards 404 on missing dev images (observed
  `/api/v1/dish-images/205|290|6|59` → 404 during verification).
  Fallbacks render (photo initial), but visual richness depends on
  curated media that is not fully seeded.
- Venue photography now stages first-party bytes only: staff upload
  or rights-checked remote import, Sharp-validated, stored as
  private WebP derivatives, published explicitly, served same-origin
  (`/api/v1/restaurant-images/...`, member-gated `?preview=1`).
  Nothing is hotlinked; public delivery never exposes storage keys.
- Remote import rights (verified in unit tests, 34/34): allowlist is
  CC0, CC BY, CC BY-SA, or documented `licensed` permission only.
  `own-work` is rejected for remote URLs, unspecified licenses block
  publication, and CC BY-SA sets a ShareAlike notice that must survive
  review. SSRF gate is pre-connect per redirect hop (3 max, 8 MiB
  ceiling, image/* only); DNS-rebinding between check and connect is
  a documented residual, not a handled case.
- Menu pages follow the same lifecycle with photographed originals
  served as-is (no derivatives, so text stays full-resolution) at
  `/api/v1/menu-pages/...`. Scan-asset keys (`menu/...`) are never
  addressable through photo or menu-page delivery (table CHECK).
- Scan uploads accept JPEG/PNG/WebP ≤ 6 pages, 8 MiB each. SVG is
  refused; raster live-eval fixtures do not exist, so the live menu
  path records `not_run` without them (`ai-evaluation.md`).

## Translation uncertainty

- Extraction marks uncertain fields null with per-item uncertainty
  entries and keeps printed vs translated text separate — verified
  in schema, prompt, and stub harness (15/15), **not** in live
  inference. Currency-symbol ambiguity (`$`, `¥`), separator
  resolution in mixed formats, and instruction-override resistance
  are recorded live-only and unevaluated.
- Reviewed translations ship one language per item row; unreviewed
  text stays marked private/unverified through the waiter card.

## Ingredient safety

- The catalog has no verified-completeness representation for
  ingredients. Exclusions are best-effort name matches; unresolvable
  terms warn and are not applied. Printed ingredients “may be
  incomplete”; inferred ones are “interpretations, not allergy or
  dietary assurances” (`menu-copy.ts`). Never a safety claim.

## Model availability

- No `MODEL_*` key in this environment: recommendations serve
  deterministic order with the catalog note; the scanner refuses at
  its use boundary. Both are correct behavior, not errors.
- Model chip: `scanModelChip` renders from the scan read view
  `revision: { number, origin, model }` end-to-end (extract records
  the configured scanner model; verified in provenance tests).
  No per-call token/cost surfacing exists (extractor contract
  exposes no usage).

## Review gating

- Publishing requires `restaurant:manage` + `restaurant:review`,
  consolidated identity checks on P0-owned files are unverified by
  this agent, and customer corrections stay private until a
  reviewer promotes them in one audited transaction. Signed-in
  review submit, dialog keyboard flow, and 2000-char limit were not
  exercised at runtime (no test account; writing to dev DB is out
  of scope for this agent).

## Unshipped experiments

- P0 agents are still editing: provenance threading and extraction
  tightening touch `menu-scans.ts`, `menu-scan-page.tsx`,
  `scan-editor.tsx`, `muse-menu.ts`, `meta-client.ts`,
  `recommendation-service.ts`, `quiz-flow.tsx` (uncommitted at
  verification time). Anything in those files may change under
  this report — confirm before the final submission cut.
- Mobile scan page: hidden camera/gallery file inputs sit at x=57
  with full width, overflowing 390 px viewports by ~57 px
  (DOM-measured; `menu-scan-page.tsx` photo picker, P0-owned —
  reported, not fixed).
- `docs/product/vision.md` and `docs/product/mvp.md` are absent;
  acceptance framing here rests on implemented behavior and cited
  ADRs, not on product requirements documents.
