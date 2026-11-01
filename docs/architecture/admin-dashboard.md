# Administration dashboard and import studio (implemented)

**Status: Implemented** on PR #3 (`feat/food-discovery`), extended with
dish editing, place registry management, and city-level import links (see
below). Admin surface for catalog curation; all mutations gated by session
RBAC, never published automatically. Dish detail also allows status editing
with a server-checked publication checklist; publishing stays a
`food:publish` decision.

## Routes (`src/routes/`)

| Route | Responsibility |
| --- | --- |
| `/admin` | Editorial overview: attention queue, health counts, recent imports/dishes |
| `/admin/dishes`, `/admin/dishes/$dishId` | Status-filtered catalog list; curation detail with section editors (identity, names, descriptions, ingredients, taxonomy, places) |
| `/admin/places`, `/admin/places/$placeId` | Place registry: searchable/filterable list (kind, parent, query), detail with names, metadata, hierarchy, linked dishes |
| `/admin/imports`, `/admin/imports/new`, `/admin/imports/$jobId` | Import history, 7-stage studio wizard, deep-linkable job detail |
| `/admin/reviews` | Review queue (status `review` dishes) |
| `/admin/users`, `/admin/roles` | Existing pages, now children of the shared `admin.tsx` shell |

`admin.tsx` is a layout shell (nav + `<Outlet/>`); permission-aware nav is
convenience only. Every page `beforeLoad` requires a session plus
`adminSurfaceFn()` (holds `admin:access`, `food:import`, or
`moderation:read`); every server function re-checks its own grant.

## Transport (`src/modules/food-discovery/`)

- `admin.schema.ts` — Zod boundary schemas, source registry
  (`SOURCE_REGISTRY` + `needsLicenseReview`), RFC-4180 CSV reader for the
  one documented CSV shape, JSON envelope parser, `FEASTJOURNEY_JSON_TEMPLATE`.
- `admin.functions.ts` — `adminSurfaceFn` (OR-gate over the three surface
  grants), stats/dishes/detail/reviews/imports server functions. File bytes
  are re-parsed server-side; client previews are never trusted.
- `server/operations/admin-dashboard-service.ts` — read aggregation plus
  `validateImport`/`applyImport` delegation to `CatalogImportService`.

## RBAC mapping

Surface read + `food:read` (stats, dishes, places); `moderation:read`
(reviews); `food:import` (import reads, validate, apply). Dish/place
mutations require `food:update` at the server boundary AND inside the
domain service (defense in depth); reads are policy-free, transport
enforces `food:read`. `DishService.getDishForCuration` is the
status-agnostic read for curation; public `getDish` still resolves
published dishes only.

## Persistence

- `V20261028_011` adds nullable source metadata to `catalog_import_jobs`
  (`source_url`, `source_version`, `license`, `attribution`,
  `editorial_notes`) and widens `format` to `json`/`csv`.
- `V20261028_012` adds approval columns (`approved_by`, `approved_at`,
  `license_ack`, `review_ack`, `acknowledged_duplicates`).
- `V20261028_013` widens the job status CHECK with `applying` (atomic
  apply claim; re-entrant resume skips already-processed rows) and seeds
  first-party `source_providers` rows (`manual`, `partner`, `community`,
  `other`) so normal registry imports always resolve provenance.
- `V20261030_003` adds batching progress without new lifecycle states:
  `catalog_import_jobs` gains `staged_count` (doubles as the stage cursor),
  `applied_count`, `skipped_count`, `apply_failed_count`;
  `catalog_import_records` gains `record_index` (global 0-based position,
  partial UNIQUE `(job_id, record_index)` — the idempotency key) and
  `record_slug` (indexed, for the global duplicate scan). Status CHECK
  unchanged: `staged` doubles as "open for appends while
  staged_count < total_records".
- New purpose-specific Reylo queries: `admin-dishes-by-status`,
  `admin-dishes-recent`, `admin-dishes-missing-ingredients-count`,
  `admin-import-jobs-by-status`, `admin-import-jobs-recent`,
  `admin-import-job-find`, `admin-import-records-by-job` (string IDs for JSON),
  plus batching queries `import-job-lock`, `import-job-update-stage`,
  `import-job-update-apply`, `import-record-slugs-by-job`,
  `import-records-pending-by-job` (apply window, `valid` only),
  `import-records-page-by-job` (keyset issues page),
  `import-records-count-by-job`, `import-record-insert-staged`.
- `V20261101_001`/`V20261101_002` add a place-scoped audit trail:
  `place_revisions` (`place_id` NULL-able so a `deleted` tombstone survives
  its place; live rows CASCADE, mirroring `catalog_revisions` for dishes).
  Every place mutation writes one revision row in-transaction.
- `V20261101_003` converges `dish_places` on the `(dish_id, place_id)`
  pair key: legacy dual `origin`+`popular` rows on one country collapse to
  `origin`, then the PK narrows from `(dish_id, place_id, association)`.
  The admin editor already treated the pair as the link key (update in
  place, never duplicates); the database now enforces it.

