UPDATE feastjourney.restaurant_menu_pages
SET menu_id = :menu_id::nullable(uuid),
  source_url = :source_url::nullable(text),
  source_name = :source_name::nullable(text),
  rights_holder = :rights_holder::nullable(text),
  license = :license::text,
  license_evidence = :license_evidence::nullable(text),
  attribution = :attribution::nullable(text),
  observed_at = :observed_at::nullable(date),
  updated_at = now()
WHERE id = :id::uuid
  AND status IN ('draft', 'review')
RETURNING id::text AS id, venue_id::text AS venue_id, menu_id::text AS menu_id,
  page_order, object_key,
  source_url, source_name, rights_holder, license, license_evidence,
  attribution, observed_at,
  original_width, original_height, format, byte_size, checksum_sha256,
  uploaded_by, reviewed_by, status,
  reviewed_at, published_at,
  created_at, updated_at
