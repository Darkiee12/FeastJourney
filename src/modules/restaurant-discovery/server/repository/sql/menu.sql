SELECT m.id AS menu_id,m.name AS menu_name,m.source_language,i.id AS item_id,i.name AS item_name,i.description,
 i.translation_language,i.translated_name,i.translated_description,i.explanatory_summary,
 v.id AS variant_id,v.name AS variant_name,v.comparison_key,
 v.translation_language AS variant_translation_language,v.translated_label AS variant_translated_label,
 p.observation_id,p.amount,p.currency,p.price_kind,p.sales_channel,p.tax_treatment,
 COALESCE(p.observed_at,item_source.observed_at) AS observed_at,
 COALESCE(p.current_enough,item_source.eligible AND item_source.valid_until>now()) AS current_enough,
 COALESCE(p.source_category,item_source.category) AS source_category,
 CASE WHEN p.observation_id IS NULL THEN item_source.source_url ELSE p.source_url END AS source_url,
 price_text.raw_text AS raw_price_text,
 e.dish_id::text AS dish_id,e.match_kind
FROM feastjourney.restaurant_menu_items i
JOIN feastjourney.restaurant_menus m ON(m.id,m.venue_id)=(i.menu_id,i.venue_id)
JOIN feastjourney.restaurant_venues r ON r.id=i.venue_id
LEFT JOIN feastjourney.restaurant_sources item_source ON(item_source.id,item_source.venue_id)=(i.source_id,i.venue_id)
JOIN feastjourney.restaurant_menu_item_variants v ON(v.menu_item_id,v.venue_id)=(i.id,i.venue_id)
LEFT JOIN feastjourney.restaurant_selected_prices p ON p.variant_id=v.id AND p.sales_channel=:channel::text
LEFT JOIN feastjourney.restaurant_price_observations price_text ON price_text.id=p.observation_id
LEFT JOIN LATERAL(SELECT ev.dish_id,ev.match_kind FROM feastjourney.restaurant_eligible_evidence ev
 WHERE ev.menu_item_id=i.id AND ev.dish_id = ANY(:published_dish_ids::bigint[])
 ORDER BY ev.evidence_tier,ev.observed_at DESC,ev.id LIMIT 1) e ON true
WHERE v.status='published' AND i.venue_id=:id::uuid AND r.status='published' AND m.status='published' AND i.status='published'
ORDER BY m.name,m.id,i.name,i.id,v.name,v.id;
