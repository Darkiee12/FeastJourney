UPDATE feastjourney.menu_scan_sessions SET status='processing',lease_token=:token::uuid,
lease_expires_at=now()+INTERVAL '90 seconds',attempts=attempts+1
WHERE id=:id::uuid AND current_revision IS NULL AND attempts<5
AND (status IN ('ready','failed') OR (status='processing' AND lease_expires_at<now()))
AND (SELECT count(*) FROM feastjourney.menu_scan_sessions WHERE status='processing' AND lease_expires_at>now())<4
RETURNING id;
