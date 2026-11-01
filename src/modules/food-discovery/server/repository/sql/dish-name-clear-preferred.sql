UPDATE feastjourney.dish_names
SET is_preferred = false
WHERE dish_id = :dish_id::bigint
  AND language_tag = :language_tag::text
  AND id <> :excluded_id::bigint
RETURNING id
