INSERT INTO feastjourney.place_parents (place_id, parent_place_id)
VALUES (:place_id::bigint, :parent_place_id::bigint)
RETURNING place_id, parent_place_id
