-- Public read: every servable localization row for one venue.
-- Rejected rows are audit-only and never served; staleness against edited
-- source text is resolved in the presentation layer by source-hash match.
SELECT l.id,l.item_id,l.variant_id,l.target,l.source_hash,l.display_name,l.description,
 l.explanation,l.status,l.provider,l.model,l.prompt_version,l.schema_version,l.created_at
FROM feastjourney.restaurant_menu_localizations l
WHERE l.venue_id=:venue::uuid AND l.status<>'rejected'
ORDER BY l.created_at;
