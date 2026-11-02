SELECT COALESCE(MAX(page_order), -1)::integer AS max_page_order
FROM feastjourney.restaurant_menu_pages
WHERE venue_id = :venue_id::uuid
  AND status <> 'removed'
