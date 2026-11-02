SELECT r.document,r.revision,r.origin,r.model FROM feastjourney.menu_scan_revisions r
WHERE r.session_id=:session_id::uuid AND r.revision=:revision::int;
