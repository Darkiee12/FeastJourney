INSERT INTO feastjourney.restaurant_venue_cuisines(venue_id,cuisine_id)
SELECT :venue::uuid,unnest(:ids::bigint[]);
