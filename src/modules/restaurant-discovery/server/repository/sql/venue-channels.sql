SELECT DISTINCT p.sales_channel AS sales_channel
FROM feastjourney.restaurant_selected_prices p
JOIN feastjourney.restaurant_menu_item_variants v ON v.id=p.variant_id
JOIN feastjourney.restaurant_menu_items i ON(i.id,i.venue_id)=(v.menu_item_id,v.venue_id)
JOIN feastjourney.restaurant_menus m ON(m.id,m.venue_id)=(i.menu_id,i.venue_id)
WHERE p.venue_id=:id::uuid AND p.price_kind='listed' AND p.current_enough
 AND v.status='published' AND i.status='published' AND m.status='published'
ORDER BY p.sales_channel;
