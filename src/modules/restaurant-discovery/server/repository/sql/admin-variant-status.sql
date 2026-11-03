UPDATE feastjourney.restaurant_menu_item_variants SET status=:status::text WHERE id=:id::uuid RETURNING id;
