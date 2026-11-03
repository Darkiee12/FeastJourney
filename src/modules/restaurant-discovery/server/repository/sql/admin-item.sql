INSERT INTO feastjourney.restaurant_menu_items(id,venue_id,menu_id,name,description,status,translation_language,translated_name,translated_description,explanatory_summary,source_id)
VALUES(:id::uuid,:venue::uuid,:menu::uuid,:name::text,:description::text,'draft',:translation_language::nullable(text),:translated_name::nullable(text),:translated_description::nullable(text),:explanation::nullable(text),:source::uuid)
ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id
WHERE feastjourney.restaurant_menu_items.venue_id=EXCLUDED.venue_id
 AND feastjourney.restaurant_menu_items.menu_id=EXCLUDED.menu_id
 AND feastjourney.restaurant_menu_items.name=EXCLUDED.name
 AND feastjourney.restaurant_menu_items.description=EXCLUDED.description
 AND feastjourney.restaurant_menu_items.translation_language IS NOT DISTINCT FROM EXCLUDED.translation_language
 AND feastjourney.restaurant_menu_items.translated_name IS NOT DISTINCT FROM EXCLUDED.translated_name
 AND feastjourney.restaurant_menu_items.translated_description IS NOT DISTINCT FROM EXCLUDED.translated_description
 AND feastjourney.restaurant_menu_items.explanatory_summary IS NOT DISTINCT FROM EXCLUDED.explanatory_summary
RETURNING id;
