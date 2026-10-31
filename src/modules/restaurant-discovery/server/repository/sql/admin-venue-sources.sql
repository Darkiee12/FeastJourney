SELECT s.id,s.category,CASE WHEN s.category='receipt' THEN NULL ELSE s.source_url END AS source_url,
 s.observed_at,s.valid_until,s.eligible,
 (SELECT count(*)::int FROM feastjourney.restaurant_price_observations p WHERE p.source_id=s.id) AS price_count,
 (SELECT count(*)::int FROM feastjourney.restaurant_price_observations p WHERE p.source_id=s.id AND p.review_status='pending') AS pending_prices,
 (SELECT count(*)::int FROM feastjourney.restaurant_serving_evidence e WHERE e.source_id=s.id AND e.review_status='pending') AS pending_evidence
FROM feastjourney.restaurant_sources s WHERE s.venue_id=:venue::uuid
ORDER BY s.observed_at DESC LIMIT :limit::int;
