-- Ancestor chain of one place: the place itself plus every parent through
-- place_parents up to the root, nearest first. Used for city discovery
-- fallback (city -> state -> country) and for honest scope labels.
WITH RECURSIVE chain(id, depth) AS (
  SELECT :id::bigint AS id, 0 AS depth
  UNION
  SELECT pp.parent_place_id AS id, chain.depth + 1 AS depth
  FROM feastjourney.place_parents AS pp
  JOIN chain ON chain.id = pp.place_id
)
SELECT p.id AS id, p.kind AS kind, p.iso3166 AS iso3166,
  p.display_latitude AS "displayLatitude", p.display_longitude AS "displayLongitude",
  p.display_note AS "displayNote", chain.depth AS depth
FROM feastjourney.places AS p
JOIN chain ON chain.id = p.id
ORDER BY chain.depth ASC
