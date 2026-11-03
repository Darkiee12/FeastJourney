UPDATE feastjourney.restaurant_menu_items SET status=:status::text WHERE id=:id::uuid RETURNING id;
