-- Apply-side progress: one call applies a bounded window of rows, so the
-- counts advance batch by batch and the job flips to applied only when no
-- appliable rows remain. Crash resume rebuilds the window from row statuses.
UPDATE feastjourney.restaurant_import_jobs
SET applied_count = :applied_count::int,
  skipped_count = :skipped_count::int,
  apply_failed_count = :apply_failed_count::int,
  status = :status::text,
  completed_at = :completed_at::nullable(timestamptz)
WHERE id = :id::uuid
RETURNING id, status, applied_count, skipped_count, apply_failed_count, completed_at
