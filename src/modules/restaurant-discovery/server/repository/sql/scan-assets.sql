SELECT id,page_number,status FROM feastjourney.menu_scan_assets
WHERE session_id=:session_id::uuid AND status IN ('uploading','ready') ORDER BY page_number;
