DELETE FROM feastjourney.dish_categories
WHERE dish_id = :dish_id::bigint AND category_id = :category_id::bigint
RETURNING dish_id
