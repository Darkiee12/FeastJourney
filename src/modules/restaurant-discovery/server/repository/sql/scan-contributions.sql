SELECT c.id,c.session_id,c.submitted_revision AS revision,c.requested_venue_id,v.name AS venue_name,c.consented_at,c.status
FROM feastjourney.menu_scan_contributions c LEFT JOIN feastjourney.restaurant_venues v ON v.id=c.requested_venue_id
JOIN feastjourney.menu_scan_sessions s ON s.id=c.session_id
WHERE c.status='pending' AND c.retention_until>now() AND s.status NOT IN ('deleting','deleted')
ORDER BY c.consented_at,c.id LIMIT 50;
