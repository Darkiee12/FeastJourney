INSERT INTO feastjourney.restaurant_import_jobs
  (source_name, source_version, release, license, attribution, format, status,
   total_records, valid_records, invalid_records, dry_run, created_by)
VALUES
  (:source_name::text, :source_version::nullable(text), :release::nullable(text),
   :license::nullable(text), :attribution::nullable(text), :format::text,
   :status::text, :total_records::int, :valid_records::int, :invalid_records::int,
   :dry_run::boolean, :created_by::nullable(text))
RETURNING id, source_name, source_version, release, license, attribution,
  format, status, total_records, valid_records, invalid_records, staged_count,
  applied_count, skipped_count, apply_failed_count, dry_run, approved_by,
  approved_at, license_ack, review_ack,
  acknowledged_duplicates::text AS acknowledged_duplicates,
  created_by, created_at, completed_at