## Dish editing (implemented)

`/admin/dishes/$dishId` keeps read-only cards with small per-section Edit
actions: inline editing for simple fields, a section dialog for complex
forms. Every update returns the saved rows so the UI re-renders without a
second fetch; list filters/pagination survive the round trip.

- `admin.functions.ts` — `adminUpdateDishFieldsFn` (slug, parent slug,
  status), `adminUpdateDishNamesFn`, `adminUpdateDishDescriptionsFn`,
  `adminUpdateDishIngredientsFn` (registry-id only), `adminUpdateDishTaxonomyFn`
  (cuisine/category upsert/remove diffs), `adminUpdateDishPlacesFn`.
- `admin.schema.ts` — matching `{upsert, remove}` Zod schemas; edits carry
  record ids and preserve publication checks plus audit revisions.
- `admin-service.ts` — transactional ops with uniqueness checks; dish↔place
  updates key on `(dish_id, place_id)` (association/disputed/note updated in
  place, removal by place id), request-level duplicates rejected, linking
  defaults to `associated` (origin claims must be explicit).

## Place registry (implemented)

- `place.schema.ts` / `place.functions.ts` — Zod boundary plus seven
  server functions: list (query/kind/parent/page), detail (hierarchy,
  dish counts), create, update, names upsert/remove, parent set/remove,
  delete. A city is `kind: 'locality'` with NULL ISO; coordinates
  nullable both-or-neither with range checks; one preferred name per
  (place, language).
- `place-admin-service.ts` — `PlaceAdminService` with typed refusals
  (`PlaceHasChildren`, `PlaceHasDishLinks`, `ConflictingPlace`,
  `AmbiguousPlace`, `PlaceNotFound`); cycle guard client-side plus the
  existing DB trigger; `resolvePlaceRef` accepts `{placeId}` | `{iso}` |
  `{city, parentIso?}` with preferred-first matching and parent scoping.
- List search is token-AND over the normalized search key: every query word
  must appear in the same name row, so `Listville 2024` matches
  `Listville Alpha 2024`. Reads are policy-free; the nav entry is gated by
  the `dishes` capability (curators manage dishes and places together).

## Import lifecycle (current scope)

Upload → Source → Validate → Issues → Confirm → Apply → Done. Validate
preflight-rejects duplicate slugs, then stages records atomically; jobs
with ≥1 valid record validate (invalid rows are skipped, never applied).
Duplicates are advisory (`duplicateOf` + curation note); the wizard
requires explicit per-duplicate acknowledgment, merge/update stays
disabled with an on-screen reason. Apply claims the job atomically
(`validated` → `applying`; a concurrent apply gets a typed conflict and
a crashed apply is resumable by re-entry), verifies the stored license
need plus review/duplicate acknowledgments server-side (persisted with
the approver identity), writes `source_records` + `dish_sources` links
per record, and lands dishes in `review`. Job/record rows make progress
reload-safe; detail polls every 5 s while the job is open. Large datasets
follow the same lifecycle through the batched protocol below — the only
differences are cursor-driven staging/applying and paginated issues.

Import `places` entries use one grammar in CSV cells and JSON arrays:
`target[:association]` where `association` is `origin` | `associated` |
`popular` (case-insensitive) and a missing association always means
`associated`, never `origin`. Targets:

- `<ISO3166>` — existing country/subdivision code (`VN`, `IN-KA`);
- `"place:"<numeric id>` — canonical registry id (`place:45`);
- `<city name>"@"<parent ISO>` — city/province scoped by its parent
  (`Hanoi@VN`, `Bengaluru@IN-KA`);
- `<bare city name>` — allowed but must resolve unambiguously; otherwise it
  is reported ambiguous.

CSV cells split entries on `;` (documented, backward compatible) and `,`
(`"Hanoi@VN:popular, Bengaluru@IN-KA;VN:origin"`). JSON keeps `{iso}` and
`{place_id}`, adds the `{city, parent_iso}` object form plus the
`association` field, and supports arrays (multiple associations per dish).
Resolution mirrors the place workstream: preferred names then aliases,
scoped by the parent; ambiguous names list candidates with geographic
context (`"Name (Province, CC)" [place:<id>]`) so the curator refines with
`City@Parent` or `place:<id>`; unknown names (or unknown parents) are
actionable issues naming the Place Manager path. Never a silent country
fallback, never an auto-created place from untrusted input, never an
inferred origin. CSV parsing rejects duplicate headers, ragged rows, and
misplaced quotes with row numbers. Server-side UTF-8 byte length (not
client metadata) enforces the 16 MiB upload cap; every user-facing size
message uses the shared `formatFileSize` binary formatter
(`src/shared/format-file-size.ts`), never raw bytes as the primary label.
Blocking upload failures render in the reusable `GlobalNotification` portal
banner (`src/components/ui/global-notification.tsx`, `role="alert"`,
`z-[70]` above dialogs and the skip link) plus a concise field-level hint
with no second live region.

