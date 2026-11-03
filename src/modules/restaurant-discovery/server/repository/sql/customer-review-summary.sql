SELECT count(*)::int AS total,
 COALESCE(sum(rating), 0)::int AS rating_sum,
 count(*) FILTER (WHERE rating = 1)::int AS stars_1,
 count(*) FILTER (WHERE rating = 2)::int AS stars_2,
 count(*) FILTER (WHERE rating = 3)::int AS stars_3,
 count(*) FILTER (WHERE rating = 4)::int AS stars_4,
 count(*) FILTER (WHERE rating = 5)::int AS stars_5
FROM feastjourney.restaurant_customer_reviews
WHERE venue_id = :venue_id::uuid AND status = 'published';
