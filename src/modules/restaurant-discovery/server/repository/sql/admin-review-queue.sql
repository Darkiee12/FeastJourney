SELECT p.id,'price'::text AS kind,v.name AS venue,i.name AS item,vr.name AS variant,
 p.amount::text AS amount,p.currency,p.price_kind AS detail,p.review_status,p.observed_at,p.review_after,
 p.sales_channel,p.tax_treatment,s.category AS source_category,s.restaurant_verified,
 CASE WHEN s.category='receipt' THEN NULL ELSE s.source_url END AS source_url,
 rl.quantity,rl.explicit_unit_price,rl.line_total,rl.discount,rl.taxes_fees,rl.total_semantics
FROM feastjourney.restaurant_price_observations p
JOIN feastjourney.restaurant_venues v ON v.id=p.venue_id
JOIN feastjourney.restaurant_menu_item_variants vr ON vr.id=p.variant_id
JOIN feastjourney.restaurant_menu_items i ON i.id=vr.menu_item_id
JOIN feastjourney.restaurant_sources s ON s.id=p.source_id
LEFT JOIN feastjourney.restaurant_receipt_lines rl ON rl.observation_id=p.id
WHERE p.review_status='pending'
UNION ALL
SELECT e.id,'serving'::text,v.name,i.name,NULL,NULL,NULL,
 e.match_kind||' · dish '||e.dish_id::text,e.review_status,e.observed_at,e.review_after,NULL,NULL,s.category,s.restaurant_verified,
 CASE WHEN s.category='receipt' THEN NULL ELSE s.source_url END,NULL,NULL,NULL,NULL,NULL,NULL
FROM feastjourney.restaurant_serving_evidence e
JOIN feastjourney.restaurant_venues v ON v.id=e.venue_id
JOIN feastjourney.restaurant_menu_items i ON i.id=e.menu_item_id
JOIN feastjourney.restaurant_sources s ON s.id=e.source_id
WHERE e.review_status='pending'
ORDER BY observed_at DESC,id LIMIT 200;
