INSERT INTO feastjourney.menu_scan_contributions(session_id,revision,submitted_revision,consent_terms,requested_venue_id,retention_until)
VALUES(:session_id::uuid,:revision::int,:submitted_revision::int,'menu-facts-v1',:venue_id::nullable(uuid),now()+INTERVAL '30 days')
ON CONFLICT(session_id,submitted_revision) DO UPDATE SET id=feastjourney.menu_scan_contributions.id
RETURNING id,status;
