INSERT INTO feastjourney.menu_scan_contribution_menus(contribution_id,menu_id,asset_id,evidence_key,is_primary,supporting_asset_ids)
VALUES(:contribution_id::uuid,:menu_id::uuid,:asset_id::uuid,:evidence_key::text,:is_primary::boolean,:supporting_asset_ids::uuid[]);
