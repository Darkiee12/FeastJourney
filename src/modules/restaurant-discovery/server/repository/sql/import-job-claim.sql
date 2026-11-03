-- Atomic apply claim: one conditional UPDATE moves validated ->
-- applying (and re-admits applying for crash resume) while clearing dry_run.
-- A zero-row result means another worker owns the job or it already left the
-- applicable states; the caller re-reads state instead of assuming success.
UPDATE feastjourney.restaurant_import_jobs
SET status = 'applying',
  dry_run = FALSE
WHERE id = :id::uuid
  AND status IN ('validated', 'applying')
RETURNING id, source_name, source_version, release, license, attribution,
  format, status, total_records, valid_records, invalid_records, staged_count,
  applied_count, skipped_count, apply_failed_count, dry_run, approved_by,
  approved_at, license_ack, review_ack,
  acknowledged_duplicates::text AS acknowledged_duplicates,
  created_by, created_at, completed_at
