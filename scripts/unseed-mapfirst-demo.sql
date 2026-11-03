-- Removes the synthetic map-first demo seed (scripts/seed-mapfirst-demo.sql).
-- Local verification only; never run against production.

DELETE FROM feastjourney.restaurant_receipt_lines
WHERE observation_id IN (
  SELECT id FROM feastjourney.restaurant_price_observations
  WHERE venue_id IN (
    SELECT id FROM feastjourney.restaurant_venues WHERE name LIKE 'MapFirst % Demo%'
  )
);

DELETE FROM feastjourney.restaurant_price_observations
WHERE venue_id IN (
  SELECT id FROM feastjourney.restaurant_venues WHERE name LIKE 'MapFirst % Demo%'
);

DELETE FROM feastjourney.restaurant_serving_evidence
WHERE venue_id IN (
  SELECT id FROM feastjourney.restaurant_venues WHERE name LIKE 'MapFirst % Demo%'
);

DELETE FROM feastjourney.restaurant_sources
WHERE venue_id IN (
  SELECT id FROM feastjourney.restaurant_venues WHERE name LIKE 'MapFirst % Demo%'
);

DELETE FROM feastjourney.restaurant_menu_item_variants
WHERE venue_id IN (
  SELECT id FROM feastjourney.restaurant_venues WHERE name LIKE 'MapFirst % Demo%'
);

DELETE FROM feastjourney.restaurant_menu_items
WHERE venue_id IN (
  SELECT id FROM feastjourney.restaurant_venues WHERE name LIKE 'MapFirst % Demo%'
);

DELETE FROM feastjourney.restaurant_menus
WHERE venue_id IN (
  SELECT id FROM feastjourney.restaurant_venues WHERE name LIKE 'MapFirst % Demo%'
);

DELETE FROM feastjourney.restaurant_venue_cuisines
WHERE venue_id IN (
  SELECT id FROM feastjourney.restaurant_venues WHERE name LIKE 'MapFirst % Demo%'
);

DELETE FROM feastjourney.restaurant_venue_names
WHERE venue_id IN (
  SELECT id FROM feastjourney.restaurant_venues WHERE name LIKE 'MapFirst % Demo%'
);

DELETE FROM feastjourney.restaurant_venues WHERE name LIKE 'MapFirst % Demo%';

DELETE FROM feastjourney.restaurant_businesses
WHERE name = 'MapFirst Demo Group'
  AND NOT EXISTS (
    SELECT 1 FROM feastjourney.restaurant_venues v
    WHERE v.business_id = feastjourney.restaurant_businesses.id
  );

DELETE FROM feastjourney."user" WHERE id = 'mapfirst-demo-curator';
