UPDATE feastjourney.dish_names
SET language_tag = :language_tag::text,
  name = :name::text,
  name_kind = :name_kind::text,
  is_preferred = :is_preferred::boolean,
  search_key = :search_key::text
WHERE id = :id::bigint AND dish_id = :dish_id::bigint
RETURNING id, dish_id, language_tag, name, name_kind, is_preferred, search_key
