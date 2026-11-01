SELECT dp.dish_id AS dish_id, dp.place_id AS place_id, dp.association AS association,
  dp.is_disputed AS is_disputed, dp.note AS note, p.kind AS kind, p.iso3166 AS iso3166,
  p.display_latitude AS display_latitude, p.display_longitude AS display_longitude
FROM feastjourney.dish_places AS dp
JOIN feastjourney.places AS p ON p.id = dp.place_id
WHERE dp.dish_id = ANY(:ids::bigint[])
ORDER BY dp.dish_id ASC, dp.place_id ASC
