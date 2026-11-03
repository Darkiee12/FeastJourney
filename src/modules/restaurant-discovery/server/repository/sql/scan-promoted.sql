SELECT id,promoted_menu_id FROM feastjourney.menu_scan_contributions
WHERE session_id=:session_id::uuid AND status='approved' LIMIT 1;
