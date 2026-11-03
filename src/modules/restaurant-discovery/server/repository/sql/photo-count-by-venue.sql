SELECT COUNT(*)::bigint AS count
FROM feastjourney.restaurant_photos
WHERE venue_id = :venue_id::uuid
