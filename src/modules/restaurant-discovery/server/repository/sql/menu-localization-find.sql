-- Single-row lookup before generation: an approved or rejected row for
-- this entity+target blocks the provider call (curator verdicts are never
-- overwritten); a machine row with a matching source hash makes it a
-- cache hit with zero provider cost.
WITH input AS (SELECT :item::nullable(uuid) AS item,:variant::nullable(uuid) AS variant,:target::text AS target)
SELECT l.id,l.item_id,l.variant_id,l.target,l.source_hash,l.display_name,l.description,
 l.explanation,l.status,l.provider,l.model,l.prompt_version,l.schema_version,l.created_at
FROM feastjourney.restaurant_menu_localizations l CROSS JOIN input f
WHERE l.target=f.target
 AND ((f.item IS NOT NULL AND l.item_id=f.item AND l.variant_id IS NULL)
  OR (f.variant IS NOT NULL AND l.variant_id=f.variant AND l.item_id IS NULL));
