SELECT id, venue_id, author_id, rating::int AS rating, body, status,
 created_at, updated_at, published_at
FROM feastjourney.restaurant_customer_reviews
WHERE id = :id::uuid
FOR UPDATE;
