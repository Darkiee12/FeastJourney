-- Review gate: records who approved the bulk apply and which
-- acknowledgements they gave. License review is required only when the
-- stored source needs it (non-empty license that is not a reviewed
-- first-party grant); the general review ack is always required. Enforced
-- from stored job state at apply time, never from client flags.
UPDATE feastjourney.restaurant_import_jobs
SET approved_by = :approved_by::text,
  approved_at = now(),
  license_ack = :license_ack::boolean,
  review_ack = :review_ack::boolean,
  acknowledged_duplicates = :acknowledged_duplicates::jsonb
WHERE id = :id::uuid
RETURNING id, status, approved_by, approved_at, license_ack, review_ack,
  acknowledged_duplicates::text AS acknowledged_duplicates
