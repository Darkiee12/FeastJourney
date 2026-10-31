UPDATE feastjourney.restaurant_menu_items SET status = 'archived'
WHERE id = :id::uuid AND venue_id = :venue::uuid AND status = 'draft'
RETURNING id;
