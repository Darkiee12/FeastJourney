UPDATE feastjourney.restaurant_customer_reviews
SET body = '', status = 'removed', updated_at = now()
WHERE id = :id::uuid AND author_id = :author_id::text
 AND status IN ('pending', 'published', 'rejected')
RETURNING id, venue_id, author_id, rating::int AS rating, body, status,
 created_at, updated_at, published_at;
