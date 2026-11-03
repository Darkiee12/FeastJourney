UPDATE feastjourney.restaurant_import_records
SET status = :status::text,
  errors = :errors::nullable(jsonb),
  warnings = :warnings::nullable(jsonb),
  venue_id = :venue_id::nullable(uuid),
  duplicate_of = :duplicate_of::nullable(uuid)
WHERE id = :id::uuid
RETURNING id, job_id, record_index, external_ref, status,
  errors::text AS errors, warnings::text AS warnings, venue_id, duplicate_of,
  dedup_key, payload::text AS payload, created_at
