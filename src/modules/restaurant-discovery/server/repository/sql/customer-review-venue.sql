SELECT id, status
FROM feastjourney.restaurant_venues
WHERE id = :id::uuid;
