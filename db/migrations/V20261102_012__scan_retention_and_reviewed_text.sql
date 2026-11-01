-- Forward sequence for feat/restaurant-discovery-v2.
-- Original PR#6 file: V20261030_100__scan_retention_and_reviewed_text.sql (renumbered after V20261031_001, content unchanged).

-- Scanner migration range starts at 100 to avoid stacked Food Discovery migrations.
-- Keep the exact submitted revision number after private draft erasure.
ALTER TABLE feastjourney.menu_scan_contributions ADD COLUMN submitted_revision INTEGER;
UPDATE feastjourney.menu_scan_contributions SET submitted_revision=revision;
ALTER TABLE feastjourney.menu_scan_contributions ALTER COLUMN submitted_revision SET NOT NULL;
ALTER TABLE feastjourney.menu_scan_contributions ADD CONSTRAINT menu_submission_revision_positive CHECK(submitted_revision>0);
ALTER TABLE feastjourney.menu_scan_contributions ADD CONSTRAINT menu_submission_revision_matches CHECK(revision IS NULL OR revision=submitted_revision);
ALTER TABLE feastjourney.menu_scan_contributions DROP CONSTRAINT menu_scan_contributions_session_id_revision_fkey;
ALTER TABLE feastjourney.menu_scan_contributions ALTER COLUMN revision DROP NOT NULL;
ALTER TABLE feastjourney.menu_scan_contributions ADD CONSTRAINT menu_contribution_revision_fk
 FOREIGN KEY(session_id,revision) REFERENCES feastjourney.menu_scan_revisions(session_id,revision) ON DELETE SET NULL (revision);
ALTER TABLE feastjourney.menu_scan_contributions ADD CONSTRAINT menu_submission_once UNIQUE(session_id,submitted_revision);

-- Evidence stays in the original registered asset lifecycle; never make an untracked copy.
ALTER TABLE feastjourney.menu_scan_contribution_menus DROP CONSTRAINT menu_scan_contribution_menus_evidence_key_check;
ALTER TABLE feastjourney.menu_scan_contribution_menus ADD CONSTRAINT menu_evidence_key_shape
 CHECK(evidence_key ~ '^(evidence|menu)/[0-9a-f-]{36}/[0-9a-f-]{36}$');
ALTER TABLE feastjourney.menu_scan_assets ADD COLUMN next_delete_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE feastjourney.menu_scan_contribution_menus ADD COLUMN supporting_asset_ids UUID[] NOT NULL DEFAULT '{}';

-- One reviewed translation per immutable offering, tied to its creation and source.
-- No second published JSON menu or separate translation cache is introduced.
ALTER TABLE feastjourney.restaurant_menus ADD COLUMN source_language TEXT
 CHECK(source_language IS NULL OR source_language IN ('en','vi','ja','zh','ko','fr','es'));
ALTER TABLE feastjourney.restaurant_menu_items
 ADD COLUMN translation_language TEXT CHECK(translation_language IS NULL OR translation_language IN ('en','vi','ja','zh','ko','fr','es')),
 ADD COLUMN translated_name TEXT CHECK(length(translated_name) BETWEEN 1 AND 300),
 ADD COLUMN translated_description TEXT CHECK(length(translated_description) BETWEEN 1 AND 3000),
 ADD COLUMN explanatory_summary TEXT CHECK(length(explanatory_summary) BETWEEN 1 AND 3000);
ALTER TABLE feastjourney.restaurant_menu_items ADD CONSTRAINT menu_translation_language_required
 CHECK(translation_language IS NOT NULL OR (translated_name IS NULL AND translated_description IS NULL AND explanatory_summary IS NULL));

-- Unreviewed new variants must not leak through a previously published item.
ALTER TABLE feastjourney.restaurant_menu_item_variants DROP CONSTRAINT restaurant_menu_item_variants_status_check;
ALTER TABLE feastjourney.restaurant_menu_item_variants ADD CONSTRAINT restaurant_variant_status
 CHECK(status IN ('draft','published','archived'));
