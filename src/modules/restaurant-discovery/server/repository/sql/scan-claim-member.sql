UPDATE feastjourney.menu_scan_sessions SET owner_user_id=:user_id::text,guest_hash=NULL
WHERE id=:id::uuid AND owner_user_id IS NULL AND guest_hash=:guest_hash::text AND expires_at>now()
AND status NOT IN ('deleting','deleted') RETURNING id;
