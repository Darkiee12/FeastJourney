-- Validate-side progress: advances the frozen validation tallies and
-- flips status to validated/failed only when every staged row is resolved.
UPDATE feastjourney.restaurant_import_jobs
SET valid_records = :valid_records::int,
  invalid_records = :invalid_records::int,
  status = :status::text,
  completed_at = :completed_at::nullable(timestamptz)
WHERE id = :id::uuid
RETURNING id, status, valid_records, invalid_records, completed_at
