INSERT INTO feastjourney.restaurant_venue_names(venue_id,language_tag,name) VALUES(:venue::uuid,'und',:name::text)
ON CONFLICT(venue_id,language_tag,name) DO NOTHING;
