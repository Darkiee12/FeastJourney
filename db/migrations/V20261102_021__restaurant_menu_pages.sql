-- Venue-scoped menu-page photography: photographs or scans of printed menus.
--
-- DATA-CLASS SEPARATION (privacy): private menu-scan uploads live under
-- menu/ keys (menu_scan_assets, reviewed only as extraction evidence) and
-- first-party venue photography lives under restaurant-photos/ keys. Menu
-- pages are a third data class: publishable only after an explicit
-- license + attribution review. Rows here must never reference scan assets,
-- scan keys, or dish_media rows, and menu-page delivery must never serve
-- scan bytes. Fact-extraction consent (menu-facts-v1) is not
-- menu-publication consent.
--
-- Lifecycle: draft -> review -> published. Withdrawal revokes delivery first
-- (the row leaves published status in the same transaction as its audit
-- record; objects stay, unreachable publicly). Delete moves the row to the
-- terminal removed state and deletes stored bytes best-effort afterwards,
-- so nothing public can resolve after the status flip while the metadata
-- tombstone keeps rights provenance for audit.
--
-- menu_id is optional and venue-scoping of the linked menu is enforced by
-- the application (menu-page-menu-check.sql): a page may only link a menu
-- whose venue matches the page venue.

CREATE TABLE feastjourney.restaurant_menu_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID NOT NULL REFERENCES feastjourney.restaurant_venues (id) ON DELETE CASCADE,
  menu_id UUID REFERENCES feastjourney.restaurant_menus (id) ON DELETE SET NULL,
  page_order INTEGER NOT NULL DEFAULT 0
    CHECK (page_order >= 0),
  object_key TEXT NOT NULL UNIQUE,
  source_url TEXT
    CHECK (source_url IS NULL OR source_url ~ '^https://'),
  source_name TEXT
    CHECK (source_name IS NULL OR length(btrim(source_name)) BETWEEN 1 AND 300),
  rights_holder TEXT
    CHECK (rights_holder IS NULL OR length(btrim(rights_holder)) BETWEEN 1 AND 300),
  license TEXT NOT NULL DEFAULT 'unknown',
  license_evidence TEXT,
  attribution TEXT
    CHECK (attribution IS NULL OR length(btrim(attribution)) BETWEEN 1 AND 500),
  observed_at DATE,
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
  uploaded_by TEXT,
  reviewed_by TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'review', 'published', 'removed')),
  reviewed_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Bytes live only under the menu-pages/ prefix. Private scan (menu/) and
  -- dish-media (dish-media/) keys can never be stored here.
  CHECK (object_key ~ '^menu-pages/')
);

-- Venue reads: one venue's pages in display order (admin + public).
CREATE INDEX restaurant_menu_pages_venue_idx
  ON feastjourney.restaurant_menu_pages (venue_id, status, page_order, id);

-- Publishable-set reads: published pages per venue in display order.
CREATE INDEX restaurant_menu_pages_publishable_idx
  ON feastjourney.restaurant_menu_pages (venue_id, status, page_order, id)
  WHERE status = 'published';

-- Admin review queue: pending review items oldest first.
CREATE INDEX restaurant_menu_pages_review_queue_idx
  ON feastjourney.restaurant_menu_pages (status, created_at, id)
  WHERE status = 'review';
