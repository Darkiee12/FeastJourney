INSERT INTO feastjourney.cuisine_names
  (cuisine_id, language_tag, name, is_preferred, search_key)
VALUES
  (:cuisine_id::bigint, :language_tag::text, :name::text,
   :is_preferred::boolean, :search_key::text)
RETURNING cuisine_id, language_tag, name, is_preferred, search_key;
