SELECT v.id,v.business_id,b.name AS business_name,v.name,v.address,v.area,v.country_code,
 v.longitude AS longitude,v.latitude AS latitude
FROM feastjourney.restaurant_venues v JOIN feastjourney.restaurant_businesses b ON b.id=v.business_id
WHERE v.id=:id::uuid AND v.status='published';
