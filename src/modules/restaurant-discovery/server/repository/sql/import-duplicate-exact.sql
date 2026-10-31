-- Exact normalized name + address match: the row is an existing venue and
-- auto-skips. The venue's own name column is authoritative; the search
-- names table is consulted as a second source. No fuzzy logic here, no
-- merge, no update of the venue.
-- (Reylo binds each parameter once, so inputs ride a single WITH row.)
WITH input AS (SELECT :name::text AS name, :address::text AS address)
SELECT v.id AS venue_id, v.name AS venue_name, v.address AS venue_address
FROM feastjourney.restaurant_venues v, input
WHERE lower(btrim(v.address)) = lower(btrim(input.address))
AND (
  lower(btrim(v.name)) = lower(btrim(input.name))
  OR EXISTS (
    SELECT 1 FROM feastjourney.restaurant_venue_names n
    WHERE n.venue_id = v.id
      AND n.normalized_name = lower(btrim(input.name))
  )
)
LIMIT 1
