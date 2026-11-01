DELETE FROM feastjourney.dish_names
WHERE id = :id::bigint AND dish_id = :dish_id::bigint
RETURNING id
