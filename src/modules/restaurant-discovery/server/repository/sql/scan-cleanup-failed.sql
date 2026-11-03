UPDATE feastjourney.menu_scan_assets SET delete_attempts=delete_attempts+1,next_delete_attempt_at=now()+INTERVAL '15 minutes' WHERE id=:id::uuid;
