SELECT place_id, parent_place_id
FROM feastjourney.place_parents
WHERE place_id = ANY(:ids::bigint[])
ORDER BY place_id ASC, parent_place_id ASC
