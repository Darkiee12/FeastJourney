-- Restaurant bulk-import records: one staged candidate venue per row.
--
-- ADR 0006 consequences require a stable external-identity dedup key of the
-- form `sourceName:datasetVersion:sourceRecordId`, persisted per row so
-- reimports of the same release are idempotent and curator edits on already
-- applied venues are never overwritten by a later run. The key is nullable
-- until assigned (manual rows without a stable source record id never get
-- one) and guarded by a partial uniqueness index: assigned keys are globally
-- unique, NULLs never collide.
--
-- Lifecycle: staged -> validated into valid | invalid | skipped_duplicate
-- (exact normalized name+address match auto-skips) | needs_review (trigram
-- candidate within 50 m waits for a curator). needs_review resolves to
-- approved (apply as a new draft venue) or skipped_duplicate (confirm the
-- match). Apply consumes valid + approved rows only; applied rows are never
-- re-selected, so crashed batches resume without double inserts. The wizard
-- never auto-merges on fuzzy names.

CREATE TABLE IF NOT EXISTS feastjourney.restaurant_import_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES feastjourney.restaurant_import_jobs (id) ON DELETE CASCADE,
  record_index INTEGER NOT NULL CHECK (record_index >= 0),
  external_ref TEXT NOT NULL CHECK (char_length(btrim(external_ref)) BETWEEN 1 AND 300),
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'valid', 'invalid', 'needs_review', 'approved', 'applied', 'skipped_duplicate', 'failed')),
  errors JSONB NULL,
  warnings JSONB NULL,
  venue_id UUID NULL REFERENCES feastjourney.restaurant_venues (id),
  duplicate_of UUID NULL REFERENCES feastjourney.restaurant_venues (id),
  dedup_key TEXT NULL CHECK (dedup_key IS NULL OR char_length(dedup_key) BETWEEN 1 AND 300),
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, record_index)
);

-- Uniqueness guard for assigned external-identity keys only. Partial index:
-- two NULLs never conflict, two equal keys always do, so idempotent
-- reimports collide here instead of inserting a second venue.
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_import_records_dedup_idx
  ON feastjourney.restaurant_import_records (dedup_key)
  WHERE dedup_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS restaurant_import_records_job_status_idx
  ON feastjourney.restaurant_import_records (job_id, status, record_index);
