SELECT p.id::text AS id, p.venue_id::text AS venue_id, p.menu_id::text AS menu_id,
  p.page_order AS page_order, p.object_key AS object_key,
  p.source_url AS source_url, p.source_name AS source_name, p.rights_holder AS rights_holder,
  p.license AS license, p.license_evidence AS license_evidence,
  p.attribution AS attribution, p.observed_at AS observed_at,
  p.original_width AS original_width, p.original_height AS original_height,
  p.format AS format, p.byte_size AS byte_size,
  p.checksum_sha256 AS checksum_sha256,
  p.uploaded_by AS uploaded_by, p.reviewed_by AS reviewed_by, p.status AS status,
  p.reviewed_at AS reviewed_at, p.published_at AS published_at,
  p.created_at AS created_at, p.updated_at AS updated_at
FROM feastjourney.restaurant_menu_pages AS p
WHERE p.venue_id = :venue_id::uuid
  AND p.status = 'published'
ORDER BY p.page_order ASC, p.id ASC
