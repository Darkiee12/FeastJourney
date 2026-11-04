# Recommendations (implemented)

**Status: Implemented** on PR #3 (`feat/food-discovery`). Public,
session-optional dish chooser embedded in the homepage (`/#recommend`)
plus a minimal public dish
page (`/dishes/$dishId`, slug or numeric id) linked from result cards.
The database owns facts; Muse only orders already-eligible candidates.

## Homepage discovery carousel (implemented)

The `/#discover` section shows published food immediately, country-first:

- Visitor country comes only from the trusted boundary
  (`getQuizRegionFn` → `getTrustedVisitorCountry`: Cloudflare
  `cf-ipcountry` honored behind a verified trusted proxy/CDN, otherwise
  only `DEV_VISITOR_COUNTRY` applies). No other IP-geolocation provider,
  no untrusted header path. All headers missing → worldwide fallback.
- One exclusive scope per request (`carouselQuerySchema` + the
  `CarouselScope` ADT: `Nearby{lat, lon, country?}` | `Country{country}` |
  `Worldwide{}`): worldwide never carries coordinates or a country, a
  country request never retains previous precise coordinates. Ambiguous
  shapes fail closed with `InvalidSearchFilter`.
- One coherent fallback chain in `DishService.getLocalCarousel`
  (nearby → country top-up → country → worldwide → honest empty; country
  → worldwide → honest empty). A sparse nearby pool (< limit) keeps its
  dishes first and is topped up with distinct country dishes
  (`supplemented: true`, served scope stays `nearby`); unknown
  well-formed country codes stay typed `PlaceNotFound` at the service and
  the server function serves worldwide instead. The response carries
  `requestedScope`, `scope`, `fallback`, `fallbackReason`, and
  `supplemented` — the client words every label from the served scope,
  never the requested one.
- A dish linked to a child locality (e.g. Hanoi under Vietnam) is eligible
  for country browsing: country selection expands the place subtree
  downward (country → descendants), never upward. Association reads as
  "associated with", never as proof a restaurant serves it nearby.
- Consumer copy rules (do not reintroduce): one compact location control
  (`{country} · Change location`) with a focused selector (precise,
  destination, worldwide); never show "network region", "IP-derived",
  "precise fix", "Cloudflare", raw coordinates, or a city in a heading
  the query did not run. Headings and subtitles follow the served scope
  (`discoveryHeadingFor` / `discoverySubtitleFor`); supplemented pools
  read as regional with the country named. The carousel footprint never
  collapses to a paragraph: loading skeleton, real cards, error-with-retry,
  or the illustrated catalog-empty panel. Geolocation is explicit-only
  (tapped, never auto-requested) and denial keeps existing content.

## Discover geographic honesty (scoped pools never widen to worldwide)

  Scoped discovery requests (country, city, precise nearby) never widen to
  the worldwide pool. The quiz rule applies verbatim: serve the requested
  city, then its ancestor country, then an honest empty with an explicit
  user action to explore worldwide — never silent unrelated dishes (e.g.
  Mexican dishes for a Vietnam selection). Concretely, in
  `DishService.getLocalCarousel`:

- Country with dishes → `country`, no fallback. Country known but empty →
  honest empty (`scope: "country"`, `fallback: true`,
  `fallbackReason: "country-empty"`, zero items).
- City with dishes → `city`, no fallback; a sparse city pool is topped up
  with distinct ancestor-country dishes (`supplemented: true`, still
  `city`, client reads it as regional with the country named). Empty city
  with a stocked ancestor → `country` (`fallbackReason: "city-empty"`).
  Empty city with an empty (or missing) ancestor → honest empty
  (`fallbackReason: "city-empty-country-empty"` or `"city-empty"`).
- Precise nearby with dishes → `nearby` (sparse pools topped up from the
  country hint, `supplemented: true`, still `nearby`). Empty bands with a
  stocked country hint → `country` (`fallbackReason: "nearby-empty"`).
  Empty bands with an empty hint — or no hint — → honest empty
  (`fallbackReason: "nearby-empty-country-empty"` or `"nearby-empty"`).
- Explicit worldwide (`world` / `world-auto`) is the only lane that serves
  worldwide dishes. Unknown well-formed country codes stay typed
  `PlaceNotFound` at the service; `getLocalCarouselFn` keeps its graceful
  half (serves worldwide for that rewritten request, labeled worldwide).

  The client needs no new strings for this: a scoped honest empty resolves
  through the existing `region-empty` fallback state (served scope is never
  `worldwide`, zero items), which renders `carouselRegionEmpty` with the
  explicit `carouselExploreWorld` escape hatch. Legitimate multi-country
  dish associations are preserved — selection expands place subtrees
  downward and never filters by cuisine name or assumes one origin per dish.

