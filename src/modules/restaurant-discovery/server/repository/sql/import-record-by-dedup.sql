-- Idempotent-reimport probe: the globally unique dedup key finds the
-- already-applied record from an earlier job, so a repeated release links to
-- the existing venue instead of inserting a second one.
SELECT venue_id, status
FROM feastjourney.restaurant_import_records
WHERE dedup_key = :dedup_key::text
ORDER BY created_at ASC, id ASC
LIMIT 1
