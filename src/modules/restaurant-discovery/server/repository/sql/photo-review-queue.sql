SELECT p.id::text AS id, p.venue_id::text AS venue_id, p.object_key AS object_key,
  p.attribution AS attribution, p.license AS license,
  p.status AS status, p.sort_order AS sort_order, p.alt_text AS alt_text,
  p.focal_x AS focal_x, p.focal_y AS focal_y,
  p.original_width AS original_width, p.original_height AS original_height,
  p.format AS format, p.byte_size AS byte_size,
  p.checksum_sha256 AS checksum_sha256, p.variant_version AS variant_version,
  p.uploaded_by AS uploaded_by, p.processing AS processing,
  p.reviewed_at AS reviewed_at, p.published_at AS published_at,
  p.source_url AS source_url,
  p.created_at AS created_at, p.updated_at AS updated_at
FROM feastjourney.restaurant_photos AS p
WHERE p.status = 'review'
ORDER BY p.created_at ASC, p.id ASC
LIMIT :limit::integer
