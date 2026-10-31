WITH input AS (SELECT :venue::text AS venue,:kind::text AS kind,:status::text AS status,
 :from::nullable(timestamptz) AS from_date,:to::nullable(timestamptz) AS to_date),
queue AS (
 SELECT p.id,'price'::text AS kind,v.name AS venue,i.name AS item,vr.name AS variant,
  p.amount::text AS amount,p.currency,p.price_kind AS detail,p.review_status,p.observed_at,p.review_after,
  p.sales_channel,p.tax_treatment,s.category AS source_category,s.restaurant_verified,
  CASE WHEN s.category='receipt' THEN NULL ELSE s.source_url END AS source_url,
  rl.quantity::text AS receipt_quantity,rl.explicit_unit_price::text AS receipt_unit,
  rl.line_total::text AS receipt_total,rl.discount::text AS receipt_discount,
  rl.taxes_fees::text AS receipt_fees,rl.total_semantics AS receipt_semantics,
  p.reviewed_by,p.reviewed_at,v.area AS venue_area,v.address AS venue_address
 FROM feastjourney.restaurant_price_observations p
 JOIN feastjourney.restaurant_venues v ON v.id=p.venue_id
 JOIN feastjourney.restaurant_menu_item_variants vr ON vr.id=p.variant_id
 JOIN feastjourney.restaurant_menu_items i ON i.id=vr.menu_item_id
 JOIN feastjourney.restaurant_sources s ON s.id=p.source_id
 LEFT JOIN feastjourney.restaurant_receipt_lines rl ON rl.observation_id=p.id
 UNION ALL
 SELECT e.id,'serving'::text,v.name,i.name,NULL,NULL,NULL,
  e.match_kind||' · dish '||e.dish_id::text,e.review_status,e.observed_at,e.review_after,
  NULL,NULL,s.category,s.restaurant_verified,
  CASE WHEN s.category='receipt' THEN NULL ELSE s.source_url END,
  NULL,NULL,NULL,NULL,NULL,NULL,
  e.reviewed_by,e.reviewed_at,v.area,v.address
 FROM feastjourney.restaurant_serving_evidence e
 JOIN feastjourney.restaurant_venues v ON v.id=e.venue_id
 JOIN feastjourney.restaurant_menu_items i ON i.id=e.menu_item_id
 JOIN feastjourney.restaurant_sources s ON s.id=e.source_id
)
SELECT q.id,q.kind,q.venue,q.item,q.variant,q.amount,q.currency,q.detail,
 q.review_status,q.observed_at,q.review_after,q.sales_channel,q.tax_treatment,
 q.source_category,q.restaurant_verified,q.source_url,
 q.receipt_quantity,q.receipt_unit,q.receipt_total,q.receipt_discount,q.receipt_fees,q.receipt_semantics,
 q.reviewed_by,q.reviewed_at,count(*) OVER()::int AS total
FROM queue q CROSS JOIN input f
WHERE (f.venue='' OR strpos(lower(q.venue||' '||q.venue_area||' '||q.venue_address),lower(f.venue))>0)
 AND (f.kind='all' OR q.kind=f.kind)
 AND (f.status='all' OR q.review_status=f.status)
 AND (f.from_date IS NULL OR q.observed_at>=f.from_date)
 AND (f.to_date IS NULL OR q.observed_at<=f.to_date)
ORDER BY CASE WHEN q.review_status='pending' THEN 0 ELSE 1 END,q.observed_at DESC,q.id
LIMIT :limit::int OFFSET :offset::int;
