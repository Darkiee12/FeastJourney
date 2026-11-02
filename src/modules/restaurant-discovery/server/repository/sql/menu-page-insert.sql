INSERT INTO feastjourney.restaurant_menu_pages (
  id, venue_id, menu_id, page_order, object_key,
  source_url, source_name, rights_holder, license, license_evidence,
  attribution, observed_at,
  original_width, original_height, format, byte_size, checksum_sha256,
  uploaded_by, status
)
VALUES (
  :id::uuid, :venue_id::uuid, :menu_id::nullable(uuid), :page_order::integer, :object_key::text,
  :source_url::nullable(text), :source_name::nullable(text), :rights_holder::nullable(text),
  :license::text, :license_evidence::nullable(text),
  :attribution::nullable(text), :observed_at::nullable(date),
  :original_width::integer, :original_height::integer, :format::text,
  :byte_size::bigint, :checksum_sha256::text,
  :uploaded_by::text, 'draft'
)
RETURNING id::text AS id, venue_id::text AS venue_id, menu_id::text AS menu_id,
  page_order, object_key,
  source_url, source_name, rights_holder, license, license_evidence,
  attribution, observed_at,
  original_width, original_height, format, byte_size, checksum_sha256,
  uploaded_by, reviewed_by, status,
  reviewed_at, published_at,
  created_at, updated_at
