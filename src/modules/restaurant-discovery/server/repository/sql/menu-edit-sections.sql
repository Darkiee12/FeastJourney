SELECT id, section_key FROM feastjourney.restaurant_menu_items
WHERE menu_id = :menu::uuid AND venue_id = :venue::uuid;
