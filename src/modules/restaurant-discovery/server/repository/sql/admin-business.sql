INSERT INTO feastjourney.restaurant_businesses(name) VALUES(:name::text) RETURNING id;
