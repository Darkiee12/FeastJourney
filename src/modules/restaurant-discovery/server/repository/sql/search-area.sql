WITH input AS(SELECT :area::text AS area,:cuisine::text AS cuisine,
 :longitude::nullable(float8) AS longitude,:latitude::nullable(float8) AS latitude,:radius::float8 AS radius,
 :west::nullable(float8) AS west,:south::nullable(float8) AS south,:east::nullable(float8) AS east,:north::nullable(float8) AS north),
venues AS(SELECT r.id,r.business_id,r.name,r.address,r.area,r.country_code,r.location,
 r.longitude AS longitude,r.latitude AS latitude,
 CASE WHEN f.longitude IS NULL THEN NULL ELSE public.ST_Distance(r.location,
 public.ST_SetSRID(public.ST_MakePoint(f.longitude,f.latitude),4326)::public.geography) END AS distance_meters
FROM feastjourney.restaurant_venues r CROSS JOIN input f
WHERE r.status='published' AND (f.area='' OR lower(r.area)=lower(f.area))
 AND(f.cuisine='' OR EXISTS(SELECT 1 FROM feastjourney.restaurant_venue_cuisines vc JOIN feastjourney.cuisines c ON c.id=vc.cuisine_id WHERE vc.venue_id=r.id AND c.slug=f.cuisine))
 AND(f.longitude IS NULL OR public.ST_DWithin(r.location,public.ST_SetSRID(public.ST_MakePoint(f.longitude,f.latitude),4326)::public.geography,f.radius))
 AND(f.west IS NULL OR (CASE WHEN f.west<=f.east THEN
 r.location::public.geometry && public.ST_MakeEnvelope(f.west,f.south,f.east,f.north,4326)
 ELSE r.location::public.geometry && public.ST_MakeEnvelope(f.west,f.south,180,f.north,4326)
 OR r.location::public.geometry && public.ST_MakeEnvelope(-180,f.south,f.east,f.north,4326) END))) SELECT id,business_id,name,address,area,country_code,longitude,latitude,distance_meters
FROM venues ORDER BY distance_meters ASC NULLS LAST,lower(name),id LIMIT :limit::int;
