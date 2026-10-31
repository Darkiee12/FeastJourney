SELECT id,review_status,reviewed_by FROM feastjourney.restaurant_serving_evidence WHERE id=:id::uuid FOR UPDATE;
