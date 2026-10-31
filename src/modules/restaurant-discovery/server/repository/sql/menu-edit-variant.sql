SELECT id, menu_item_id, status FROM feastjourney.restaurant_menu_item_variants WHERE id = :id::uuid AND venue_id = :venue::uuid;
