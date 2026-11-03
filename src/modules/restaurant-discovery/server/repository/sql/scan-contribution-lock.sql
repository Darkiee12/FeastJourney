SELECT c.id,c.session_id,c.submitted_revision AS revision,c.requested_venue_id,c.status,c.promoted_menu_id,
 c.retention_until,
 c.consented_at,c.consent_terms,c.reviewed_by,c.reviewed_at,c.review_notes,
 s.status AS scan_status,s.expires_at
FROM feastjourney.menu_scan_contributions c JOIN feastjourney.menu_scan_sessions s ON s.id=c.session_id
WHERE c.id=:id::uuid AND c.retention_until>now() AND s.status NOT IN ('deleting','deleted')
FOR UPDATE OF c,s;
