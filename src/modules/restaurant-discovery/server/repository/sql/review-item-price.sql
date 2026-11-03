SELECT p.id,'price'::text AS kind,v.id AS venue_id,v.name AS venue,v.status AS venue_status,
 v.address AS venue_address,v.area AS venue_area,i.id AS item_id,i.name AS item,vr.id AS variant_id,vr.name AS variant,
 p.amount::text AS amount,p.currency,p.price_kind AS detail,p.review_status,p.observed_at,p.review_after,
 p.sales_channel,p.tax_treatment,s.id AS source_id,s.category AS source_category,s.restaurant_verified,
 CASE WHEN s.category='receipt' THEN NULL ELSE s.source_url END AS source_url,
 s.private_object_key IS NOT NULL AS has_private_evidence,
 s.observed_at AS source_observed_at,s.valid_until AS source_valid_until,
 rl.quantity::text AS receipt_quantity,rl.explicit_unit_price::text AS receipt_unit,
 rl.line_total::text AS receipt_total,rl.discount::text AS receipt_discount,
 rl.taxes_fees::text AS receipt_fees,rl.total_semantics AS receipt_semantics,
 p.reviewed_by,p.reviewed_at
FROM feastjourney.restaurant_price_observations p
JOIN feastjourney.restaurant_venues v ON v.id=p.venue_id
JOIN feastjourney.restaurant_menu_item_variants vr ON vr.id=p.variant_id
JOIN feastjourney.restaurant_menu_items i ON i.id=vr.menu_item_id
JOIN feastjourney.restaurant_sources s ON s.id=p.source_id
LEFT JOIN feastjourney.restaurant_receipt_lines rl ON rl.observation_id=p.id
WHERE p.id=:id::uuid;
