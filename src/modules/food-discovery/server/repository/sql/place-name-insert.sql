INSERT INTO feastjourney.place_names (place_id, language_tag, name, is_preferred, search_key)
VALUES (:place_id::bigint, :language_tag::text, :name::text, :is_preferred::boolean, :search_key::text)
RETURNING id, place_id, language_tag, name, is_preferred, search_key
