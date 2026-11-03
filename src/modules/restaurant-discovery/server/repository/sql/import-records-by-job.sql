SELECT id, job_id, record_index, external_ref, status,
  errors::text AS errors, warnings::text AS warnings, venue_id, duplicate_of,
  dedup_key, payload::text AS payload, created_at
FROM feastjourney.restaurant_import_records
WHERE job_id = :job_id::uuid
ORDER BY record_index ASC, id ASC
LIMIT :limit::int OFFSET :offset::int
