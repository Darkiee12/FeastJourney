# PR #4 implementation and verification — 2026-10-30

This records actual local behavior and evidence. The branch remains draft; live
Muse validation, deployment/privacy decisions and CI on the eventual submitted
commit remain outstanding. Local test success does not verify extraction accuracy.

## A. GitHub and integration (verification snapshot before review push)

| State | Observed value |
| --- | --- |
| PR #3 verified integration head | `f778603bc6e6231bb6fb1564adc1523abe1ca5e4` |
| PR #3 Quality | Failed, [run 40978816885](https://github.com/Darkiee12/GoodTaste/actions/runs/40978816885); this is upstream CI, not a run of the local fixes |
| PR #4 historical starting head | `555d1f1bc57d63d099fbc82a671070889a8f4c66` |
| Other agent's completed PR #4 head | `4a65b417dde82990ec87d462be7a323e09851443` |
| Current local integration head | `6948b75f08176f2cb5d7f31909caeb805d8fd72f`, plus uncommitted implementation/remediation |
| PR #4 remote CI | No pull-request workflow run found at `4a65b417…`; no green CI claim |
| PR #4 remote mergeability | Conflicting against `feat/food-discovery` until the local integration is submitted; remote remains unchanged/draft |

The other agent's commits and working changes were preserved after the user
confirmed that agent had finished. Two normal local merge checkpoints integrate
PR #3's homepage and latest Feast Lab work. `git merge-base --is-ancestor
f778603bc6e6231bb6fb1564adc1523abe1ca5e4 HEAD` succeeds. No merge remains in
progress. `.env.example`/README conflicts preserved both feature sets; the admin
shell follows PR #3's single capability-driven navbar, extended with Restaurant
Discovery. One `/dishes/$dishId` route accepts the established published identity,
retains the rich dish/favorite experience and links to restaurant discovery.

Safety stashes remain available (`5480a345…`, `385412fe…`); both were restored
exactly once and their merge-autostash markers cleared. No force-push, reset,
remote merge, deployment or production data/storage operation was performed.
The user subsequently authorized committing and pushing these changes for draft
review, with `[skip ci]` in the commit messages. The ensuing review commits and
remote head are recorded in Git history and PR #4; the table above preserves
the verification snapshot before that push. No ready-for-review transition or
deployment is authorized.

The pre-push fetch subsequently found PR #3 at
`29d2124e9be8c578e1243b5ec0f08ce4982982fc`, adding substantial dish-photo and
geolocation work (44 changed files). Those newer changes are preserved on the
base branch but are not included in this verified snapshot. Integrating and
verifying that new base remains a draft-review follow-up; the review push does
not overwrite it or claim compatibility with it.

PR #3's discussion includes a historical GitGuardian generic-password warning
on the development Compose connection string at `a0d9f5a7…`. The integrated
development connection now references environment credentials. No secret
rotation, incident dismissal or history rewriting was performed here.

## B. Existing Restaurant Discovery findings

| Finding and cause | Correction and evidence |
| --- | --- |
| Typed failures flattened into generic errors | Explicit serializable safe tag/code/status/retry metadata at the HTTP edge; no SQL or stacks exposed. Five focused failure-mapping tests and real HTTP/browser journeys. |
| Highest-ranked unpublished dish hid a published alternative | Resolve identities through Food Discovery's public contract, then filter before SQL lateral selection. Immutable projections; Restaurant Discovery never imports private Food SQL. Restaurant integration coverage. |
| Import could claim restaurant verification | Imported verification claims are rejected/forced false; legacy boolean no longer raises authority. Independently authorized observation review, source category, dates, review actor and evidence status remain separate. |
| Incompatible or missing prices | Exact NUMERIC/string/BigDecimal, matching portions/channel/tax/freshness criteria, listed versus paid separation, unknowns never zero. Money/restaurant/FX tests and uncertain-price browser flow. |
| Cross-account currency leakage | Query key, response identity, writes, pending saves and browser storage all scope by verified owner. Saved original-currency-only choice overrides local history. Same mounted-app A→B browser test passes. |
| Serial FX and cleanup failure risks | Bounded concurrency four; dated snapshots, leases, cancellation, cooldown and response validation retained. Optional conversion failures leave original-price reads usable. Real cache/lease tests with substituted FX provider. |
| Near Me/area conflict and incomplete menu UI | Geolocation/map searches clear named-area conflicts. One shared menu renderer with variants, quantities, states, reviewed/private evidence and bilingual waiter dialog. Mobile browser evidence; physical camera/geolocation permission testing remains unverified. |
| Historical test claims | Replaced by current executed results below; no reliance on the previous 262-test claim. |

Additional discovered defects fixed: draft variant publication bypass, missing
price-free item provenance, misleading unknown-price labels, contribution insert
cardinality, repeated submission extending consent retention, correction IDs,
deletion retry loops, private draft erasure foreign keys, unbounded S3 reads and
strict command schemas rejecting the transport `action` discriminator. Provider
text rejects invalid Unicode; normalized documents are bounded before JSONB
insertion. Reviewer-only checksum hints exclude unconsented personal scans.

Upstream integration tests were also corrected: recommendation test runtimes
were retaining independent pools until `afterAll`, exhausting PostgreSQL's
connections; they now dispose after each test. Globe assertions now reflect
worldwide per-country anchors and the coarse land mask's small-island limits.
The upstream admin dish page uses a static TanStack server-function import.

## C. Implemented menu journey and Effect dependencies

Guests open `/scan` or an attached restaurant action, choose camera/gallery
images, reorder/remove pages, confirm the translation language and optionally
identify an existing physical branch. Server-authorized uploads enter private
Garage storage after signature/decode/size validation and EXIF stripping.

One bounded Muse request extracts source text, separate translations,
explanations, variants, exact/raw prices and uncertainty into a versioned draft.
The customer corrects fields immediately; saves append immutable revisions with
compare-and-set. Server-owned item/variant IDs replace untrusted additions.
Both drafts and approved relational offerings feed the same deterministic React
menu and exact cart. The high-contrast waiter dialog emphasizes original names,
variant labels, quantities, reviewable bilingual instructions and original
currencies. It explicitly says no restaurant order has been submitted.

Contribution is a separate unchecked opt-in tied to an exact saved revision.
It stays private. Authorized curators inspect photos and selected facts, confirm
branch/channel/rights/dates and promote only selected items/prices through the
existing relational import/review/publication operations. Reuse calls no model.
After rejection, a corrected saved revision can be submitted with fresh unchecked
consent; the old rejected snapshot and review decision remain immutable.

| Operation boundary | Dependencies |
| --- | --- |
| Create/read/revise/claim/contribute/delete scan | Existing Database/transaction runtime; explicitly verified request principal |
| Attach/read photograph | Database + `PrivateMenuStorage`; verified ownership/capability |
| Extract menu | Database lease + `PrivateMenuStorage` + `MenuExtractor`; cancellation propagated |
| Contribution queue/detail/photo/review/promotion | Request-scoped `CurrentActor`, database-backed `Authorization`, existing restaurant operations/audit; storage only for authorized photo reads |
| Expiry cleanup CLI | Database + `PrivateMenuStorage`; no web-session or OAuth/email dependency |
| Menu/cart/waiter projection | Pure functions and shared BigDecimal money facilities; no new service/runtime |

## D. Database and SQL

Approved data still uses `restaurant_businesses`, `restaurant_venues`,
`restaurant_menus`, `restaurant_menu_items`, `restaurant_menu_item_variants`,
`restaurant_sources`, immutable `restaurant_price_observations` and serving
evidence. Food Discovery owns canonical dishes. No parallel published menu store
or translation service/table was introduced.

- `V20261029_001`: private scan sessions/assets/immutable revisions/consented
  contributions, ownership and expiry constraints.
- `V20261029_002`: remove authority from unverified import claims.
- `V20261029_003`: contribution-to-existing-menu/private-source-page mapping;
  necessary for multi-page promotion and all supporting-page provenance.
- `V20261030_100`: erasable revision references with retained submitted revision
  number, deletion cooldown, reviewed text/source language and draft variant status.
- `V20261030_101`: venue-scoped item/source foreign key, deferred until commit.
- `V20261030_102`: reviewed variant translations beside immutable original labels.
- `V20261030_103`: original printed price tokens beside exact NUMERIC values.

Latest PR #3 adds `V20261029_004` dish media and `V20261030_001` revision index.
The uncommitted scanner Oct 30 migrations were reserved at `_100`–`103` to avoid
that collision. Their earlier numbering was used only in a disposable database;
that database was preserved. The combined history was tested in a new empty
`feastjourney_pr4_v2` database, without repair/clean or applied-history rewrites.
Thirty versioned migrations applied; Flyway validated all 31 history entries,
including schema creation.

All application SQL remains under Restaurant Discovery's
`server/repository/sql/`. `scan-*` queries enforce ownership, leases, immutable
revision/consent snapshots, review locks and retryable deletion. Existing
`admin-*`/`menu.sql` queries extend source, reviewed text, publication, price and
provenance projections with Reylo-inferred cardinality/types. Nested promotion
joins the ambient transaction; audit failure rolls the whole promotion back.

## E. Muse, Garage and retention

`MenuExtractor` supports standard **`muse-spark-1.3`**, using
**`https://api.meta.ai/v1/chat/completions`**, multiple inline authorized image
bytes, strict JSON Schema and `store:false`. Official vision/structured-output
contracts were inspected; request/response behavior is tested with synthetic
fixtures. **No live Meta call or semantic OCR/translation benchmark was made.**
The fifteen representative extraction fixtures explicitly retain `not_run`
live-evaluation status. Mock conformance is not factual accuracy or proof that
the deployment account supports the exact schema.

