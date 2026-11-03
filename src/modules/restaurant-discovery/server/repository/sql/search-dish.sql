WITH input AS(SELECT :area::text AS area,:cuisine::text AS cuisine,
 :longitude::nullable(float8) AS longitude,:latitude::nullable(float8) AS latitude,:radius::float8 AS radius,
 :west::nullable(float8) AS west,:south::nullable(float8) AS south,:east::nullable(float8) AS east,:north::nullable(float8) AS north),
venues AS(SELECT r.id,r.business_id,r.name,r.address,r.area,r.country_code,r.location,
 r.longitude AS longitude,r.latitude AS latitude,
 CASE WHEN f.longitude IS NULL THEN NULL ELSE public.ST_Distance(r.location,
 public.ST_SetSRID(public.ST_MakePoint(f.longitude,f.latitude),4326)::public.geography) END AS distance_meters
FROM feastjourney.restaurant_venues r CROSS JOIN input f
WHERE r.status='published' AND (f.area='' OR lower(r.area)=lower(f.area))
 AND(f.cuisine='' OR EXISTS(SELECT 1 FROM feastjourney.restaurant_venue_cuisines vc JOIN feastjourney.cuisines c ON c.id=vc.cuisine_id WHERE vc.venue_id=r.id AND c.slug=f.cuisine))
 AND(f.longitude IS NULL OR public.ST_DWithin(r.location,public.ST_SetSRID(public.ST_MakePoint(f.longitude,f.latitude),4326)::public.geography,f.radius))
 AND(f.west IS NULL OR (CASE WHEN f.west<=f.east THEN
 r.location::public.geometry && public.ST_MakeEnvelope(f.west,f.south,f.east,f.north,4326)
 ELSE r.location::public.geometry && public.ST_MakeEnvelope(f.west,f.south,180,f.north,4326)
 OR r.location::public.geometry && public.ST_MakeEnvelope(-180,f.south,f.east,f.north,4326) END))), request AS(SELECT :dish::bigint AS dish,:channel::text AS channel,:portion::nullable(text) AS portion,:q::text AS q),
offerings AS(SELECT v.id,v.business_id,v.name,v.address,v.area,v.country_code,v.longitude,v.latitude,v.distance_meters,
 e.evidence_tier,e.match_kind,e.observed_at AS evidence_observed_at,i.id AS item_id,i.name AS item_name,
 vr.id AS variant_id,vr.name AS variant_name,vr.comparison_key,
 p.observation_id,p.amount,p.currency,p.price_kind,p.sales_channel,p.tax_treatment,p.current_enough,p.observed_at,p.source_category,p.source_url
 FROM venues v JOIN feastjourney.restaurant_menu_items i ON i.venue_id=v.id AND i.status='published'
 JOIN feastjourney.restaurant_menus m ON m.id=i.menu_id AND m.status='published'
 JOIN feastjourney.restaurant_eligible_evidence e ON e.menu_item_id=i.id
 JOIN feastjourney.restaurant_menu_item_variants vr ON vr.menu_item_id=i.id AND vr.status='published'
 CROSS JOIN request f LEFT JOIN feastjourney.restaurant_selected_prices p ON p.variant_id=vr.id AND p.sales_channel=f.channel
 WHERE e.observed_at IS NOT NULL AND e.match_kind IS NOT NULL AND e.dish_id=f.dish AND (f.portion IS NULL OR vr.comparison_key=f.portion)
 AND (f.q='' OR EXISTS(SELECT 1 FROM feastjourney.restaurant_venue_names n WHERE n.venue_id=v.id AND strpos(n.normalized_name,lower(public.unaccent(f.q)))>0))), options AS(SELECT :sort::text AS sort,:budget::nullable(numeric) AS budget),
fx AS(SELECT unnest(:currencies::text[]) AS currency,unnest(:rates::numeric[]) AS rate),
qualified AS(SELECT o.*,o.amount*fx.rate AS comparison_amount FROM offerings o CROSS JOIN options s
LEFT JOIN fx ON fx.currency=o.currency
WHERE ((s.sort NOT IN ('price_low','price_high') AND s.budget IS NULL) OR
  (o.current_enough AND o.price_kind='listed' AND o.tax_treatment='included' AND fx.rate IS NOT NULL AND (s.budget IS NULL OR o.amount*fx.rate<s.budget)))),
chosen AS(SELECT DISTINCT ON(o.id) o.* FROM qualified o CROSS JOIN options s
ORDER BY o.id,
 CASE WHEN s.sort='price_high' THEN o.comparison_amount END DESC NULLS LAST,
 CASE WHEN s.sort='price_low' OR s.budget IS NOT NULL THEN o.comparison_amount END ASC NULLS LAST,
 o.evidence_tier,o.distance_meters NULLS LAST,o.evidence_observed_at DESC,o.item_id,o.variant_id)
SELECT c.* FROM chosen c CROSS JOIN options s ORDER BY
 CASE WHEN s.sort='price_low' THEN c.comparison_amount END ASC NULLS LAST,
 CASE WHEN s.sort='price_high' THEN c.comparison_amount END DESC NULLS LAST,
 CASE WHEN s.sort='recommended' THEN c.evidence_tier END,
 c.distance_meters ASC NULLS LAST,c.evidence_observed_at DESC,c.id LIMIT :limit::int;
