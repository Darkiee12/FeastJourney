SELECT id, place_id, language_tag, name, is_preferred, search_key
FROM feastjourney.place_names
WHERE place_id = ANY(:ids::bigint[])
ORDER BY place_id ASC, language_tag ASC, name ASC
