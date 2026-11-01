-- FeastJourney place-registry audit: place-scoped revision trail.
--
-- catalog_revisions and curation_notes are dish-bound (dish_id NOT NULL
-- REFERENCES dishes), so place admin mutations had no audit home. Every
-- place-admin mutation records one row here in the same transaction as the
-- mutation (see PlaceAdminService + PlaceRepository.insertRevision).
--
-- Delete handling: place_id uses ON DELETE SET NULL so a 'deleted' revision
-- survives the row it describes. The CHECK keeps the invariant tight:
-- exactly the 'deleted' operation carries a NULL place_id (the summary
-- names the deleted place id and display name); every other operation
-- references a live place row.

SET search_path TO feastjourney, public;

CREATE TABLE feastjourney.place_revisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  place_id BIGINT REFERENCES feastjourney.places (id) ON DELETE SET NULL,
  actor TEXT NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 200),
  operation TEXT NOT NULL CHECK (
    operation IN (
      'created', 'updated', 'name_upserted', 'name_removed',
      'parent_linked', 'parent_unlinked', 'deleted'
    )
  ),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((operation = 'deleted') = (place_id IS NULL))
);
CREATE INDEX place_revisions_place_idx ON feastjourney.place_revisions (place_id);
CREATE INDEX place_revisions_created_idx ON feastjourney.place_revisions (created_at DESC);
