WITH input AS (SELECT :venue::text AS venue,:status::text AS status,
 :from::nullable(timestamptz) AS from_date,:to::nullable(timestamptz) AS to_date)
SELECT c.id,c.session_id,c.submitted_revision AS revision,c.requested_venue_id,v.name AS venue_name,
 c.consented_at,c.status,c.reviewed_by,c.reviewed_at,c.review_notes,c.retention_until,
 count(*) OVER()::int AS total
FROM feastjourney.menu_scan_contributions c LEFT JOIN feastjourney.restaurant_venues v ON v.id=c.requested_venue_id
JOIN feastjourney.menu_scan_sessions s ON s.id=c.session_id CROSS JOIN input f
WHERE (f.venue='' OR strpos(lower(COALESCE(v.name,'')||' '||COALESCE(v.area,'')),lower(f.venue))>0)
 AND (f.status='all' OR c.status=f.status)
 AND (f.from_date IS NULL OR c.consented_at>=f.from_date)
 AND (f.to_date IS NULL OR c.consented_at<=f.to_date)
ORDER BY CASE WHEN c.status='pending' THEN 0 ELSE 1 END,c.consented_at,c.id
LIMIT :limit::int OFFSET :offset::int;