## Provider selection (explicit, validated)

`RECOMMENDATION_PROVIDER` (`deterministic` default, or `muse`) plus
`MODEL_*` credentials form one validated configuration, resolved per
request by `resolveRankingConfig` (env parsing itself is cached):

- `deterministic` → deterministic ranking with an honest note. Always available, no credentials needed.
- `muse` + valid key + supported model shape (`muse-spark-<major>.<minor>`
  releases, Standard or `-contributor` tier, plus `muse-wonder-<major>.<minor>`
  releases) + https base URL → Muse ranking
  with deterministic fallback only for transient/provider-output failures.
- `muse` with a missing key, out-of-shape model, or non-https endpoint →
  `Misconfigured`: the request fails closed (HTTP 500, no silent
  deterministic mode, nothing logged but the failure class).

Startup never requires the provider to be online; validation is
offline (shape only).

## Pipeline

```text
preferences (Zod enums shared with the UI via recommendation.constants.ts)
  |
  +--> rate-limit budget ("search" bucket; identity is per-client IP
  |     only when TRUSTED_PROXIES is configured — otherwise all direct
  |     traffic shares one global budget, which is the honest enforced
  |     limit; over budget -> HTTP 429 with Retry-After, provider never
  |     called)
  v
exclusion resolution (IngredientRepository.resolveByKey)
  |  ONE unified list, ONE policy: every exclusion term resolves against
  |  the ingredient registry (locale first, English fallback for
  |  non-English locales); resolved terms become hard SQL exclusions;
  |  each unresolvable term yields one explicit warning and is NOT
  |  applied as a filter:
  |    `Could not match exclusion "<term>" to a known ingredient; it was
  |    not applied as a filter.`
  |  The transport merges the canonical `excludedIngredients` list with
  |  legacy `avoid` / `allergies` terms (canonical-first order, exact
  |  dedupe). A request carrying legacy `allergies` terms appends exactly
  |  ONE explicit warning:
  |    `Legacy allergy terms were merged as ordinary exclusions; strict
  |    refusal no longer applies.`
  |  (Never a safety claim: the catalog has no verified-completeness
  |  representation for ingredients, so matches are best-effort name
  |  resolution. Raw terms are never logged — counts only.)
  v
candidate SQL (published only, cuisine filter, ANY-association region
filter — associated, NOT proof of origin; NOT EXISTS ingredient
anti-join; cuisine-match then meal-category-match then stable id ASC;
LIMIT param)
  |  zero rows -> Empty (with reasons)
  v
deterministic rank (cuisine +2, meal category +1; mood has no catalog
signal and only reaches the Muse prompt) with cap 10, then Surprise
windowing when `surpriseSeed > 0` (stable head at seed 0; nonzero seeds
offset into the ranked pool so different eligible dishes surface, with an
honest note and no provider call)
  |
  +--> deterministic / no key -> ReadyDeterministic
  |
  +--> Muse structured ranking (single bounded call, operator-owned
         timeout and token budget, re-ranks the first 10 deterministic
         candidates — never the whole pool)
         valid -> ReadyMuse | auth/permanent/misconfigured -> typed
         failure (no fallback) | 429/transient/invalid -> deterministic
         fallback reported as deterministic + warning
```

No transaction is held across the model call: queries complete first and
result cards hydrate from the already-fetched candidate rows.
Model concurrency is bounded by design (one bounded request per
recommendation call, no fan-out).

## Eligibility is deterministic; ranking may be probabilistic

Hard constraints (published status, cuisine/region match when requested,
ingredient exclusions) run in SQL before Muse ever sees a candidate. The
region filter matches ANY geographic association and must be read as
"associated with", never as proof of origin. Soft signals (mood,
variety, occasion fit) only influence ordering.

Allergies and dislikes share one unified exclusion policy: every term in
`excludedIngredients` (plus legacy `avoid` / `allergies` terms merged at
the transport) resolves against the ingredient registry, and resolved
terms become hard SQL exclusions. Unresolvable terms are lenient: one
explicit warning per term, no filtering for that term. There is no
allergy-triggered `Uncertain` refusal — the `Uncertain` ADT variant and
its `uncertain` wire mapping are retained for wire compatibility but are
no longer constructed by this flow (a legacy caller must never assume
safety semantics from a successful recommendation). Resolved exclusions
apply identically to the deterministic and Muse paths, which share the
same post-exclusion pool; only the ordering step differs.

## Muse integration (`src/server/integrations/meta-client.ts`)

