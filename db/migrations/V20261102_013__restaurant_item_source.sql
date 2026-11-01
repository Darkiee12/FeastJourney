-- Forward sequence for feat/restaurant-discovery-v2.
-- Original PR#6 file: V20261030_101__restaurant_item_source.sql (renumbered after V20261031_001, content unchanged).

-- Price-free offerings need direct source provenance. Legacy unknowns stay unknown.
ALTER TABLE feastjourney.restaurant_menu_items ADD COLUMN source_id UUID;
ALTER TABLE feastjourney.restaurant_menu_items ADD CONSTRAINT restaurant_item_source_venue_fk
 FOREIGN KEY(source_id,venue_id) REFERENCES feastjourney.restaurant_sources(id,venue_id) DEFERRABLE INITIALLY DEFERRED;
