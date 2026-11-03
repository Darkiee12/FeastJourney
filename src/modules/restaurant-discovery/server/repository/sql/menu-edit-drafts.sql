SELECT i.id AS item_id, i.name AS item_name, i.description AS item_description, i.status AS item_status,
  i.section_key, v.id AS variant_id, v.name AS variant_name, v.comparison_key, v.status AS variant_status,
  p.id AS price_id, p.amount::text AS amount, p.currency, p.price_kind, p.sales_channel, p.tax_treatment,
  p.review_status AS price_review, e.id AS evidence_id, e.match_kind, e.review_status AS evidence_review,
  e.dish_id::text AS dish_id
FROM feastjourney.restaurant_menu_items i
LEFT JOIN feastjourney.restaurant_menu_item_variants v ON v.menu_item_id = i.id AND v.venue_id = i.venue_id
LEFT JOIN feastjourney.restaurant_price_observations p ON p.variant_id = v.id AND p.venue_id = i.venue_id
LEFT JOIN feastjourney.restaurant_serving_evidence e ON e.menu_item_id = i.id AND e.venue_id = i.venue_id
WHERE i.menu_id = :menu::uuid AND i.venue_id = :venue::uuid
ORDER BY i.name, i.id, v.name, v.id;
