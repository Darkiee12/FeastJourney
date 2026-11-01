DELETE FROM feastjourney.dish_descriptions
WHERE dish_id = :dish_id::bigint AND language_tag = :language_tag::text
RETURNING dish_id
