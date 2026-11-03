# Flyway migrations

Versioned, immutable schema history for the `feastjourney` app schema:

- `V20261027_001__enable_postgis.sql` — PostGIS prerequisite.
- `V20261028_001__food_catalog.sql` — canonical 3NF catalog (dishes,
  multilingual names/descriptions, ingredients, places + hierarchy,
  cuisines, categories, source providers/records, claim-level provenance).
- `V20261028_002__seed_catalog.sql` — curated multilingual seed data across
  continents and writing systems.
- `V20261028_003__editorial_catalog.sql` — application-owned slugs, removal
  of encyclopedia-coupled columns/provenance, category slug alignment,
  place-hierarchy cycle guard, and internal editorial/audit records
  (`catalog_revisions`, `curation_notes`, `catalog_import_jobs`,
  `catalog_import_records`).
- `V20261028_004__catalog_additions.sql` — Phở gà variant, chicken ingredient,
  Valencia locality and associated popularity link.
- `V20261028_005__auth_and_members.sql` — Better Auth core tables (`user`,
  `session`, `account`, `verification`, database `rateLimit`), generated from
  the installed better-auth version via `bun scripts/generate-auth-migration.ts`
  and reviewed before check-in, plus application-owned `user_profiles`,
  `favorites`, and `security_audit_events`. The generator emits unqualified
  table names (the connection's `search_path` selects the schema at runtime);
  V005 pins the schema-qualified form. Regenerate against a fresh database
  and compare semantically before writing any new migration — never hand-edit
  an applied file.
- `V20261028_006__dynamic_rbac.sql` — database-managed authorization: `roles`,
  `permissions`, `role_permissions`, `user_roles` with the static vocabulary
  seeded, system roles (member/curator/moderator/support/admin/owner), their
  initial grants, and backfill of existing users.
- `V20261028_007__user_permission_catalog.sql` — completes the user-management
  permission catalog omitted from V006 (`user:list`, `user:create`,
  `user:delete`, legacy names) with least-privilege grants to admin/owner.
- `V20261028_008__food_import_permission.sql` — adds the `food:import`
  permission for bulk catalog import validate/apply, granted to
  curator/admin/owner, replacing the legacy admin-key bypass with dynamic
  RBAC checks.
- `V20261028_009__default_member_role.sql` — AFTER INSERT trigger on `user`
  assigning the `member` role in the same transaction (email/OAuth/admin
  creation paths), idempotent via ON CONFLICT DO NOTHING.
- `V20261028_010__remove_orphan_user_read.sql` — removes the orphaned
  `user:read` key (seeded by V006 but absent from the code vocabulary and
  never checked) and grants support the vocabulary-backed `user:list` for
  its documented read-only user views.
- `V20261028_011__import_job_source_metadata.sql` — additive nullable
  columns on `catalog_import_jobs` (`source_url`, `source_version`,
  `license`, `attribution`, `editorial_notes`) so the import studio keeps
  source metadata with the job; widens the `format` check to `json`/`csv`
  (staged payloads stay validated JSON records).
- `V20261028_012__import_job_approvals.sql` — server-enforced approval
  columns for atomic import apply.
- `V20261028_013__import_apply_claim_and_providers.sql` — atomic apply
  claim plus source-record provenance writes.
- `V20261029_004__dish_media.sql` — dish photography storage, review, and
  delivery.
- `V20261030_001__dish_revision_history_index.sql` — revision history
  index.
- `V20261030_002__dish_media_photo_metadata.sql` — photo metadata for
  dish media.
- `V20261030_003__import_batching_progress.sql` — batched import
  progress tracking.
- `V20261030_004__country_registry.sql` — full ISO country registry with
  formal, short, and Vietnamese labels.
- `V20261031_001__country_short_names_preferred.sql` — prefer short
  English country names in choosers and cards where a formal/short pair
  exists (e.g. "United States", not "United States of America").
- `V20261031_002__city_registry_seed.sql` — canonical city-level registry
  seed proving the place pipeline: India → Karnataka → Bengaluru (with a
  "Bangalore" alias), Vietnam → Hanoi and Ho Chi Minh City. Places only;
  no dish associations are fabricated.
- `V20261101_001__place_revisions.sql` — place-registry audit trail
  (`place_revisions`, place-scoped, `deleted` tombstone survives row delete).
- `V20261101_002__place_revisions_cascade.sql` — non-deleted place history
  cascades with its row; only the `deleted` tombstone survives.
- `V20261101_003__dish_place_pair_key.sql` — converge dish↔place links on
  the `(dish_id, place_id)` pair key, keeping `origin` over redundant `popular`.
- `V20261102_001__user_food_preferences.sql` — member ingredient exclusions
  (`user_food_preferences`, one row per member, upsert-safe).
- `V20261102_002__restaurant_discovery_and_currency.sql` — Restaurant Discovery
  foundation (from PR#6 `V20261028_100`, renumbered after main `V20261102_001`):
  businesses, venues (PostGIS), names,
  cuisines, menus/items/variants, sources, serving evidence, price observations,
  FX cache/leases, `user_profiles.preferred_currency`, `restaurant:manage/review` grants.
- `V20261102_003__restaurant_observation_integrity.sql` — immutable provenance
  and receipt source/amount triggers (from `V20261028_101`).
- `V20261102_004__restaurant_search_names.sql` — diacritic-folded search names
  trigger (from `V20261028_102`).
- `V20261102_005__authoritative_iso_currencies.sql` — SIX ISO 4217 currency
  authority swap (from `V20261028_103`).
- `V20261102_006__venue_coordinate_projections.sql` — generated lon/lat
  projections (from `V20261028_104`).
- `V20261102_007__offering_identity_and_retirement.sql` — item/variant identity
  immutability + retirement (from `V20261028_105`).
- `V20261102_008__unknown_receipt_adjustments.sql` — nullable receipt adjustments
  (from `V20261028_106`).
- `V20261102_009__private_menu_scans.sql` — private scan sessions/assets/revisions/
  contributions (from `V20261029_001`).
- `V20261102_010__unverified_source_authority.sql` — remove restaurant-verified
  price authority tier (from `V20261029_002`).
- `V20261102_011__contribution_evidence_menus.sql` — contribution-to-menu mapping
  (from `V20261029_003`).
- `V20261102_012__scan_retention_and_reviewed_text.sql` — retention, reviewed
  translations, supporting pages (from `V20261030_100`).
- `V20261102_013__restaurant_item_source.sql` — venue-scoped source FK for
  price-free items (from `V20261030_101`).
- `V20261102_014__reviewed_variant_and_price_text.sql` — reviewed variant text +
  original printed price tokens (from `V20261030_102` + `_103`).
- `V20261102_015__restaurant_menu_sections.sql` — nullable `section_key` on
  restaurant menu items for curator-arranged menu sections.
- `V20261102_016__restaurant_images.sql` — venue-scoped `restaurant_photos`
  tables (draft→review→published, rights metadata, `restaurant-photos/` keys).
- `V20261102_017__restaurant_image_indexes.sql` — display/publish/review
  indexes for restaurant photos.
- `V20261102_018__restaurant_import_jobs.sql` — bulk import job tables with
  staged payloads and validate-vs-apply state.
- `V20261102_019__restaurant_import_records.sql` — per-record import results
  with external-identity dedup keys.

- This directory contains **schema/data migrations**, not application Reylo queries.
- Create next versioned SQL files such as `V20261027_002__create_user_accounts.sql` after domain ownership and schema review.
- Never edit, rename or delete a versioned migration that has been applied to a persistent database; add another migration instead.
- Use `R__name.sql` only for genuinely repeatable, idempotent database objects (views/functions), not arbitrary data rewrites.
- SQL files in this directory are executed by Flyway **before** the application deploys; do not import them from TypeScript.
- PostgreSQL owns constraints and transaction integrity. Reylo analyzes application query files against the schema resulting from these migrations.

See `docs/infra/migrations.md`, `docs/infra/postgres.md`, and `docs/architecture/persistence.md`.

A checked-in migration is immutable once applied. Never edit, rename, or
delete an applied file; write the next forward migration instead.

Flyway manages the `feastjourney` app schema and schema history, while PostGIS extension objects are in `public` on initialization. Schema-qualify future app tables or set search_path intentionally; do not enable automatic baselining merely to bypass PostGIS-created public objects.
