DELETE FROM feastjourney.place_names
WHERE id = :id::bigint AND place_id = :place_id::bigint
RETURNING id
