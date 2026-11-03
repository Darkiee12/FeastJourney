UPDATE feastjourney.menu_scan_sessions SET status='deleting',lease_token=NULL,lease_expires_at=NULL
WHERE id=:id::uuid;
