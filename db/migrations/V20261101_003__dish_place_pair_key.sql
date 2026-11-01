-- Converge dish↔place links on the (dish_id, place_id) pair key.
--
-- The registry treats one place link per dish as one relationship whose
-- association (origin/associated/popular), disputed flag, and note update
-- in place. The legacy key (dish_id, place_id, association) allowed the
-- same pair twice with different associations; the only such rows in the
-- wild are `origin`+`popular` on the same country (pho/banh-mi→Vietnam,
-- pizza→Italy, sushi→Japan), where `popular` adds no information over the
-- stronger origin claim. This migration keeps `origin` for those pairs and
-- then narrows the primary key so the database enforces the contract the
-- admin editor already implements (update-in-place, never duplicates).
--
-- Forward-only and idempotent: the DELETE matches only exact
-- origin+popular sibling pairs, and the key change is guarded by
-- existence checks.

SET search_path TO feastjourney, public;

-- 1. Drop the redundant `popular` sibling wherever an `origin` claim
-- already covers the same dish↔place pair.
DELETE FROM feastjourney.dish_places AS redundant
USING feastjourney.dish_places AS keeper
WHERE redundant.dish_id = keeper.dish_id
  AND redundant.place_id = keeper.place_id
  AND redundant.association = 'popular'
  AND keeper.association = 'origin';

-- 2. Narrow the key. Any other unexpected duplicate pair aborts loudly
-- instead of silently picking a winner.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dish_places_pkey'
  ) THEN
    ALTER TABLE feastjourney.dish_places DROP CONSTRAINT dish_places_pkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dish_places_pair_key'
  ) THEN
    ALTER TABLE feastjourney.dish_places
      ADD CONSTRAINT dish_places_pair_key PRIMARY KEY (dish_id, place_id);
  END IF;
END
$$;
