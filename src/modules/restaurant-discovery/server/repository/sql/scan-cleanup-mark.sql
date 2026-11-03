UPDATE feastjourney.menu_scan_sessions SET status='deleting',lease_token=NULL,lease_expires_at=NULL
WHERE id IN (SELECT id FROM feastjourney.menu_scan_sessions WHERE expires_at<=now() AND status NOT IN ('deleting','deleted')
ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING id;
