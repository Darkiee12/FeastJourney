# FeastJourney — project summary (hackathon)

## Traveler problem

A traveler in Ho Chi Minh City wants to eat well without reading
Vietnamese. The hard parts are not finding *a* restaurant. They are:

1. Choosing *what* to eat from an unfamiliar food culture
   (dish discovery).
2. Finding a real place that verifiably serves that dish
   (place discovery).
3. Reading the actual menu in front of them — portions, prices,
   ingredients — and ordering without a shared language
   (understanding + action).

Each step fails silently today: a wrong dish pick, a wasted trip to a
place that does not serve it, or a guess-order from a menu photo.

## Why translation apps fall short

A generic camera-translation app renders words into the traveler's
language. It does not answer the questions that matter at the table:

- *Is this translation certain, or a guess?* Uncertain prices,
  currencies, separators (`65.000đ` vs `6.50`) and ambiguous
  item/price associations need explicit uncertainty, not fluent text.
- *Was this dish verified at this branch?* A translated name is not
  serving evidence. FeastJourney separates suggestions and cuisine
  labels from approved `exact`/`variant` serving evidence, and only
  approved evidence powers dish search.
- *Can I act on it?* The endpoint is a bilingual waiter card with
  quantities, estimates, and explicit unknown-price disclaimers — not
  a translated paragraph.
- *Who checked it?* Customer photos, model output and corrections are
  never presented as official verification. Reviewer approval is a
  separate, audited step.

Framing note: `docs/product/vision.md` and `docs/product/mvp.md` are
absent from this worktree. The claims above describe implemented
behavior, not a product requirements document.

## Discovery → understanding → action

1. **Discovery.** A 3-step quiz (region, meal/mood, exclusions) picks
   from the public catalog; a map-first restaurant search finds
   verified branches near the traveler. Dish pages link to serving
   venues (`/restaurants?dish=<id>`); venue overviews link back to
   reviewed menus, reviews, scan, and directions.
2. **Understanding.** A private menu scan photographs the menu,
   extracts items/variants/prices/translations with per-field
   uncertainty, and lets the traveler correct the draft. Reviewed
   venues show curated menus with reviewed translations and price
   provenance instead.
3. **Action.** The traveler builds a quantity-based order and shows a
   waiter card: original-language lines plus the traveler's language,
   estimated subtotal where prices are complete, explicit
   ask-the-waiter disclaimers where they are not. Nothing is
   submitted; the card is an estimate to show staff.

## Where Muse is used (implemented, code-verified)

- **Dish ranking** (`src/server/integrations/meta-client.ts`,
  `docs/architecture/recommendations.md`). `muse-spark-1.3` re-ranks
  at most the first 10 deterministic SQL candidates through one
  bounded call (15 s timeout, 4000-token ceiling, strict JSON
  schema `{ranked_candidate_ids}`, `store` unset / server-side only).
  Eligibility (published status, cuisine/region, ingredient
  exclusions) runs in SQL *before* the model sees anything; the model
  only orders. Auth/permanent failures fail closed; 429/transient/
  invalid output falls back to deterministic order labeled honestly.
  UI rule: only `mode === "ai"` renders Muse branding with a
  ranking-only explainer (`quiz-status.tsx`).
- **Menu extraction** (`src/server/integrations/muse-menu.ts`,
  `menu-scan.schema.ts`). `MenuExtractor` sends authorized
  server-read photo bytes as inline base64 with a strict JSON schema
  (`menu_scan_v1`), `store: false`, no tools. The system prompt
  forbids inventing items, prices, portions, ingredients and
  allergy/safety assurances; uncertain fields must be null with an
  uncertainty entry. Shape, money, currency and source-asset
  membership are validated at the AI trust boundary.
- **Live inference was not evaluated.** Per
  `docs/hackathon/ai-evaluation.md`, stub-harness results (15/15
  cases) validate plumbing only. No live Muse call, latency,
  accuracy, or cost measurement exists in this worktree.

## What the database contributes

PostgreSQL (Flyway-migrated, PostGIS 3.6) owns relational truth;
Garage (S3-compatible) holds binary photos. Metadata and bytes are
never confused.

- **Catalog:** `dishes`, `places` (geographic identities),
  `ingredients`, dish–place associations, curated translations.
- **Verified supply:** `restaurant_venues` (PostGIS geography),
  `restaurant_menus`/`items`/`variants`, price observations
  (append-only `NUMERIC`, raw printed text preserved), serving
  evidence (only approved `exact`/`variant` rows power dish search),
  import provenance (`restaurant_sources`, Overture ADR-0006).
- **Trust:** customer reviews (published-only reads, soft-delete
  with redaction), contribution review/audit trail, RBAC-gated
  curation at `/admin/restaurants`.
- **Private scans:** `menu_scan_sessions`/`assets`/`revisions`/
  `contributions` hold versioned JSONB drafts, never published
  truth; photos expire after 24 h (30 d after consented submission).
- **Reference data:** dated Frankfurter FX rates (display only),
  member currency preference (account-scoped).

## What works without AI

Everything except the two Muse calls above:

- Deterministic quiz ranking with an explicit catalog note.
- Discovery carousel, dish pages, map search, venue overview.
- Reviewed menus, variant quantities, waiter card, subtotal math
  (`effect/BigDecimal`, unknown prices stay unknown).
- Scan upload/storage/draft lifecycle, corrections with
  compare-and-swap revisions, contribution submission and reviewer
  promotion — minus the extraction step itself.
- All empty/failure states: honest empties, typed failures with
  retry/return actions, sign-in `returnTo` round-trips.

Missing Muse/storage configuration disables only the scanner's use
boundary; discovery keeps working
(`docs/architecture/restaurant-discovery.md` § Operation).
