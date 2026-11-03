UPDATE feastjourney.menu_scan_sessions s
SET expires_at=GREATEST(s.created_at+INTERVAL '24 hours',
 (SELECT max(c.retention_until) FROM feastjourney.menu_scan_contributions c WHERE c.session_id=s.id))
WHERE s.id=:id::uuid;
