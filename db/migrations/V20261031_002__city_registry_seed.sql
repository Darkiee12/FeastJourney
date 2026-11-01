-- FeastJourney city-level place registry: Karnataka/Bengaluru (IN), Hanoi/Ho Chi Minh City (VN).
--
-- Registers the first city-level canonical places so curators can attach
-- city-scoped `associated`/`popular` links through `place:<id>` CSV entries:
-- India → Karnataka (province, IN-KA) → Bengaluru (locality), and
-- Vietnam → Hanoi + Ho Chi Minh City (localities). Display coordinates are
-- cartographic placements, never origin claims and never restaurant
-- locations.
--
-- Deliberate non-goals (no fabricated geography, no invented dish links):
-- - Bengaluru/Hanoi/Ho Chi Minh City carry the spec placement; Karnataka has
--   no cartographic placement yet (NULL + note), like the country registry.
-- - Hanoi was seeded by V20261028_002 (21.0278/105.8342); it is reused and
--   converged on the canonical placement, never duplicated.
-- - Existing country rows (IN, VN) are looked up by ISO and reused; no new
--   country rows are inserted here.
-- - No dish_places rows: this migration seeds places only, never
--   dish-city associations.
--
-- Idempotent: every INSERT is guarded by WHERE NOT EXISTS / ON CONFLICT,
-- the Hanoi coordinate convergence only touches differing rows, and parent
-- edges use ON CONFLICT DO NOTHING.

SET search_path TO feastjourney, public;

-- 1. Karnataka province (ISO 3166-2 IN-KA); no cartographic placement yet.
INSERT INTO feastjourney.places (kind, iso3166, display_latitude, display_longitude, display_note)
SELECT 'province', 'IN-KA', NULL, NULL,
  'ISO 3166-2 subdivision; no cartographic placement yet. Coordinates on this table are display-only map placements, never origin claims or restaurant locations.'
WHERE NOT EXISTS (SELECT 1 FROM feastjourney.places AS e WHERE e.iso3166 = 'IN-KA');

-- 2. City localities. Hanoi is skipped when the V20261028_002 seed row
-- exists (matched by preferred English name); the UPDATE below converges
-- that row on the canonical placement.
INSERT INTO feastjourney.places (kind, iso3166, display_latitude, display_longitude, display_note)
SELECT v.kind, NULL, v.lat, v.lon,
  v.name || ' city placement; display-only map placement, never an origin claim or restaurant location.'
FROM (VALUES
  ('locality', 'Bengaluru', 12.9716, 77.5946),
  ('locality', 'Hanoi', 21.0285, 105.8542),
  ('locality', 'Ho Chi Minh City', 10.8231, 106.6297)
) AS v(kind, name, lat, lon)
WHERE NOT EXISTS (
  SELECT 1 FROM feastjourney.place_names AS e
  JOIN feastjourney.places AS p ON p.id = e.place_id
  WHERE e.language_tag = 'en' AND e.name = v.name AND e.is_preferred AND p.kind = 'locality'
);

-- Converge a pre-existing Hanoi seed row on the canonical placement.
UPDATE feastjourney.places AS p
SET display_latitude = 21.0285,
    display_longitude = 105.8542,
    display_note = 'Hanoi city placement; display-only map placement, never an origin claim or restaurant location.'
FROM feastjourney.place_names AS pn
WHERE pn.place_id = p.id
  AND pn.language_tag = 'en' AND pn.name = 'Hanoi' AND pn.is_preferred
  AND p.kind = 'locality'
  AND (p.display_latitude IS DISTINCT FROM 21.0285 OR p.display_longitude IS DISTINCT FROM 105.8542);

