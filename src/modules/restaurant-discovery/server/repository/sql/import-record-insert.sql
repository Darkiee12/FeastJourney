INSERT INTO feastjourney.restaurant_import_records
  (job_id, record_index, external_ref, status, errors, warnings, venue_id,
   duplicate_of, dedup_key, payload)
VALUES
  (:job_id::uuid, :record_index::int, :external_ref::text, :status::text,
   :errors::nullable(jsonb), :warnings::nullable(jsonb),
   :venue_id::nullable(uuid), :duplicate_of::nullable(uuid),
   :dedup_key::nullable(text), :payload::jsonb)
RETURNING id, job_id, record_index, external_ref, status,
  errors::text AS errors, warnings::text AS warnings, venue_id, duplicate_of,
  dedup_key, payload::text AS payload, created_at
