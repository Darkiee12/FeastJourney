SELECT COALESCE(MAX(sort_order), -1)::integer AS max_sort_order
FROM feastjourney.restaurant_photos
WHERE venue_id = :venue_id::uuid
