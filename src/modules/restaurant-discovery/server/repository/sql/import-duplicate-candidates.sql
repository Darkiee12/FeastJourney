-- Fuzzy duplicate candidates: trigram-similar names within 50 metres go
-- to curator review. The wizard never auto-merges on these rows; a curator
-- approves (new draft venue) or confirms the duplicate explicitly.
-- Geography filters first (GiST-indexed, tiny result), then trigram
-- similarity runs over the venue name plus every search name, so candidate
-- quality never depends on which name table a row lives in.
-- (Reylo binds each parameter once, so inputs ride a single WITH row.)
WITH input AS (
  SELECT :name::text AS name,
    :longitude::float8 AS longitude,
    :latitude::float8 AS latitude,
    :threshold::float8 AS threshold
),
nearby AS (
  SELECT v.id AS venue_id, v.name AS venue_name, v.address AS venue_address,
    public.ST_Distance(
      v.location,
      public.ST_SetSRID(public.ST_MakePoint(input.longitude, input.latitude), 4326)::public.geography
    ) AS distance_m
  FROM feastjourney.restaurant_venues v
  CROSS JOIN input
  WHERE public.ST_DWithin(
    v.location,
    public.ST_SetSRID(public.ST_MakePoint(input.longitude, input.latitude), 4326)::public.geography,
    50
  )
),
labels AS (
  SELECT venue_id, lower(btrim(venue_name)) AS label FROM nearby
  UNION
  SELECT n.venue_id, n.normalized_name AS label
  FROM feastjourney.restaurant_venue_names n
  WHERE n.venue_id IN (SELECT venue_id FROM nearby)
)
SELECT nearby.venue_id AS venue_id, nearby.venue_name AS venue_name,
  nearby.venue_address AS venue_address,
  max(similarity(labels.label, lower(btrim(input.name)))) AS similarity,
  nearby.distance_m AS distance_m
FROM nearby
JOIN labels ON labels.venue_id = nearby.venue_id
CROSS JOIN input
GROUP BY nearby.venue_id, nearby.venue_name, nearby.venue_address, nearby.distance_m, input.name
HAVING max(similarity(labels.label, lower(btrim(input.name)))) >= (SELECT threshold FROM input)
ORDER BY similarity DESC, distance_m ASC
LIMIT 5
