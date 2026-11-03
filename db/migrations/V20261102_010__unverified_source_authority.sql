-- Forward sequence for feat/restaurant-discovery-v2.
-- Original PR#6 file: V20261029_002__unverified_source_authority.sql (renumbered after V20261031_001, content unchanged).

-- Legacy restaurant_verified is a historical claim, not independent authority.
-- No current operation can independently verify restaurant ownership.
CREATE OR REPLACE VIEW feastjourney.restaurant_selected_prices AS
SELECT DISTINCT ON(p.variant_id,p.sales_channel)
 p.id AS observation_id,p.variant_id,p.venue_id,p.source_id,p.amount,p.currency,p.price_kind,
 p.sales_channel,p.tax_treatment,p.observed_at,p.review_after,s.category AS source_category,
 CASE WHEN s.category='receipt' THEN NULL ELSE s.source_url END AS source_url,
 (p.review_after>=now() AND s.valid_until>=now()) AS current_enough
FROM feastjourney.restaurant_price_observations p
JOIN feastjourney.restaurant_sources s ON (s.id,s.venue_id)=(p.source_id,p.venue_id)
WHERE p.review_status='approved' AND s.eligible AND p.observed_at<=now() AND s.observed_at<=now()
ORDER BY p.variant_id,p.sales_channel,
 CASE WHEN p.price_kind='listed' THEN 0 ELSE 1 END,
 CASE WHEN p.review_after>=now() AND s.valid_until>=now() THEN 0 ELSE 1 END,
 p.observed_at DESC,p.id;
