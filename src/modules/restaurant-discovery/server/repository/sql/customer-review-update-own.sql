UPDATE feastjourney.restaurant_customer_reviews
SET rating = :rating::smallint, body = :body::text, status = 'pending',
 updated_at = now(), published_at = NULL
WHERE id = :id::uuid AND author_id = :author_id::text
 AND status IN ('pending', 'published', 'rejected')
RETURNING id, venue_id, rating::int AS rating, body, status,
 created_at, updated_at, published_at;
