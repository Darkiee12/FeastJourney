UPDATE feastjourney.place_names
SET is_preferred = TRUE
WHERE id = :id::bigint AND place_id = :place_id::bigint
RETURNING id, place_id, language_tag, name, is_preferred, search_key
