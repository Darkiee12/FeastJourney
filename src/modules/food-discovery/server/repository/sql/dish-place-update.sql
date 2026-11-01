UPDATE feastjourney.dish_places
SET association = :association::text,
  is_disputed = :is_disputed::boolean,
  note = :note::nullable(text)
WHERE dish_id = :dish_id::bigint AND place_id = :place_id::bigint
RETURNING dish_id, place_id, association, is_disputed, note
