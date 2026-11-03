UPDATE feastjourney.menu_scan_assets SET status='ready',media_type=:media_type::text,
byte_length=:bytes::int,width=:width::int,height=:height::int,checksum=:checksum::text
WHERE id=:id::uuid AND status='uploading' RETURNING id;
