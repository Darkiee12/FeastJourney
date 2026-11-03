-- Forward sequence for feat/restaurant-discovery-v2.
-- Original PR#6 file: V20261028_102__restaurant_search_names.sql (renumbered after V20261031_001, content unchanged).

-- A trigger maintains the search projection because unaccent is STABLE,
-- so declaring an IMMUTABLE generated-expression wrapper would be misleading.
ALTER TABLE feastjourney.restaurant_venue_names ALTER COLUMN normalized_name DROP EXPRESSION;
UPDATE feastjourney.restaurant_venue_names SET normalized_name=lower(public.unaccent(btrim(name)));
ALTER TABLE feastjourney.restaurant_venue_names ALTER COLUMN normalized_name SET NOT NULL;
CREATE FUNCTION feastjourney.restaurant_normalize_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.normalized_name=lower(public.unaccent(btrim(NEW.name)));
  RETURN NEW;
END $$;
CREATE TRIGGER restaurant_normalize_name BEFORE INSERT OR UPDATE OF name ON feastjourney.restaurant_venue_names
FOR EACH ROW EXECUTE FUNCTION feastjourney.restaurant_normalize_name();
