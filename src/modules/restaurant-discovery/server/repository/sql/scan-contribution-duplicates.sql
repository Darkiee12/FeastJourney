SELECT a.id AS asset_id,COUNT(DISTINCT other.session_id)::integer AS contribution_count
FROM feastjourney.menu_scan_assets a
LEFT JOIN feastjourney.menu_scan_assets other ON other.checksum=a.checksum
 AND other.session_id<>a.session_id AND other.status='ready'
 AND EXISTS(
  SELECT 1 FROM feastjourney.menu_scan_contributions c
  JOIN feastjourney.menu_scan_sessions s ON s.id=c.session_id
  WHERE c.session_id=other.session_id AND c.retention_until>now()
   AND s.status NOT IN ('deleting','deleted')
 )
WHERE a.session_id=:session_id::uuid AND a.status='ready'
GROUP BY a.id ORDER BY a.page_number;
