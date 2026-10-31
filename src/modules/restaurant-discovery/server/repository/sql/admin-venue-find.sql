SELECT v.id,v.business_id,b.name AS business_name,v.address,v.country_code,v.longitude,v.latitude
FROM feastjourney.restaurant_venues v
JOIN feastjourney.restaurant_businesses b ON b.id=v.business_id
WHERE v.id=:id::uuid FOR UPDATE;
