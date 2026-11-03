WITH input AS (
  SELECT :status::text AS status, :venue::text AS venue
)
SELECT count(*)::int AS total,
 count(*) FILTER (WHERE r.status = 'pending')::int AS pending_count
FROM feastjourney.restaurant_customer_reviews r
JOIN feastjourney.restaurant_venues v ON v.id = r.venue_id
WHERE ((SELECT status FROM input) = 'all' OR r.status = (SELECT status FROM input))
 AND ((SELECT venue FROM input) = ''
  OR STRPOS(LOWER(v.name), LOWER((SELECT venue FROM input))) > 0
  OR STRPOS(LOWER(v.area), LOWER((SELECT venue FROM input))) > 0
  OR STRPOS(LOWER(v.address), LOWER((SELECT venue FROM input))) > 0);
