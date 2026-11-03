UPDATE feastjourney.menu_scan_assets SET status='deleted',deleted_at=now() WHERE id=:id::uuid;
