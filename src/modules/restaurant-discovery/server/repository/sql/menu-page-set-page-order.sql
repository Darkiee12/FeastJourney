UPDATE feastjourney.restaurant_menu_pages
SET page_order = :page_order::integer,
  updated_at = now()
WHERE id = :id::uuid
  AND status <> 'removed'
