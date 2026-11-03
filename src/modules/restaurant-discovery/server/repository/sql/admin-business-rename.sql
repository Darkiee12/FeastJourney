UPDATE feastjourney.restaurant_businesses SET name=:name::text WHERE id=:id::uuid RETURNING id,name;
