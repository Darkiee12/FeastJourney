-- Venue-scoped restaurant photography for result cards and detail galleries.
--
-- One row is one reviewed public image for a venue; the card shows the first
-- published image per venue and the detail gallery shows the published set in
-- sort order. Binary bytes live in object storage under a restaurant-photos/
-- prefix (see object_key CHECK below); an approved photograph is always a
-- first-party stored derivative, never a hotlinked file.
--
-- DATA-CLASS SEPARATION (privacy): private menu-scan uploads
-- (menu_scan_assets, menu/ keys) and first-party dish photography
-- (dish_media, dish-media/ keys) are different data classes. Restaurant photo
-- rows must never reference scan assets, scan keys, or dish_media rows, and
-- photo delivery must never serve scan bytes. Fact-extraction consent
-- (menu-facts-v1) is not photo-publication consent: approval here requires
-- explicit rights/privacy review at /admin/restaurants.
--
-- Lifecycle: draft -> review -> published. Withdrawal revokes delivery first
-- (the row leaves published status before any object delete runs); object
-- deletion is best-effort and never fails the withdrawal.

CREATE TABLE feastjourney.restaurant_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID NOT NULL REFERENCES feastjourney.restaurant_venues (id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  attribution TEXT,
  license TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'review', 'published')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  alt_text TEXT,
  focal_x DOUBLE PRECISION CHECK (focal_x IS NULL OR (focal_x >= 0 AND focal_x <= 1)),
  focal_y DOUBLE PRECISION CHECK (focal_y IS NULL OR (focal_y >= 0 AND focal_y <= 1)),
  original_width INTEGER
    CHECK (original_width IS NULL OR original_width > 0),
  original_height INTEGER
    CHECK (original_height IS NULL OR original_height > 0),
  format TEXT
    CHECK (format IS NULL OR format IN ('jpeg', 'png', 'webp')),
  byte_size BIGINT
    CHECK (byte_size IS NULL OR byte_size > 0),
  checksum_sha256 TEXT
    CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  variant_version INTEGER NOT NULL DEFAULT 1
    CHECK (variant_version >= 1),
  uploaded_by TEXT,
  processing TEXT NOT NULL DEFAULT 'processing'
    CHECK (processing IN ('processing', 'ready', 'failed')),
  reviewed_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  source_url TEXT
    CHECK (source_url IS NULL OR source_url ~ '^https://'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Bytes live only under the photos prefix. Staged uploads land under
  -- restaurant-photos/staged/ before finalize moves the row to its immutable
  -- versioned base restaurant-photos/{venueId}/{photoId}/{version}. Scan
  -- (menu/) and dish-media (dish-media/) keys can never be stored here.
  CHECK (object_key ~ '^restaurant-photos/')
);
