DELETE FROM feastjourney.dish_ingredients
WHERE dish_id = :dish_id::bigint AND ingredient_id = :ingredient_id::bigint
RETURNING dish_id
