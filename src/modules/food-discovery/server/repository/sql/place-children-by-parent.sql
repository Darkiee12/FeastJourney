SELECT p.id AS id, p.kind AS kind, p.iso3166 AS iso3166,
  p.display_latitude AS "displayLatitude", p.display_longitude AS "displayLongitude",
  p.display_note AS "displayNote"
FROM feastjourney.places AS p
WHERE p.id IN (
  SELECT pp.place_id
  FROM feastjourney.place_parents AS pp
  WHERE pp.parent_place_id = :parent_id::bigint
)
ORDER BY p.id ASC
