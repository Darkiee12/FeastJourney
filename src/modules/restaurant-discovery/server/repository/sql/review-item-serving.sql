SELECT e.id,'serving'::text AS kind,v.id AS venue_id,v.name AS venue,v.status AS venue_status,
 v.address AS venue_address,v.area AS venue_area,i.id AS item_id,i.name AS item,
 e.dish_id::text AS dish_id,e.match_kind AS detail,e.review_status,e.observed_at,e.review_after,
 s.id AS source_id,s.category AS source_category,s.restaurant_verified,
 CASE WHEN s.category='receipt' THEN NULL ELSE s.source_url END AS source_url,
 s.private_object_key IS NOT NULL AS has_private_evidence,
 s.observed_at AS source_observed_at,s.valid_until AS source_valid_until,
 e.reviewed_by,e.reviewed_at
FROM feastjourney.restaurant_serving_evidence e
JOIN feastjourney.restaurant_venues v ON v.id=e.venue_id
JOIN feastjourney.restaurant_menu_items i ON i.id=e.menu_item_id
JOIN feastjourney.restaurant_sources s ON s.id=e.source_id
WHERE e.id=:id::uuid;
