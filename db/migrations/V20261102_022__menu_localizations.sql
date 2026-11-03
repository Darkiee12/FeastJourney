-- Forward sequence for feat/restaurant-discovery-v2 (Agent J).
--
-- Versioned machine-localization tier for reviewed menus. Curator-approved
-- translations stay authoritative on the item/variant rows themselves
-- (V20261102_012, V20261102_014) and are never written by generation: this
-- table holds machine localizations strictly below them in resolution
-- precedence (approved > machine > original), each row labeled with its
-- provider/model provenance.
--
-- Each row is keyed by the SHA-256 hash of its source content. A source edit
-- changes the hash and retires the row from reads without touching curator
-- data; unchanged text reuses the stored row so no repeated provider call
-- is ever needed. Rejected rows are kept for audit and never served.
-- Only published reviewed rows may seed generation (see
-- menu-localization-sources.sql); private scan material never enters here.
CREATE TABLE feastjourney.restaurant_menu_localizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID NOT NULL REFERENCES feastjourney.restaurant_venues(id) ON DELETE CASCADE,
  item_id UUID NULL REFERENCES feastjourney.restaurant_menu_items(id) ON DELETE CASCADE,
  variant_id UUID NULL REFERENCES feastjourney.restaurant_menu_item_variants(id) ON DELETE CASCADE,
  target TEXT NOT NULL
    CHECK(target IN ('en','vi','ja','zh','ko','fr','es','ms','hi','hinglish')),
  source_hash TEXT NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 300),
  description TEXT NULL CHECK(description IS NULL OR length(description) BETWEEN 1 AND 3000),
  explanation TEXT NULL CHECK(explanation IS NULL OR length(explanation) BETWEEN 1 AND 3000),
  status TEXT NOT NULL DEFAULT 'machine' CHECK(status IN ('machine','approved','rejected')),
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 64),
  model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 128),
  prompt_version TEXT NOT NULL CHECK(length(prompt_version) BETWEEN 1 AND 64),
  schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
  reviewed_by TEXT NULL,
  reviewed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT menu_localization_one_entity CHECK(num_nonnulls(item_id, variant_id) = 1),
  CONSTRAINT menu_localization_review_trail
    CHECK((status = 'machine') = (reviewed_by IS NULL AND reviewed_at IS NULL))
);

-- One localization per entity per target: NULLs never compare equal, so the
-- item and variant shapes each get a partial unique index. Generation
-- upserts arbitrate on these indexes and only refresh rows still in
-- 'machine' status; curator-approved or rejected rows are never overwritten.
CREATE UNIQUE INDEX restaurant_menu_localizations_item_target
  ON feastjourney.restaurant_menu_localizations (item_id, target) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX restaurant_menu_localizations_variant_target
  ON feastjourney.restaurant_menu_localizations (variant_id, target) WHERE item_id IS NULL;
CREATE INDEX restaurant_menu_localizations_venue
  ON feastjourney.restaurant_menu_localizations (venue_id);

-- Monthly provider-usage ledger that bounds generation spend. The
-- application checks these counters before every provider call and refuses
-- to generate past the documented caps (see menu-localizations.ts); the
-- read path always falls back to stored rows or the original menu text.
CREATE TABLE feastjourney.restaurant_menu_localization_usage (
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 64),
  model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 128),
  period TEXT NOT NULL CHECK(period ~ '^[0-9]{4}-[0-9]{2}$'),
  calls INTEGER NOT NULL DEFAULT 0 CHECK(calls >= 0),
  chars INTEGER NOT NULL DEFAULT 0 CHECK(chars >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model, period)
);
