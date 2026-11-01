DELETE FROM feastjourney.dish_cuisines
WHERE dish_id = :dish_id::bigint AND cuisine_id = :cuisine_id::bigint
RETURNING dish_id
