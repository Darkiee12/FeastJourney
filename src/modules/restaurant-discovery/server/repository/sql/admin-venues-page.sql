WITH input AS(SELECT :q::text AS q,:status::text AS status,:business::text AS business)
SELECT v.id,v.business_id,b.name AS business_name,v.name,v.address,v.area,v.country_code,v.status,
 v.longitude,v.latitude,
 ARRAY(SELECT vc.cuisine_id::text FROM feastjourney.restaurant_venue_cuisines vc WHERE vc.venue_id=v.id ORDER BY vc.cuisine_id) AS cuisine_ids,
 (SELECT count(*)::int FROM feastjourney.restaurant_sources s WHERE s.venue_id=v.id) AS source_count,
 (SELECT count(*)::int FROM feastjourney.restaurant_price_observations p WHERE p.venue_id=v.id AND p.review_status='pending') AS pending_count,
 (SELECT count(*)::int FROM feastjourney.restaurant_serving_evidence e WHERE e.venue_id=v.id AND e.review_status='pending') AS pending_evidence,
 count(*) OVER()::int AS total
FROM feastjourney.restaurant_venues v
JOIN feastjourney.restaurant_businesses b ON b.id=v.business_id
CROSS JOIN input i
WHERE (i.status='' OR v.status=i.status)
 AND (i.business='' OR v.business_id::text=i.business)
 AND (i.q='' OR lower(v.name) LIKE i.q OR lower(v.area) LIKE i.q OR lower(v.address) LIKE i.q OR lower(b.name) LIKE i.q)
ORDER BY v.updated_at DESC,v.id LIMIT :limit::int OFFSET :offset::int;
