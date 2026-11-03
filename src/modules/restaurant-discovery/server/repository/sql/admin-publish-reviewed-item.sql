WITH input AS (SELECT :id::uuid AS id, :kind::text AS kind)
UPDATE feastjourney.restaurant_menu_items i SET status='published'
WHERE i.status='draft' AND (
 EXISTS (
  SELECT 1 FROM feastjourney.restaurant_price_observations p
  JOIN feastjourney.restaurant_menu_item_variants v ON v.id=p.variant_id CROSS JOIN input f
  WHERE f.kind='price' AND p.id=f.id AND p.review_status='approved'
    AND v.menu_item_id=i.id AND p.venue_id=i.venue_id
 ) OR EXISTS (
  SELECT 1 FROM feastjourney.restaurant_serving_evidence e CROSS JOIN input f
  WHERE f.kind='serving' AND e.id=f.id AND e.review_status='approved'
    AND e.menu_item_id=i.id AND e.venue_id=i.venue_id
 ));
