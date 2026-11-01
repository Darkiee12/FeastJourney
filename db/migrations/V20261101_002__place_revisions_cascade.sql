-- FeastJourney place-registry audit, follow-up: cascade place history.
--
-- V20261101_001 declared place_revisions.place_id ON DELETE SET NULL, but
-- the same migration's CHECK (((operation = 'deleted') = (place_id IS NULL)))
-- is re-validated when the foreign-key action NULLs surviving rows: deleting
-- a place with 'created'/'updated'/... revisions aborts with a check
-- violation instead of deleting.
--
-- Resolution: non-deleted history is place-scoped and dies with its row
-- (ON DELETE CASCADE, mirroring catalog_revisions for dishes). Only the
-- 'deleted' tombstone — inserted with a NULL place_id AFTER the delete, in
-- the same transaction — survives, so the CHECK holds in every reachable
-- state: non-deleted rows always reference a live place, 'deleted' rows
-- never do.

SET search_path TO feastjourney, public;

ALTER TABLE feastjourney.place_revisions DROP CONSTRAINT place_revisions_place_id_fkey;
ALTER TABLE feastjourney.place_revisions
  ADD CONSTRAINT place_revisions_place_id_fkey FOREIGN KEY (place_id)
  REFERENCES feastjourney.places (id) ON DELETE CASCADE;
