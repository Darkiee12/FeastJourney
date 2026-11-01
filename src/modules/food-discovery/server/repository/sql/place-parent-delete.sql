DELETE FROM feastjourney.place_parents
WHERE place_id = :place_id::bigint AND parent_place_id = :parent_place_id::bigint
RETURNING place_id
