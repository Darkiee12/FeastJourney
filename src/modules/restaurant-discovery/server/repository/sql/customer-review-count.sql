SELECT count(*)::int AS total
FROM feastjourney.restaurant_customer_reviews
WHERE venue_id = :venue_id::uuid AND status = 'published';
