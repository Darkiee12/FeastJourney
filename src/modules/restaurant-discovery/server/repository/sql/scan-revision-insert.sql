INSERT INTO feastjourney.menu_scan_revisions(session_id,revision,document,origin,model,actor_user_id)
VALUES(:session_id::uuid,:revision::int,:document::jsonb,:origin::text,:model::nullable(text),:user_id::nullable(text));
