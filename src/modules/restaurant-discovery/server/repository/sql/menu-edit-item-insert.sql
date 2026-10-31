INSERT INTO feastjourney.restaurant_menu_items(id, venue_id, menu_id, name, description, status, section_key, translation_language, translated_name, translated_description, explanatory_summary, source_id)
VALUES (:id::uuid, :venue::uuid, :menu::uuid, :name::text, :description::text, 'draft', :section::nullable(text), :translation_language::nullable(text), :translated_name::nullable(text), :translated_description::nullable(text), :explanation::nullable(text), :source::nullable(uuid))
RETURNING id;
