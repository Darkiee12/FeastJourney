SELECT COUNT(*)::bigint AS count
FROM feastjourney.restaurant_menu_pages
WHERE venue_id = :venue_id::uuid
  AND status <> 'removed'