- `V20261030_003` adds batching progress without new lifecycle states:
  `catalog_import_jobs` gains `staged_count` (doubles as the stage cursor),
  `applied_count`, `skipped_count`, `apply_failed_count`;
  `catalog_import_records` gains `record_index` (global 0-based position,
  partial UNIQUE `(job_id, record_index)` — the idempotency key) and
  `record_slug` (indexed, for the global duplicate scan). Status CHECK
  unchanged: `staged` doubles as "open for appends while
  staged_count < total_records".

## Import batching (implemented)

- **Decision: one logical job, bounded batches, no dataset-level record
  guard.** Datasets up to `MAX_BATCHED_IMPORT_RECORDS` (20,000 — headroom
  past the 10,000-record target and the verified 4,474-record real dataset)
  import under ONE job id, ONE provenance row, ONE review/apply flow. The
  old 100-records/job rejection is gone; 100 survives only as
  `MAX_IMPORT_RECORDS`, the per-call transport bound (transaction size, 60 s
  server-function budget), not a dataset cap.
- **Protocol (client drives the cursor, server never holds the file):**
  `adminImportBeginFn` reserves the job with the declared total (same
  `<sourceId>:<license>` provenance convention as single-shot);
  `adminImportStageBatchFn` appends one window (`baseIndex` must equal the
  server's `staged_count` cursor) and validates it in a single short
  transaction; the final batch flips the job to `validated` (≥1 valid) or
  `failed`. `adminImportApplyBatchFn` applies one window of `valid` rows per
  call until the report says `done`. `adminImportJobIssuesFn` pages staged
  records keyset-style (`limit` + `cursor`, optional status filter) with
  per-status totals — the Issues review never loads the whole set.
- **Global duplicate detection without full materialization:** each stage
  batch is checked three ways — in-batch map (≤100 rows), one indexed
  `record_slug` scan over already-staged rows for the job (persisted
  findings, no payload parsing in memory), and the live catalog slug lookup
  — so the same slug in batch 1 and batch 3 is caught. Collisions mark the
  later row `invalid` with the earlier ref named; the later row keeps the
  slug in `record_slug` for the global finding but takes a suffixed
  `external_ref` (`<slug>#record-<index>`, `#` being impossible in real
  slugs) because `(job_id, external_ref)` is UNIQUE. Staging continues
  past collisions.
- **Idempotent retry / resume:** `record_index` uniqueness makes a retried
  batch conflict instead of duplicating; a batch fully below the cursor
  replays as current progress without writing; a partially overlapping
  batch is a typed conflict naming the exact cursor. Each batch commits
  atomically, so a crash leaves no half-written window. Apply selects only
  `valid` rows in original order, so resume never replays applied rows. A
  concurrent apply colliding with a live batch fails fast with a typed
  conflict (non-blocking try-lock on the job row — exactly one winner),
  while sequential batches, crash resumes, and post-completion repeats
  never contend and proceed. Counters (`staged/applied/skipped/failed`)
  persist per batch; `valid_records`/`invalid_records` stay frozen at
  validation values.
- **Honest partial failure:** apply is no longer all-or-nothing — the batch
  report carries per-call `applied`/`skippedDuplicate`/`failed` plus
  `done`/`pending`, and the job row accumulates the same. Acknowledgement
  pre-scan runs BEFORE any write in a batch, so a batch never leaves a
  half-applied window behind an ack failure. Review/apply gates are
  unchanged: apply requires `validated`, license + review acks are
  re-verified server-side on every batch call, and per-duplicate
  acknowledgement is still explicit. Past `done`, re-entry is a typed
  conflict (exactly-once holds: no row can apply twice, and the caller
  learns the terminal state from the conflict reason).
- **Compatibility:** `importJobStatusSchema` keeps its five states and
  `MAX_IMPORT_RECORDS` keeps its value (now documented as the per-call
  bound), so routes, wizard, and existing tests are unaffected. The
  single-shot `validateImport`/`applyImport` paths still work; `applyImport`
  is now one bounded batch reporting `done`/`pending` (small jobs finish in
  one call exactly as before).

## Known limitations (follow-up)

- Apply is synchronous and cursor-driven (100 rows/batch/client loop); no
  background worker yet. Very large applies need the wizard loop to run to
  `done` — a closed tab mid-apply leaves the job resumable in `applying`,
  never half-claimed.
- No per-record skip or merge/update actions (disabled in UI with reasons).
- Provenance needs a matching `source_providers` row; unknown sources skip
  writes rather than inventing providers.
- Dish-family cycles are rejected in the service layer (bounded ancestor
  walk); concurrent conflicting parent edits can still interleave — a DB
  trigger would close that TOCTOU window.