-- 3. Preferred English names for the new rows (Hanoi keeps its seed name).
INSERT INTO feastjourney.place_names (place_id, language_tag, name, is_preferred, search_key)
SELECT p.id, 'en', n.name, TRUE, lower(public.unaccent(n.name))
FROM feastjourney.places AS p
JOIN (VALUES
  ('province', CAST(NULL AS DOUBLE PRECISION), CAST(NULL AS DOUBLE PRECISION), 'IN-KA', 'Karnataka'),
  ('locality', 12.9716, 77.5946, NULL, 'Bengaluru'),
  ('locality', 21.0285, 105.8542, NULL, 'Hanoi'),
  ('locality', 10.8231, 106.6297, NULL, 'Ho Chi Minh City')
) AS n(kind, lat, lon, iso, name)
  ON (
    (n.iso IS NOT NULL AND p.iso3166 = n.iso)
    OR (n.iso IS NULL AND p.kind = n.kind
        AND p.display_latitude = n.lat AND p.display_longitude = n.lon)
  )
WHERE NOT EXISTS (
  SELECT 1 FROM feastjourney.place_names AS e
  WHERE e.place_id = p.id AND e.language_tag = 'en' AND e.name = n.name
);

-- 4. "Bangalore" alias (non-preferred) so recall covers the former name.
-- Resolved through the preferred name, not coordinates.
INSERT INTO feastjourney.place_names (place_id, language_tag, name, is_preferred, search_key)
SELECT pn.place_id, 'en', 'Bangalore', FALSE, lower(public.unaccent('Bangalore'))
FROM feastjourney.place_names AS pn
JOIN feastjourney.places AS p ON p.id = pn.place_id
WHERE pn.language_tag = 'en' AND pn.name = 'Bengaluru' AND pn.is_preferred
  AND p.kind = 'locality'
  AND NOT EXISTS (
    SELECT 1 FROM feastjourney.place_names AS e
    WHERE e.place_id = pn.place_id AND e.language_tag = 'en' AND e.name = 'Bangalore'
  );

-- 5. Vietnamese preferred labels for the seeded places.
INSERT INTO feastjourney.place_names (place_id, language_tag, name, is_preferred, search_key)
SELECT p.id, 'vi', v.name, TRUE, lower(public.unaccent(v.name))
FROM (VALUES
  ('Karnataka', 'Karnataka'),
  ('Bengaluru', 'Bengaluru'),
  ('Hanoi', 'Hà Nội'),
  ('Ho Chi Minh City', 'Thành phố Hồ Chí Minh')
) AS v(en_name, name)
JOIN feastjourney.place_names AS en
  ON en.name = v.en_name AND en.is_preferred AND en.language_tag = 'en'
JOIN feastjourney.places AS p
  ON p.id = en.place_id AND p.kind IN ('province', 'locality')
WHERE NOT EXISTS (
  SELECT 1 FROM feastjourney.place_names AS e
  WHERE e.place_id = p.id AND e.language_tag = 'vi' AND e.name = v.name
);

-- 6. Hierarchy edges: Karnataka -> India; cities -> their state/country.
-- (Hanoi -> Vietnam already exists from V20261028_002; kept by conflict guard.)
INSERT INTO feastjourney.place_parents (place_id, parent_place_id)
SELECT child.id, parent.id
FROM (VALUES ('IN-KA', 'IN')) AS m(child_iso, parent_iso)
JOIN feastjourney.places AS child ON child.iso3166 = m.child_iso
JOIN feastjourney.places AS parent ON parent.iso3166 = m.parent_iso
ON CONFLICT DO NOTHING;

INSERT INTO feastjourney.place_parents (place_id, parent_place_id)
SELECT child.id, parent.id
FROM (VALUES
  ('Bengaluru', 'IN-KA'),
  ('Hanoi', 'VN'),
  ('Ho Chi Minh City', 'VN')
) AS m(city_en, parent_iso)
JOIN feastjourney.place_names AS cpn
  ON cpn.name = m.city_en AND cpn.is_preferred AND cpn.language_tag = 'en'
JOIN feastjourney.places AS child ON child.id = cpn.place_id AND child.kind = 'locality'
JOIN feastjourney.places AS parent ON parent.iso3166 = m.parent_iso
ON CONFLICT DO NOTHING;
