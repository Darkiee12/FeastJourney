UPDATE feastjourney.restaurant_menus SET status=:status::text WHERE id=:id::uuid RETURNING id;
