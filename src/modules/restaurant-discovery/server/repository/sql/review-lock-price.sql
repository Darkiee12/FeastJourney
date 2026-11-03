SELECT id,review_status,reviewed_by FROM feastjourney.restaurant_price_observations WHERE id=:id::uuid FOR UPDATE;
