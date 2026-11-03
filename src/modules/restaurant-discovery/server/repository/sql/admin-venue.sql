INSERT INTO feastjourney.restaurant_venues(id,business_id,name,address,area,country_code,location,status)
VALUES(:id::uuid,:business::uuid,:name::text,:address::text,:area::text,:country::text,
 public.ST_SetSRID(public.ST_MakePoint(:longitude::float8,:latitude::float8),4326)::public.geography,:status::text)
ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,area=EXCLUDED.area,
 country_code=EXCLUDED.country_code,location=EXCLUDED.location,status=EXCLUDED.status,updated_at=now()
RETURNING id;
