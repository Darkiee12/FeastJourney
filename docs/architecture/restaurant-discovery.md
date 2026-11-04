# Restaurant discovery, private menu scans and ordering

Restaurant Discovery owns `src/modules/restaurant-discovery/`, its restaurant
routes and its SQL under `server/repository/sql/`. Global Flyway history records
the schema; see the [migration inventory](../../db/migrations/README.md).
Food Discovery continues to own canonical dishes. The single dish route is
`/dishes/$dishId`, accepting the established decimal ID or canonical slug.

Public journeys are dish → sourced venue offering, restaurant → reviewed menu →
waiter card, and private guest scan → corrected menu → waiter card. Reviewed menu
reuse needs no model call. Scanning requires neither a venue record nor
registration and never creates a restaurant from an AI guess.

## Relational knowledge and publication

Businesses have physical venues. Menus, items, variants, source snapshots,
serving evidence and prices are venue-scoped; composite foreign keys reject
cross-branch attachments. Food's public `getPublishedDishIdentities` batch read
filters candidate associations before Restaurant's SQL selects the best eligible
match, so an unpublished first choice cannot hide a published alternative.
Restaurant never imports Food's private SQL.

Imports create draft items and variants. Explicit publication requires
`restaurant:review` in addition to management. Observation decisions use a
pending-state compare-and-set and record attribution and audit in the same
transaction. Approval publishes eligible drafts without silently reviving
archived identities. Item/variant identity is immutable; changed names, portions
or reviewed text need new rows. Moving a venue invalidates earlier source
snapshots. Price-free imported items also retain a venue-scoped source reference;
legacy rows may have unknown source identity.

Source category, claimed origin and editorial review are distinct. Import input
accepts only `restaurantVerified: false`, and inserts force false. There is no
independent restaurant-ownership verification workflow. The legacy boolean no
longer raises a price's authority. A customer photo, model extraction or customer
correction is not official restaurant verification. Only approved, unexpired
exact/variant serving evidence participates in dish search; suggestions and
cuisine labels are not serving evidence.

Approved information remains in the existing restaurant menu, item, variant,
source, observation and serving-evidence tables. One reviewed translation
language can accompany each immutable item in its existing row; a menu records
its source language. Translation appears when it matches the requested display
language, otherwise original text remains available. There is no parallel
published JSON menu database or automatic translation cache. Inferred ingredients
do not become canonical dish attributes.

## Prices and currency

Price observations are append-only PostgreSQL `NUMERIC`, transported as decimal
strings. Original currency stays primary; private scans preserve raw printed
price text separately. Listed prices precede receipt-paid observations;
freshness, observation date and ID resolve selection. Receipt-paid values are
historical observations and are not listed ordering prices. Unknown prices never
become zero.

Strict budget/sort comparisons require a published dish, compatible portion key,
sales channel, current listed tax-included price, and common comparison currency.
Unknown portions and unknown/excluded taxes do not qualify. Local ranges require
at least three eligible venues. Stale/conflicting data remains reviewable; a
review horizon never guarantees current availability. Receipt records contain
structured food-line amounts only, not payment/customer identifiers. Unknown
discounts and fees remain NULL, and quantity × unit amount must exactly reproduce
a known net food-line total.

`effect/BigDecimal` performs source-currency lines, subtotal and FX arithmetic.
A subtotal is available only when every selected line has a complete price in
the same supported currency. Quantities are integers from 1 to 99. Mixed/unknown
currencies or prices produce an explicit unavailable subtotal. Taxes and service
charges are never inferred. A waiter card is an estimate to show staff, not an
online restaurant order or checkout.

Frankfurter v2 supplies optional dated reference FX. CSV preserves exact decimal
tokens; supported codes intersect SIX's authoritative ISO 4217 vocabulary.
Display rounds half away from zero to the target currency's fraction digits.
Conversion never creates an authoritative observation or implies acceptance of
another currency. Display-only FX failure leaves normal reads usable; a dependent
budget/sort fails explicitly. Independent pairs use concurrency four and one
fixed rate per pair for the request. Token-owned PostgreSQL leases, expiry and
failure cooldown bound refresh work; network calls run outside transactions.
Defaults are 24-hour refresh and 72-hour maximum effective-date age. Cleanup
failure preserves the original meaningful FX failure.

Saved currency belongs to User. Query keys, local choices and late responses are
scoped to the verified account; saves include the expected account identity.
Guest local preference does not override a newly verified member preference.
Display conversion changes do not refetch restaurant rows.

## Private scan lifecycle

