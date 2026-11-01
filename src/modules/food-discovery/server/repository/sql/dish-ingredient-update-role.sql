UPDATE feastjourney.dish_ingredients
SET role = :role::text
WHERE dish_id = :dish_id::bigint AND ingredient_id = :ingredient_id::bigint
RETURNING dish_id, ingredient_id, role
