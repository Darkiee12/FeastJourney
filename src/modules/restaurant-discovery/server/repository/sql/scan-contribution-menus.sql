SELECT menu_id,asset_id,is_primary FROM feastjourney.menu_scan_contribution_menus
WHERE contribution_id=:id::uuid ORDER BY is_primary DESC,menu_id;
