DELETE FROM feastjourney.places
WHERE id = :id::bigint
RETURNING id
