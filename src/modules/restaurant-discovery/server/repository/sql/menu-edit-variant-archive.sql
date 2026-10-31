UPDATE feastjourney.restaurant_menu_item_variants SET status = 'archived'
WHERE id = :id::uuid AND venue_id = :venue::uuid AND status = 'draft'
RETURNING id, menu_item_id;
