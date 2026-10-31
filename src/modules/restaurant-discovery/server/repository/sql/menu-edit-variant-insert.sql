INSERT INTO feastjourney.restaurant_menu_item_variants(id, venue_id, menu_item_id, name, comparison_key, status, translation_language, translated_label)
VALUES (:id::uuid, :venue::uuid, :item::uuid, :name::text, :comparison::nullable(text), 'draft', :translation_language::nullable(text), :translated_label::nullable(text))
RETURNING id;
