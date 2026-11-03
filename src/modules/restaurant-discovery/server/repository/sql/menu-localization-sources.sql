-- Consent-guarded generation source: published reviewed rows only.
-- Private scan documents (menu_scan_*) and unpublished drafts (status <>
-- 'published') are unreachable from this query by construction: generation
-- inputs always come from here, so private scan material can never be sent
-- to a provider without consent and publication rights.
SELECT m.id AS menu_id,m.source_language,i.id AS item_id,i.name AS item_name,
 i.description AS item_description,i.translation_language AS item_translation_language,
 v.id AS variant_id,v.name AS variant_name,
 v.translation_language AS variant_translation_language
FROM feastjourney.restaurant_menu_items i
JOIN feastjourney.restaurant_menus m ON(m.id,m.venue_id)=(i.menu_id,i.venue_id)
JOIN feastjourney.restaurant_venues r ON r.id=i.venue_id
JOIN feastjourney.restaurant_menu_item_variants v ON(v.menu_item_id,v.venue_id)=(i.id,i.venue_id)
WHERE i.venue_id=:venue::uuid AND r.status='published' AND m.status='published'
 AND i.status='published' AND v.status='published'
ORDER BY i.name,i.id,v.name,v.id;
