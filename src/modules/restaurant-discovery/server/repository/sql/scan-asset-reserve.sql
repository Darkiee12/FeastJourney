INSERT INTO feastjourney.menu_scan_assets(session_id,object_key,page_number,byte_length)
VALUES(:session_id::uuid,:key::text,:page_number::int,:bytes::int) RETURNING id;
