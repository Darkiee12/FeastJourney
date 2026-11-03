SELECT id, venue_id, author_id, rating::int AS rating, body, status,
 created_at, updated_at, published_at
FROM feastjourney.restaurant_customer_reviews
WHERE venue_id = :venue_id::uuid AND author_id = :author_id::text
 AND status IN ('pending', 'published')
FOR UPDATE;
