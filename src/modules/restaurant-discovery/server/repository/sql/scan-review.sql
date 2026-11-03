UPDATE feastjourney.menu_scan_contributions SET status=:status::text,reviewed_by=:actor::text,reviewed_at=now(),
review_notes=:notes::text,promoted_menu_id=:menu_id::nullable(uuid)
WHERE id=:id::uuid AND status='pending' RETURNING id,status,promoted_menu_id;
