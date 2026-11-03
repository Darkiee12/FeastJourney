SELECT id,business_id,name,address,area,country_code,status,
 ARRAY(SELECT vc.cuisine_id::text FROM feastjourney.restaurant_venue_cuisines vc WHERE vc.venue_id=restaurant_venues.id ORDER BY vc.cuisine_id) AS cuisine_ids,
 longitude,latitude
FROM feastjourney.restaurant_venues ORDER BY updated_at DESC,id LIMIT 100;
