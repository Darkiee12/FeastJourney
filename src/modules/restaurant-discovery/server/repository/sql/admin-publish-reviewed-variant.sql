WITH input AS (SELECT :id::uuid AS id,:kind::text AS kind)
UPDATE feastjourney.restaurant_menu_item_variants v SET status='published'
WHERE v.status='draft' AND (
 EXISTS(SELECT 1 FROM feastjourney.restaurant_price_observations p CROSS JOIN input f
 WHERE f.kind='price' AND p.id=f.id AND p.review_status='approved' AND p.variant_id=v.id AND p.venue_id=v.venue_id)
 OR EXISTS(SELECT 1 FROM feastjourney.restaurant_serving_evidence e CROSS JOIN input f
 WHERE f.kind='serving' AND e.id=f.id AND e.review_status='approved' AND e.menu_item_id=v.menu_item_id AND e.venue_id=v.venue_id)
);