- Provider: Meta Model API, `POST {baseUrl}/chat/completions`,
  `MODEL_MODEL_ID` (default `muse-spark-1.3`), `MODEL_BASE_URL`
  (default `https://api.meta.ai/v1`).
- Structured output: `response_format: {type: "json_schema"}` with the
  minimal `{ranked_candidate_ids: string[], reasons: string[]}` contract
  (`additionalProperties: false`, `required` set, `strict: true`).
  Candidate IDs are never injected as schema enums. The parallel `reasons`
  array carries one ≤140-character grounded fit note per ranked ID, in the
  same order — grounded only in the supplied cuisines, categories, region,
  occasion, mood, and exclusion-respect; never safety, health, popularity,
  social-proof, or open-hours claims.
- The prompt contains candidate IDs + names + ranking metadata only: no
  user identity, sessions, email, or admin metadata. Candidate
  names/descriptions are treated as untrusted text, never instructions.
  The ranking context also carries the diner's raw exclusion terms as one
  user-message line (`Ingredients to avoid: <terms or "none">`) —
  untrusted data for ordering guidance only, never system instructions —
  and the system prompt requires the model to respect the listed
  exclusions when ordering while never claiming safety. Eligibility
  itself is enforced in SQL before the model is consulted.
  Prompt injection cannot mint dish IDs: membership is validated
  server-side against the candidate set.
- Business validation is server-side in the operation, not the client:
  every ID must belong to the candidate set, no duplicates, at most 10,
  non-empty when candidates exist. Reasons must match IDs one-to-one and
  pass a claim denylist (safety/health/popularity/social-proof/open-hours
  language); any violation is `MetaInvalidOutput` with deterministic
  fallback and no model text shown. Auth/permanent failures and
  misconfiguration are typed errors with no fallback; rate-limit (429),
  transient (5xx/timeout), and invalid-output failures fall back to
  deterministic order reported as `deterministic`.
- No retries (single attempt), `AbortSignal.timeout` at exactly
  `MODEL_TIMEOUT_MS` (default 15 s, no upper bound — an explicit operator
  value is honored as set and provider limits surface as provider
  failures), `max_tokens` at exactly `MODEL_MAX_TOKENS` (default 4000, no
  upper bound), `MODEL_CANDIDATE_LIMIT`/`MODEL_OUTPUT_LIMIT` honored as set
  (defaults 60/10; the service still returns exactly `outputLimit` dishes),
  no key/payload logging — only backend, model id, counts, duration,
  and fallback reason. The model re-ranks the first 10 deterministic
  candidates, never the whole pool: reasoning-token bloat on 30–60
  candidates routinely blew the timeout or truncated the
  strict JSON. All secrets stay in server-only `MODEL_*`
  env vars; without an explicit `muse` provider selection the pipeline
  runs deterministically with an explicit note (never mislabeled).

## Transport

`recommendDishesFn` (POST, Zod-validated, public): `{mode, dishes,
warnings, reasons}` where mode is `ai | deterministic | uncertain |
empty`. The domain models four variants (`ReadyMuse`,
`ReadyDeterministic`, `Uncertain`, `Empty`) with exhaustive `$match` at
the boundary; the wire keeps the stable four-string shape. `Uncertain`
is retained for wire compatibility but is no longer constructed by the
recommendation flow (see above). `dishes`
reuse the published `DishSummary` card projection — no draft content, no
internal notes, no new DTO. On `mode: "ai"` each card may carry an
optional `aiReason` (the validated per-dish fit note); all other modes
strip it. Uncertain/empty return HTTP 200 with reasons
and zero dishes (an honest empty, not a fake success); invalid input is
a Zod 400; over-budget requests get HTTP 429 with `Retry-After`.

## Tests

`tests/integration/recommendation.test.ts` (fake `MetaClient` via Layer —
no live calls, no API spend): eligibility, unified hard exclusions
(single, multiple, alias resolution), per-term unresolvable warnings
with continued recommendations, no-refusal on former allergy terms,
fake-AI ordering + hydration + shape validation (bad IDs,
dupes, over-limit with seed-independent fixtures, exactly-at-limit
acceptance, malformed, empty), provider context (meal/mood/region/
exclusions, no stale exclusions across submissions, eligible-only
candidates), 401/403 auth and permanent failures with
no fallback, 429/transient/invalid-output fallback to deterministic,
misconfiguration failures, deterministic baseline properties, concurrent
apply idempotency where relevant. `tests/unit/
meta-schema-parity.test.ts` pins the transport vocabularies, the
provider-schema/codec contract (including `strict:true` shape), and the
config-resolution table. `tests/unit/request-identity.test.ts` covers
rate-limit identity derivation; the shared fixed-window limiter itself
is covered in `tests/integration/rate-limit.test.ts`.
