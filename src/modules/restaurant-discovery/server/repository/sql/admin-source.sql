INSERT INTO feastjourney.restaurant_sources(venue_id,category,source_url,private_object_key,deduplication_key,restaurant_verified,observed_at,valid_until,created_by)
VALUES(:venue::uuid,:category::text,:url::nullable(text),:object_key::nullable(text),:deduplication::text,:verified::bool,:observed::timestamptz,:until::timestamptz,:actor::text)
RETURNING id;
