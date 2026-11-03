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
 OR r.location::public.geometry && public.ST_MakeEnvelope(-180,f.south,f.east,f.north,4326) END))), query AS(SELECT lower(public.unaccent(btrim(:q::text))) AS q),ranked AS(
SELECT v.id,v.business_id,v.name,v.address,v.area,v.country_code,v.longitude,v.latitude,v.distance_meters,
 (SELECT min(CASE WHEN n.normalized_name=q.q THEN 0 WHEN starts_with(n.normalized_name,q.q) THEN 1
 WHEN strpos(n.normalized_name,q.q)>0 THEN 2 ELSE 3 END)
 FROM feastjourney.restaurant_venue_names n CROSS JOIN query q
 WHERE n.venue_id=v.id AND (strpos(n.normalized_name,q.q)>0 OR n.normalized_name OPERATOR(public.%) q.q)) AS tier
FROM venues v)
SELECT id,business_id,name,address,area,country_code,longitude,latitude,distance_meters FROM ranked WHERE tier IS NOT NULL
ORDER BY CASE WHEN :sort::text='nearest' THEN 0 ELSE tier END,distance_meters NULLS LAST,lower(name),id LIMIT :limit::int;
