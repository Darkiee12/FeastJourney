INSERT INTO feastjourney.restaurant_menus(id,venue_id,name,source_language) VALUES(:id::uuid,:venue::uuid,:name::text,:source_language::nullable(text))
ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name WHERE feastjourney.restaurant_menus.venue_id=EXCLUDED.venue_id RETURNING id;
