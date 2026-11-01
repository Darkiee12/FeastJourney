-- Nearest city-scale place (locality, province, or subnational) with
-- coordinates to a visitor fix, for the honest near-you status line.
-- Country, region, and continent centroids NEVER count (kind filter): only
-- city-scale placements do, so a distant capital centroid cannot pose as
-- the visitor's city. The max-distance gate keeps far-away fixes honest:
-- beyond it the query returns no row and the client keeps the plain
-- "Near you" wording instead of naming a city hundreds of kilometers away.
--
-- Cost note: display_latitude/longitude are plain float columns (no
-- geometry column exists), so this is a sequential scan with an
-- ST_DWithin geography predicate, exactly like the nearby carousel
-- queries. The places table holds dozens of rows; revisit if it grows
-- past easy sequential-scan size.
WITH input AS (
  SELECT :latitude::float8 AS lat,
    :longitude::float8 AS lon,
    :max_distance_m::int AS radius_m
)
SELECT p.id AS id,
  ST_Distance(
    ST_MakePoint(input.lon, input.lat)::geography,
    ST_MakePoint(p.display_longitude, p.display_latitude)::geography
  ) AS "distanceM"
FROM feastjourney.places AS p, input
WHERE p.kind IN ('locality', 'province', 'subnational')
  AND p.display_latitude IS NOT NULL
  AND p.display_longitude IS NOT NULL
  AND ST_DWithin(
    ST_MakePoint(input.lon, input.lat)::geography,
    ST_MakePoint(p.display_longitude, p.display_latitude)::geography,
    input.radius_m
  )
ORDER BY "distanceM" ASC
LIMIT 1
