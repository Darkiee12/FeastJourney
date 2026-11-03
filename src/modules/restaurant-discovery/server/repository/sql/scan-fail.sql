UPDATE feastjourney.menu_scan_sessions SET status='failed',lease_token=NULL,lease_expires_at=NULL
WHERE id=:id::uuid AND lease_token=:token::uuid AND status='processing';
