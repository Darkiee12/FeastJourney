SELECT m.id::text AS id, m.venue_id::text AS venue_id
FROM feastjourney.restaurant_menus AS m
WHERE m.id = :id::uuid
