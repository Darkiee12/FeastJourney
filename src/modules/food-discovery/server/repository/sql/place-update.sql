UPDATE feastjourney.places
SET kind = :kind::text,
  iso3166 = :iso3166::nullable(text),
  display_latitude = :display_latitude::nullable(double precision),
  display_longitude = :display_longitude::nullable(double precision),
  display_note = :display_note::nullable(text)
WHERE id = :id::bigint
RETURNING id, kind, iso3166, display_latitude AS "displayLatitude", display_longitude AS "displayLongitude", display_note AS "displayNote"
