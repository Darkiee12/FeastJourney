INSERT INTO feastjourney.restaurant_menus(id, venue_id, name, status, source_language)
VALUES (:id::uuid, :venue::uuid, :name::text, 'draft', :source_language::nullable(text))
RETURNING id;
