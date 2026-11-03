UPDATE feastjourney.restaurant_price_observations
SET review_status=:status::text,reviewed_by=:actor::text,reviewed_at=now() WHERE id=:id::uuid AND review_status='pending' RETURNING id;
