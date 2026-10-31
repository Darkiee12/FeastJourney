INSERT INTO feastjourney.restaurant_photos (
  venue_id, object_key, attribution, license, status, sort_order,
  alt_text, focal_x, focal_y,
  original_width, original_height, format, byte_size, checksum_sha256,
  variant_version, uploaded_by, processing, source_url
)
VALUES (
  :venue_id::uuid, :object_key::text, :attribution::nullable(text), :license::text,
  'draft'::text, :sort_order::integer,
  :alt_text::nullable(text), :focal_x::nullable(double precision), :focal_y::nullable(double precision),
  :original_width::integer, :original_height::integer, :format::text,
  :byte_size::bigint, :checksum_sha256::text,
  1, :uploaded_by::text, :processing::text, :source_url::nullable(text)
)
RETURNING id::text AS id, venue_id::text AS venue_id, object_key,
  attribution, license, status, sort_order, alt_text,
  focal_x, focal_y,
  original_width, original_height, format, byte_size,
  checksum_sha256, variant_version, uploaded_by, processing,
  reviewed_at, published_at, source_url,
  created_at, updated_at
