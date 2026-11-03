-- Local demo seed for the Restaurant Discovery map-first verification.
-- Synthetic venues only (names prefixed "MapFirst ... Demo").
-- Never apply to production. Remove with scripts/unseed-mapfirst-demo.ts
-- or the DELETE statements at the bottom of that script.
--
-- Dish link uses the existing published dish id 2 (pho-bo) as reviewed
-- serving evidence for two venues. The third venue has no dish evidence,
-- so dish-filtered search and general browsing stay distinguishable.

INSERT INTO feastjourney."user"(id, name, email, "emailVerified")
VALUES ('mapfirst-demo-curator', 'MapFirst Demo Curator', 'mapfirst-demo@example.com', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO feastjourney.restaurant_businesses(name)
VALUES ('MapFirst Demo Group')
ON CONFLICT DO NOTHING;

-- Published venues (Ho Chi Minh City, District 1).
INSERT INTO feastjourney.restaurant_venues(business_id, name, address, area, country_code, location, status)
SELECT b.id, v.name, v.address, v.area, 'VN',
  public.ST_SetSRID(public.ST_MakePoint(v.lon, v.lat), 4326)::public.geography,
  'published'
FROM feastjourney.restaurant_businesses b
CROSS JOIN (VALUES
  ('MapFirst Pho Demo 1', '123 Demo Street, District 1', 'Ho Chi Minh City', 106.7009, 10.7769),
  ('MapFirst Pho Demo 2', '456 Demo Street, District 1', 'Ho Chi Minh City', 106.7030, 10.7820),
  ('MapFirst General Demo', '789 Demo Street, District 1', 'Ho Chi Minh City', 106.6950, 10.7700)
) AS v(name, address, area, lon, lat)
WHERE b.name = 'MapFirst Demo Group'
ON CONFLICT DO NOTHING;

-- Search names for the demo venues.
INSERT INTO feastjourney.restaurant_venue_names(venue_id, language_tag, name)
SELECT v.id, 'und', v.name
FROM feastjourney.restaurant_venues v
WHERE v.name LIKE 'MapFirst % Demo%'
ON CONFLICT DO NOTHING;

-- One published menu per demo venue.
INSERT INTO feastjourney.restaurant_menus(venue_id, name, status)
SELECT v.id, 'Demo menu', 'published'
FROM feastjourney.restaurant_venues v
WHERE v.name LIKE 'MapFirst % Demo%'
ON CONFLICT DO NOTHING;

-- Menu items: pho items for the first two venues, a non-dish item for the general venue.
INSERT INTO feastjourney.restaurant_menu_items(venue_id, menu_id, name, description, status)
SELECT m.venue_id, m.id,
  CASE WHEN v.name = 'MapFirst General Demo' THEN 'Com tam (demo)' ELSE 'Pho bo (demo)' END,
  'Synthetic map-first demo item; not a real menu.',
  'published'
FROM feastjourney.restaurant_menus m
JOIN feastjourney.restaurant_venues v ON v.id = m.venue_id
WHERE v.name LIKE 'MapFirst % Demo%'
ON CONFLICT DO NOTHING;

-- One regular-bowl variant per demo item.
INSERT INTO feastjourney.restaurant_menu_item_variants(venue_id, menu_item_id, name, comparison_key)
SELECT i.venue_id, i.id, 'Regular bowl', 'regular-bowl'
FROM feastjourney.restaurant_menu_items i
JOIN feastjourney.restaurant_venues v ON v.id = i.venue_id
WHERE v.name LIKE 'MapFirst % Demo%'
ON CONFLICT DO NOTHING;

-- Provider sources for the two pho venues (general venue stays source-free).
INSERT INTO feastjourney.restaurant_sources(venue_id, category, source_url, deduplication_key, restaurant_verified, observed_at, valid_until, created_by)
SELECT v.id, 'official_menu', 'https://example.com/mapfirst-demo',
  'mapfirst-demo:' || v.name, false,
  now() - INTERVAL '1 day', now() + INTERVAL '29 days', 'mapfirst-demo-curator'
FROM feastjourney.restaurant_venues v
WHERE v.name IN ('MapFirst Pho Demo 1', 'MapFirst Pho Demo 2')
ON CONFLICT DO NOTHING;

-- Reviewed serving evidence: dish id 2 (pho-bo), exact match, approved.
INSERT INTO feastjourney.restaurant_serving_evidence(venue_id, menu_item_id, dish_id, source_id, match_kind, review_status, observed_at, review_after, reviewed_by, reviewed_at)
SELECT s.venue_id, i.id, 2, s.id, 'exact', 'approved',
  now() - INTERVAL '1 day', now() + INTERVAL '60 days',
  'mapfirst-demo-curator', now()
FROM feastjourney.restaurant_sources s
JOIN feastjourney.restaurant_menu_items i ON i.venue_id = s.venue_id
JOIN feastjourney.restaurant_venues v ON v.id = s.venue_id
WHERE s.deduplication_key LIKE 'mapfirst-demo:%'
  AND i.name = 'Pho bo (demo)'
ON CONFLICT DO NOTHING;

-- Listed VND prices for the two pho variants.
INSERT INTO feastjourney.restaurant_price_observations(venue_id, variant_id, source_id, source_line_key, price_kind, amount, currency, sales_channel, tax_treatment, observed_at, review_after, review_status, reviewed_by, reviewed_at)
SELECT s.venue_id, vr.id, s.id, 'regular-1', 'listed',
  CASE WHEN v.name = 'MapFirst Pho Demo 1' THEN 55000 ELSE 65000 END,
  'VND', 'dine_in', 'included',
  now() - INTERVAL '1 day', now() + INTERVAL '60 days',
  'approved', 'mapfirst-demo-curator', now()
FROM feastjourney.restaurant_sources s
JOIN feastjourney.restaurant_menu_item_variants vr ON vr.venue_id = s.venue_id
JOIN feastjourney.restaurant_venues v ON v.id = s.venue_id
WHERE s.deduplication_key LIKE 'mapfirst-demo:%'
  AND vr.comparison_key = 'regular-bowl'
ON CONFLICT DO NOTHING;
