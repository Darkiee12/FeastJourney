INSERT INTO feastjourney.places (kind, iso3166, display_latitude, display_longitude, display_note)
VALUES (:kind::text, :iso3166::nullable(text), :display_latitude::nullable(double precision), :display_longitude::nullable(double precision), :display_note::nullable(text))
RETURNING id, kind, iso3166, display_latitude AS "displayLatitude", display_longitude AS "displayLongitude", display_note AS "displayNote"
