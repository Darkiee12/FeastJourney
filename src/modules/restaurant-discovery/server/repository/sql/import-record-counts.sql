SELECT
  COUNT(*) FILTER (WHERE status = 'staged')::int AS staged,
  COUNT(*) FILTER (WHERE status = 'valid')::int AS valid,
  COUNT(*) FILTER (WHERE status = 'invalid')::int AS invalid,
  COUNT(*) FILTER (WHERE status = 'needs_review')::int AS needs_review,
  COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
  COUNT(*) FILTER (WHERE status = 'applied')::int AS applied,
  COUNT(*) FILTER (WHERE status = 'skipped_duplicate')::int AS skipped_duplicate,
  COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
FROM feastjourney.restaurant_import_records
WHERE job_id = :job_id::uuid
