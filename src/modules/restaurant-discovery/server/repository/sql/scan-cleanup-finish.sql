UPDATE feastjourney.menu_scan_sessions s SET status='deleted',current_revision=NULL WHERE s.status='deleting'
AND NOT EXISTS (SELECT 1 FROM feastjourney.menu_scan_assets a WHERE a.session_id=s.id AND a.status<>'deleted')
RETURNING id;
