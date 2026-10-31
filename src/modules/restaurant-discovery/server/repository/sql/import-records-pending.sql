-- Next appliable window in original dataset order: only valid and
-- curator-approved rows are ever picked up. Exact duplicates, fuzzy
-- candidates awaiting review, applied rows and failures are never replayed,
-- so a crashed or timed-out batch resumes exactly where it stopped.
SELECT id, job_id, record_index, external_ref, status,
  errors::text AS errors, warnings::text AS warnings, venue_id, duplicate_of,
  dedup_key, payload::text AS payload, created_at
FROM feastjourney.restaurant_import_records
WHERE job_id = :job_id::uuid
  AND status IN ('valid', 'approved')
ORDER BY record_index ASC NULLS LAST, id ASC
LIMIT :limit::int