The server-only Garage adapter performs bounded PUT/read/delete, aborts and
checksum verification. Browsers use same-origin authorized photo/upload routes;
no public ACL, public object key, browser S3 credential, signed URL or browser S3
CORS endpoint is required for this path. Synthetic real Garage tests exercise
validation, ownership, upload confirmation, promotion and deletion retry.

Personal scans expire after 24 hours. Explicit contributions retain private
photos/drafts for at most 30 days, including approvals; idempotent resubmission
cannot extend that consent deadline. Reviewed relational facts and minimal audit
can remain. Evidence validity cannot extend beyond its review retention horizon.
Deletion removes actual Garage objects and private revision JSON, with bounded
batches and 15-minute retry cooldown. The maintenance CLI exists and was tested;
operators must schedule it at least every 15 minutes. No deployment scheduler
was installed and immediate physical deletion during outages is not promised.

Standard mode and `store:false` do not promise Meta zero retention. Deployment
must review its [Meta terms](https://dev.meta.ai/legal/terms-of-service) and any
separately granted [zero-data-retention arrangement](https://dev.meta.ai/help/policies-and-privacy/zero-data-retention).
No Contributor/training mode is enabled for menu scans. Production credentials,
least-privilege bucket access and deployment timeouts still require operator setup.

## F. Verification evidence

Commands used actual repository scripts; test-only environment was loaded from
local `/tmp` files, never committed. Disposable Postgres 18.6/PostGIS 3.6 and
Garage 2.5.0 used loopback ports 55434/53904 and tmpfs, not existing volumes.

| Command | Latest completed evidence |
| --- | --- |
| `docker compose -p fj-pr4-test -f /tmp/fj-pr4-test-v2-compose.yaml run --rm migrator` | 30 migrations applied, ending `20261030.103` |
| Same command with `validate` | 31 history entries validated |
| Repository Compose `config --quiet` | Passed; no expanded secrets printed |
| `bun run check` | Passed (format, zero-diagnostic lint, real Reylo/PostgreSQL typecheck), including final documented state |
| `bun test tests/` | 580 passed, zero failed across 58 files, 39,864 assertions; final full rerun completed in 28.23 seconds |
| `bun run build` | Passed; expected dependency `use client` and large-chunk warnings |
| `bun run test:browser` | Passed full guest/correction/variant/order/uncertainty/contribution/rejection/new-revision resubmission/review/reuse/privacy/account-switch journey; real app/DB/Garage, Muse fixture only |
| `bun run audit:dependencies` | No vulnerabilities in 532 packages |
| `bun run audit:slop` | Zero errors, 125 advisory warnings (not a zero-warning audit) |
| `bun run audit:react-compiler` | 172/172 components compiled; no incompatible libraries; StrictMode absent |
| `bun run audit:react-doctor` | Passed: zero errors, 120 advisory warnings across 224 files; setup detection and upstream dynamic import corrected without suppressing rules |
| `bun run audit` | Complete four-stage chain passed; warnings above remain advisory |
| `bun install --frozen-lockfile` | Passed without dependency changes |
| `bun run maintenance:menu-scans` | Standalone CLI passed with database/storage settings only; no expired test records remained (all counts zero) |

Flyway's final repeated migration pass validated all entries and reported the
schema up to date with no migration necessary.

Logs are under `/tmp/fj-pr4-{check,suite,build,react-doctor,react-compiler}-v2.log`,
`/tmp/fj-pr4-audit-v2.log` and `/tmp/fj-pr4-browser-run.log`. Earlier failed runs
were diagnosed (SQL cardinality/retention, HTTP transport, test pool exhaustion,
stale selectors, resource-contention timeouts) and do not establish current success.

Synthetic browser evidence: `/tmp/fj-pr4-browser-evidence/waiter-card-detail.png`,
`guest-waiter-card.png`, `reviewed-reuse.png`, `account-switch-isolation.png`.
The waiter dialog was inspected at 320px with keyboard Escape/focus restoration.
These are local artifacts, not CI or real customer images. Built public assets
were searched for the synthetic model/storage/auth secret values; none matched.

## G. Important changed paths and ownership

- `src/modules/restaurant-discovery/menu-{scan.schema,scan-revision,presentation}.ts`:
  versioned untrusted-data contracts, correction rules and pure shared ordering.
- `src/modules/restaurant-discovery/components/`: shared menu/waiter/editor,
  private scan entry, review UI, account-safe currency and restaurant integration.
- `src/modules/restaurant-discovery/server/operations/`: scanning, contribution
  promotion, deletion and existing discovery/import/review operations.
- `src/modules/restaurant-discovery/server/repository/sql/`: owning Reylo queries.
- `src/server/integrations/{muse-menu,menu-scan-config,private-menu-storage}.ts`:
  meaningful server-only provider boundaries, configured at the existing root.
- `src/server/http/`, `src/shared/client-failure.ts`: safe failure transport.
- `src/routes/scan.tsx`, `src/routes/api/menu-scans.ts`,
  `src/routes/admin.restaurants.tsx` and existing navigation:
  thin transport/pages, canonical dish-route and Feast Lab integration.
- `db/migrations/`, `scripts/cleanup-menu-scans.ts`, tests and synthetic fixtures:
  additive schema, explicit maintenance and behavior evidence.
- Canonical docs updated: Restaurant Discovery, contracts, access control, data
  model, persistence, Effect, Garage, environment/operations, database testing,
  quality gates, migration README and browser/fixture instructions.

## H. Remaining risks and release gates

1. A real authorized Muse account must verify model access, strict vision/schema
   acceptance, source/price/variant association, translations and representative
   multilingual images. Single-call extraction is implemented, not benchmarked;
   no calibrated confidence or reliable bounding boxes are claimed.
2. Deployment must validate Meta data handling, consent/rights policy, production
   private Garage credentials, server timeout budget and cleanup scheduling.
   SQL policy currently fixes retention at 24 hours/30 days; changing it requires
   an explicit policy/configuration decision rather than silently extending consent.
3. Physical camera denial/capture, a real screen reader, real poor-quality photos
   and live FX/provider outages are not proven by the synthetic browser run.
4. The latest base `29d2124e…` still needs integration and compatibility checks.
   GitHub has not tested these changes. The review push intentionally skips CI
   at the user's request. Do not mark PR #4 ready or claim green CI until the
   final submitted head passes the workflow.
5. `docs/product/vision.md`, `docs/product/mvp.md` and
   `docs/architecture/trust-and-safety.md` are still missing. No contents or
   decisions from those nonexistent documents were assumed.

Rollback is an application rollback only while schema-compatible. Keep additive
schema/history and registered private-object metadata; never use Flyway repair,
clean, shared-history rewrites or volume deletion as recovery.
