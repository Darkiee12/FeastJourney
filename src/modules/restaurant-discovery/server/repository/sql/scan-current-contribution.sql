SELECT id,status,submitted_revision AS revision FROM feastjourney.menu_scan_contributions
WHERE session_id=:session_id::uuid ORDER BY submitted_revision DESC LIMIT 1;
