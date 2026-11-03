DELETE FROM feastjourney.menu_scan_revisions r USING feastjourney.menu_scan_sessions s
WHERE r.session_id=s.id AND s.status='deleted';
