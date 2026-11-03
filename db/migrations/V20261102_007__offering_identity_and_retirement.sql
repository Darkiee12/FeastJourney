-- Forward sequence for feat/restaurant-discovery-v2.
-- Original PR#6 file: V20261028_105__offering_identity_and_retirement.sql (renumbered after V20261031_001, content unchanged).

ALTER TABLE feastjourney.restaurant_menu_item_variants
 ADD COLUMN status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published','archived'));

CREATE FUNCTION feastjourney.restaurant_item_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN
  RAISE EXCEPTION 'Create a new menu item when its identity changes' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER restaurant_item_identity_immutable BEFORE UPDATE ON feastjourney.restaurant_menu_items
FOR EACH ROW EXECUTE FUNCTION feastjourney.restaurant_item_identity_immutable();

CREATE FUNCTION feastjourney.restaurant_variant_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN
  RAISE EXCEPTION 'Create a new variant when its portion or identity changes' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER restaurant_variant_identity_immutable BEFORE UPDATE ON feastjourney.restaurant_menu_item_variants
FOR EACH ROW EXECUTE FUNCTION feastjourney.restaurant_variant_identity_immutable();
