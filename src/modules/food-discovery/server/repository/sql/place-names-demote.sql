UPDATE feastjourney.place_names
SET is_preferred = FALSE
WHERE place_id = :place_id::bigint AND language_tag = :language_tag::text
