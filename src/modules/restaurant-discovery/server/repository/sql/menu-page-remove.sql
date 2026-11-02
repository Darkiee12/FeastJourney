UPDATE feastjourney.restaurant_menu_pages
SET status = 'removed',
  published_at = NULL,
  updated_at = now()
WHERE id = :id::uuid
  AND status <> 'removed'
RETURNING id::text AS id, venue_id::text AS venue_id, menu_id::text AS menu_id,
  page_order, object_key,
  source_url, source_name, rights_holder, license, license_evidence,
  attribution, observed_at,
  original_width, original_height, format, byte_size, checksum_sha256,
  uploaded_by, reviewed_by, status,
  reviewed_at, published_at,
  created_at, updated_at
