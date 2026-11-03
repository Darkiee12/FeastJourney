-- Insert-only venue creation for bulk apply. Unlike the interactive
-- upsert, this statement has no ON CONFLICT path: applied rows always carry
-- fresh UUIDs, so a bulk import can never overwrite curator edits on an
-- existing venue. Exact duplicates never reach this statement (they skip at
-- validate time), and reimports collide on the record dedup key instead.
INSERT INTO feastjourney.restaurant_venues
  (id, business_id, name, address, area, country_code, location, status)
VALUES
  (:id::uuid, :business::uuid, :name::text, :address::text, :area::text,
   :country::text,
   public.ST_SetSRID(public.ST_MakePoint(:longitude::float8, :latitude::float8), 4326)::public.geography,
   'draft')
RETURNING id