`/scan` accepts JPEG, PNG and WebP camera/gallery inputs: at most six pages,
8 MiB each and 24 MiB together. The server bounds request bytes before form
allocation, verifies signatures and decoding, limits images to 20 megapixels and
12,000 pixels per dimension, applies orientation and re-encodes without EXIF.
It reserves an opaque `menu/{session-id}/{uuid}` key before storage, then reads
back bytes and verifies checksum/size before confirmation. Failed uploads remain
registered for deletion retry. Pages can be reordered/removed locally before
processing; revisions retain the extraction's source page identities.

The four private workflow tables are `menu_scan_sessions`, `menu_scan_assets`,
`menu_scan_revisions` and `menu_scan_contributions`.
`menu_scan_contribution_menus` maps promoted relational menus and supporting
pages to the reviewed submission. JSONB holds versioned private drafts, not
published restaurant truth. The server replaces model identifiers and assigns
identities to customer-added entries when saved. Revisions are immutable and
corrections use an expected-revision compare-and-set. Printed text, translation,
interpretation, unknown values and uncertainty remain separate.

Guests receive a 32-byte random capability in an HttpOnly, SameSite=Strict cookie
(`__Host-fj-menu-guest` with Secure over HTTPS; a development-only name over HTTP).
Only its SHA-256 hash is stored. A scan UUID or checksum does not authorize
access. Every read, photo read and mutation checks ownership and expiry.
Member access uses the verified Better Auth user; moving an earlier guest scan
into an account requires an explicit capability-checked claim. Account changes
remount private scan UI state. Reviewers use database RBAC, not guest cookies.

Personal scans expire after 24 hours. Explicit, unchecked `menu-facts-v1` consent
submits one exact saved revision and extends private review retention to 30 days.
That ceiling also applies to approved photographs and drafts: approval creates
no indefinitely retained photo copy and never publishes images. Reviewed
relational facts and minimal contribution/audit metadata may remain after
erasure. The submitted revision number remains after its erasable JSON reference
becomes NULL. Private access expires immediately; physical deletion is eventual
and depends on the maintenance schedule and storage availability.

## Extraction and provider limits

The server-only `MenuExtractor` adapter uses standard `muse-spark-1.3` through
`POST https://api.meta.ai/v1/chat/completions`. Authorized server-read bytes are
sent as multiple inline base64 image blocks with strict JSON Schema,
`store: false`, no tools, no provider file uploads and no Contributor mode.
The AI trust boundary validates shape, limits, exact money, currencies and
source-asset membership. Menu text rejects NUL and malformed Unicode before
PostgreSQL JSONB persistence. Normalized drafts use a conservative UTF-8 size
bound including JSON spacing; oversized extraction/corrections fail explicitly
before insertion. Truncation, refusal or invalid output fails recoverably;
there is no freeform repair chain or model-generated executable UI. Full-page
references remain; accurate bounding boxes are not claimed.

Operator configuration owns every extraction budget: `MENU_SCAN_TIMEOUT_MS`,
`MENU_SCAN_RETRIES`, `MENU_SCAN_MAX_RESPONSE_BYTES`, `MENU_SCAN_MAX_IMAGES`,
`MENU_SCAN_MAX_IMAGE_BYTES` and `MENU_SCAN_MAX_COMPLETION_TOKENS` flow through
exactly as configured with no upper bounds — invalid explicit values fail
loudly naming field + reason. The combined 24 MiB inline-payload bound is the
provider's transport limit, not an operator ceiling. Extraction runs detached
from the HTTP request under the operator's provider budget (async accept +
status polling in the browser). Acceptance returns the owned scan view after
the lease/worker handoff, with no provider wait; even fast scans may initially
return `processing`. Repeated acceptance of an active lease returns that view
for polling without another worker. Failed views without a document surface as
retryable client failures, including failures before the first poll. Browser
cancellation stops watching, not the accepted extraction; worker interruption
still reaches provider/storage requests and finalizes the lease. The worker
inherits the resolved services, owns a fresh resource scope, and remains
interruptible across the cancellation-masked lease handoff. No fixed HTTP
chain defeats the configured provider budget. The
extraction lease lifetime derives from the configured provider budget plus a
documented orchestration margin; PostgreSQL still guards at most four active
extractions and five attempts per scan (abuse/resource protections for this
guest-accessible endpoint, not operator ceilings). Leases survive restarts;
an expired lease can be retried explicitly (idempotent: a retry while work
is running observes the current view instead of duplicating it); success
reuses the stored revision. Workers are in-process, not durable jobs: process
loss requires an explicit retry after lease expiry, and deployment must keep
the server process alive for accepted work. The browser's existing polling
window can end before a long configured run; retry resumes watching it.

