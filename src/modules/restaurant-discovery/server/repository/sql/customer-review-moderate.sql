WITH input AS (
 SELECT :id::uuid AS id, :status::text AS status, :from_status::text AS from_status
)
UPDATE feastjourney.restaurant_customer_reviews r
SET status = input.status, updated_at = now(),
 published_at = CASE WHEN input.status = 'published'
  THEN COALESCE(r.published_at, now()) ELSE r.published_at END
FROM input
WHERE r.id = input.id AND r.status = input.from_status
RETURNING r.id, r.venue_id, r.author_id, r.rating::int AS rating, r.body, r.status,
 r.created_at, r.updated_at, r.published_at;
