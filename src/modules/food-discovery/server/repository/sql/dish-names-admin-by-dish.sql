SELECT id, dish_id, language_tag, name, name_kind, is_preferred, search_key
FROM feastjourney.dish_names
WHERE dish_id = ANY(:ids::bigint[])
ORDER BY dish_id ASC, language_tag ASC, name ASC
