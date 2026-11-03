SELECT count(*)::int AS count,COALESCE(sum(byte_length),0)::int AS bytes
FROM feastjourney.menu_scan_assets
WHERE session_id=:session_id::uuid AND status IN ('uploading','ready');
