SELECT a.id,a.object_key FROM feastjourney.menu_scan_assets a JOIN feastjourney.menu_scan_sessions s ON s.id=a.session_id
WHERE a.status<>'deleted' AND a.next_delete_attempt_at<=now()
AND ((s.status='deleting' AND a.created_at<now()-INTERVAL '2 minutes')
 OR (a.status='uploading' AND a.created_at<now()-INTERVAL '5 minutes')
 OR (a.status='deleting' AND a.created_at<now()-INTERVAL '2 minutes'))
ORDER BY a.created_at,a.id LIMIT 100;
