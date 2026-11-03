SELECT id,object_key,page_number,media_type,byte_length,checksum FROM feastjourney.menu_scan_assets
WHERE session_id=:session_id::uuid AND status='ready' ORDER BY page_number;
