UPDATE feastjourney.menu_scan_assets SET status='deleting'
WHERE id=:id::uuid AND session_id=:session_id::uuid AND status IN ('uploading','ready');
