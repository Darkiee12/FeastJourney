SELECT id, venue_id, author_id, rating::int AS rating, body, status,
 created_at, updated_at, published_at,
 count(*) OVER()::int AS total
FROM feastjourney.restaurant_customer_reviews
WHERE venue_id = :venue_id::uuid AND status = 'published'
ORDER BY published_at DESC NULLS LAST, created_at DESC, id DESC
LIMIT :limit::int OFFSET :offset::int;
