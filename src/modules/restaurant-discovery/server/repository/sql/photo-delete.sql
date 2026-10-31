DELETE FROM feastjourney.restaurant_photos
WHERE id = :id::uuid
RETURNING id::text AS id, venue_id::text AS venue_id, object_key, variant_version
