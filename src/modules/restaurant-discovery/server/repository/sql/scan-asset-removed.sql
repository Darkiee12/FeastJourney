UPDATE feastjourney.menu_scan_assets SET status='deleted',deleted_at=now()
WHERE id=:id::uuid AND session_id=:session_id::uuid AND status='deleting';
