SELECT DISTINCT v.comparison_key FROM feastjourney.restaurant_menu_item_variants v
JOIN feastjourney.restaurant_menu_items i ON i.id=v.menu_item_id
JOIN feastjourney.restaurant_menus m ON m.id=i.menu_id
JOIN feastjourney.restaurant_venues r ON r.id=i.venue_id
JOIN feastjourney.restaurant_eligible_evidence e ON e.menu_item_id=i.id
WHERE v.status='published' AND e.dish_id=:dish::bigint AND v.comparison_key IS NOT NULL
 AND r.status='published' AND i.status='published' AND m.status='published'
ORDER BY v.comparison_key;
