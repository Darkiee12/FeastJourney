-- Restaurant bulk-import jobs (venue candidates, NOT catalog dishes).
--
-- ADR 0006 ingests third-party POI candidates (Overture Maps Places) and
-- manual CSV/JSON venue lists through a staged pipeline that mirrors the
-- food catalog import lifecycle (V20261028_011..013): stage the payload,
-- validate without side effects, resolve duplicates with a curator, then
-- apply approved rows as draft venues in a crash-resumable claimed batch.
--
-- This table is deliberately separate from `catalog_import_jobs`: venue
-- provenance (source release, license, attribution) and the venue dedup
-- identity have different integrity rules from dish authoring payloads, and
-- sharing the job table would let one pipeline's status machine corrupt the
-- other's. No existing table is altered.
--
-- All provenance columns are nullable so staged-then-annotated jobs stay
-- valid; the apply path enforces license/review acknowledgements from
-- stored state, never from client flags.

CREATE TABLE IF NOT EXISTS feastjourney.restaurant_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name TEXT NOT NULL CHECK (char_length(btrim(source_name)) BETWEEN 1 AND 200),
  source_version TEXT NULL CHECK (source_version IS NULL OR char_length(source_version) BETWEEN 1 AND 200),
  release TEXT NULL CHECK (release IS NULL OR char_length(release) BETWEEN 1 AND 200),
  license TEXT NULL CHECK (license IS NULL OR char_length(license) BETWEEN 1 AND 200),
  attribution TEXT NULL CHECK (attribution IS NULL OR char_length(attribution) BETWEEN 1 AND 2000),
  format TEXT NOT NULL DEFAULT 'json' CHECK (format IN ('json', 'csv')),
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'validated', 'applying', 'applied', 'failed')),
  total_records INTEGER NOT NULL DEFAULT 0 CHECK (total_records >= 0),
  valid_records INTEGER NOT NULL DEFAULT 0 CHECK (valid_records >= 0),
  invalid_records INTEGER NOT NULL DEFAULT 0 CHECK (invalid_records >= 0),
  staged_count INTEGER NOT NULL DEFAULT 0 CHECK (staged_count >= 0),
  applied_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  apply_failed_count INTEGER NOT NULL DEFAULT 0 CHECK (apply_failed_count >= 0),
  dry_run BOOLEAN NOT NULL DEFAULT TRUE,
  approved_by TEXT NULL,
  approved_at TIMESTAMPTZ NULL,
  license_ack BOOLEAN NOT NULL DEFAULT FALSE,
  review_ack BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_duplicates JSONB NOT NULL DEFAULT '[]',
  created_by TEXT NULL REFERENCES feastjourney."user"(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS restaurant_import_jobs_status_idx
  ON feastjourney.restaurant_import_jobs (status, created_at DESC);
