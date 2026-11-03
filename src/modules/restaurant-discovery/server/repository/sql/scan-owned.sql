WITH access AS (SELECT :id::uuid AS id,:user_id::nullable(text) AS user_id,:guest_hash::text AS guest_hash)
SELECT s.id,s.status,s.current_revision,s.target_language,s.venue_id,v.name AS venue_name,s.expires_at
FROM feastjourney.menu_scan_sessions s CROSS JOIN access a
LEFT JOIN feastjourney.restaurant_venues v ON v.id=s.venue_id
WHERE s.id=a.id AND s.expires_at>now() AND s.status NOT IN ('deleting','deleted')
AND ((a.user_id IS NOT NULL AND s.owner_user_id=a.user_id)
 OR (a.user_id IS NULL AND s.owner_user_id IS NULL AND s.guest_hash=a.guest_hash))
LIMIT 1 FOR UPDATE OF s;
