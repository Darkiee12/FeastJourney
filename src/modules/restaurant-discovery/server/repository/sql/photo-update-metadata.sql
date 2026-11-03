UPDATE feastjourney.restaurant_photos
SET alt_text = :alt_text::nullable(text),
  attribution = :attribution::nullable(text),
  license = :license::text,
  focal_x = :focal_x::nullable(double precision),
  focal_y = :focal_y::nullable(double precision),
  source_url = :source_url::nullable(text),
  updated_at = now()
WHERE id = :id::uuid
RETURNING id::text AS id, venue_id::text AS venue_id, object_key,
  attribution, license, status, sort_order, alt_text,
  focal_x, focal_y,
  original_width, original_height, format, byte_size,
  checksum_sha256, variant_version, uploaded_by, processing,
  reviewed_at, published_at, source_url,
  created_at, updated_at
