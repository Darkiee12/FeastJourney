UPDATE feastjourney.restaurant_photos
SET sort_order = :sort_order::integer,
  updated_at = now()
WHERE id = :id::uuid
