INSERT INTO feastjourney.menu_scan_sessions(owner_user_id,guest_hash,venue_id,target_language,expires_at)
VALUES(:user_id::nullable(text),:guest_hash::nullable(text),:venue_id::nullable(uuid),:language::text,now()+INTERVAL '24 hours')
RETURNING id,expires_at;
