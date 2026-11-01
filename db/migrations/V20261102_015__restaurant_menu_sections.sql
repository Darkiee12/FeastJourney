-- Curator menu arrangement for the visual menu editor.
--
-- Decision (persistence inspection): restaurant_menus links items directly;
-- no section or position storage exists and the consumer menu query orders by
-- menu/item/variant name. Presentation-only grouping would lose the curator's
-- arrangement on reload, breaking saved drafts, so a minimal nullable
-- item-level section key is justified. No backfill: NULL renders unsectioned
-- in legacy name order. No renames. Within-section order stays name-ordered;
-- sections group only. A separate section table (identity/ordering/FK
-- machinery for one nullable label) was rejected. Reassigning a section key
-- is arrangement metadata, never a serving or price observation, and travels
-- through its own audited manage-gated operation.
ALTER TABLE feastjourney.restaurant_menu_items ADD COLUMN section_key TEXT
  CHECK (section_key IS NULL OR section_key ~ '^[a-z0-9][a-z0-9-]{0,79}$');
CREATE INDEX restaurant_menu_items_section_idx
  ON feastjourney.restaurant_menu_items(menu_id, section_key, name)
  WHERE section_key IS NOT NULL;
