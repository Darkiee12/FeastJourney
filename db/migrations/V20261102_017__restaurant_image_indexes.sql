-- Indexes for venue-scoped restaurant photography (table in V20261101_015).
--
-- Split into its own migration so index work (concurrent builds, tuning)
-- never blocks the table creation: 015 stays a pure DDL step.

-- Card/gallery reads: one venue's photos in display order.
CREATE INDEX restaurant_photos_venue_idx
  ON feastjourney.restaurant_photos (venue_id, status, sort_order, id);

-- Publishable-set reads: published + ready derivatives per venue.
CREATE INDEX restaurant_photos_publishable_idx
  ON feastjourney.restaurant_photos (venue_id, status, processing, sort_order, id);

-- Admin review queue: pending review items oldest first.
CREATE INDEX restaurant_photos_review_queue_idx
  ON feastjourney.restaurant_photos (status, created_at, id)
  WHERE status = 'review';
