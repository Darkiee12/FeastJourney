INSERT INTO feastjourney.restaurant_customer_reviews (venue_id, author_id, rating, body, status)
VALUES (:venue_id::uuid, :author_id::text, :rating::smallint, :body::text, 'pending')
RETURNING id, venue_id, author_id, rating::int AS rating, body, status,
 created_at, updated_at, published_at;
