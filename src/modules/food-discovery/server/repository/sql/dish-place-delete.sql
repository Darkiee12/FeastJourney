DELETE FROM feastjourney.dish_places
WHERE dish_id = :dish_id::bigint AND place_id = :place_id::bigint
RETURNING dish_id
