-- Curator verdict on one machine suggestion. Only 'machine' rows may
-- transition; approving or rejecting an already-decided row is a no-op so
-- repeated decisions converge. Curator-authored translations on the
-- item/variant rows stay the primary approved tier regardless.
UPDATE feastjourney.restaurant_menu_localizations
SET status=:status::text,reviewed_by=:actor::text,reviewed_at=now()
WHERE id=:id::uuid AND status='machine'
RETURNING id,status;