[Meta's vision](https://dev.meta.ai/docs/image-understanding) and
[structured-output](https://dev.meta.ai/docs/structured-output) guides document
the request combination. Standard mode and `store: false` do not establish zero
provider retention. Review the deployment account's
[terms](https://dev.meta.ai/legal/terms-of-service) and
[zero-data-retention policy](https://dev.meta.ai/help/policies-and-privacy/zero-data-retention)
before processing customer photographs. FeastJourney's deletion policy applies
to its own storage and cannot promise Meta deletion.

No live Muse call or semantic extraction benchmark is verified for this work.
Provider mocks test request shape and failures, not OCR, translation quality,
layout association accuracy, model access or real strict-schema acceptance.
A live multilingual benchmark remains necessary before claiming extraction
accuracy or empirically choosing one versus two model stages.

## Contribution review and promotion

After receiving a usable personal menu, customers may opt in separately.
Submission publishes nothing. An actor with both `restaurant:manage` and
`restaurant:review` inspects photographs, the exact revision, branch, original
and translated text, variants, uncertainty and price semantics at
`/admin/restaurants`. Approval requires selected items/prices, a confirmed sales
channel and private-evidence rights/privacy review. Rejection need not invent an
unknown channel. Observation dates must be in the past and validity must end by
the contribution's evidence-retention horizon.

Promotion reuses existing import, observation review and publication operations
in one locked database transaction, including mandatory audit. Registered private
objects are reused; no model/storage call runs inside that transaction. Each
per-page menu records all supporting asset IDs. Only selected prices are
approved; unselected/unknown prices remain unavailable. No canonical dish match
or dietary guarantee is inferred. Source creation is attributed to the
authenticated curator; guest provenance stays separate and private. Repeating
the same completed decision is idempotent; a conflicting decision fails.
After rejection, the customer may save a corrected revision and give fresh
consent for that new snapshot. The rejected contribution is retained unchanged;
pending and approved submissions cannot be silently replaced.

Authorized reviewers see checksum-match counts from other retained contributions.
Personal scans without contribution consent never enter that lookup, and no
foreign scan IDs or photographs are disclosed through the hint. A matching image
does not establish branch identity or freshness.

## Operation and verification

Enable scanning with `MENU_SCANNER_ENABLED=true`, `MODEL_API_KEY`, documented
`MENU_SCAN_*` limits and private S3 settings in
[environment configuration](../infra/environment.md). Missing Muse/storage
configuration does not disable unrelated discovery; invalid enabled settings fail
at the scanner's use boundary. Browsers only talk to FeastJourney: this path
needs no browser S3 endpoint, signed URL or S3 CORS configuration.

Schedule `bun run maintenance:menu-scans` at least every 15 minutes outside web
traffic. No automatic scheduler or in-process timer is installed. Each run
processes at most 100 expired sessions and 100 eligible assets with concurrency
four. Failed deletions retain metadata and wait 15 minutes before retry. Completed
sessions clear their current-revision pointer before draft erasure. Monitor
failed counts and schedule execution; see the [storage runbook](../infra/object-storage.md).

One deterministic React renderer supports reviewed menus and private drafts,
original names, reviewed translations, variant prices, uncertainty and ingredient
provenance. It offers touch/keyboard quantity controls and a high-contrast waiter
dialog with customer-reviewed original-language instructions. Search retains a
list alternative to the map; Near Me and map-area search clear conflicting named
areas. English/Vietnamese interface labels are supplied; menu text can use all
seven supported scanner languages.

Currency queries and local member preference storage are account-scoped.
Verified server preferences, including an explicit original-currency-only choice,
take precedence over an older local value; late responses for another identity
are ignored. Guest browser preferences use their own separate key.

Report static checks, real PostgreSQL/Garage tests, browser journeys and live
third-party calls separately. No historical PR test count or skipped CI commit
establishes current readiness. The product vision, MVP and trust-and-safety
documents referenced by `AGENTS.md` remain missing; this document does not invent
requirements in their place.

### Customer-review retention policy

Customer reviews use soft-delete-with-redaction. A removed row keeps
`author_id`, `venue_id`, `rating`, `created_at`, `updated_at`, and
`published_at` for audit and moderation history; only `body` is redacted to
`''` with status `removed`. The row never appears in published-only reads or
aggregates again. This is not anonymization: the author link stays so abuse
stays traceable and the partial unique index can distinguish terminal rows
from active ones. Resubmission after removal creates a fresh row only when no
active (`pending`/`published`) row remains; rejected rows stay for audit while
a fresh submission proceeds.
