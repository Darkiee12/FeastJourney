WITH input AS (
  SELECT :status::text AS status, :venue::text AS venue
)
SELECT r.id, r.venue_id, v.name AS venue_name, r.rating,
 r.body, r.status, r.created_at AS submitted_at
FROM feastjourney.restaurant_customer_reviews r
JOIN feastjourney.restaurant_venues v ON v.id = r.venue_id
WHERE ((SELECT status FROM input) = 'all' OR r.status = (SELECT status FROM input))
 AND ((SELECT venue FROM input) = ''
  OR STRPOS(LOWER(v.name), LOWER((SELECT venue FROM input))) > 0
  OR STRPOS(LOWER(v.area), LOWER((SELECT venue FROM input))) > 0
  OR STRPOS(LOWER(v.address), LOWER((SELECT venue FROM input))) > 0)
ORDER BY (r.status = 'pending') DESC, r.created_at DESC, r.id DESC
LIMIT :limit::int OFFSET :offset::int;
