WITH input AS (SELECT :sort::text AS sort)
SELECT id, rating::int AS rating, body, created_at, published_at
FROM feastjourney.restaurant_customer_reviews
WHERE venue_id = :venue_id::uuid AND status = 'published'
ORDER BY
 CASE WHEN (SELECT sort FROM input) = 'lowest' THEN rating END ASC,
 CASE WHEN (SELECT sort FROM input) = 'highest' THEN rating END DESC,
 published_at DESC NULLS LAST,
 id DESC
LIMIT :limit::int OFFSET :offset::int;
