SELECT id, source_name, source_version, release, license, attribution,
  format, status, total_records, valid_records, invalid_records, staged_count,
  applied_count, skipped_count, apply_failed_count, dry_run, approved_by,
  approved_at, license_ack, review_ack,
  acknowledged_duplicates::text AS acknowledged_duplicates,
  created_by, created_at, completed_at
FROM feastjourney.restaurant_import_jobs
WHERE id = :id::uuid
FOR UPDATE
