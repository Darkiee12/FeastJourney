UPDATE feastjourney.place_names
SET language_tag = :language_tag::text,
  name = :name::text,
  is_preferred = :is_preferred::boolean,
  search_key = :search_key::text
WHERE id = :id::bigint AND place_id = :place_id::bigint
RETURNING id, place_id, language_tag, name, is_preferred, search_key
